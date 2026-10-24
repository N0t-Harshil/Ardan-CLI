from typing import Any, Dict, List, Optional

from ardan.config.credentials import credentials_manager
from ardan.providers.base import ArdanProviderError, BaseProvider
from ardan.providers.anthropic import AnthropicProvider
from ardan.providers.google import GoogleProvider
from ardan.providers.groq import GroqProvider
from ardan.providers.mistral import MistralProvider
from ardan.providers.ollama import OllamaProvider
from ardan.providers.openai import OpenAIProvider
from ardan.providers.openrouter import OpenRouterProvider

PROVIDERS: Dict[str, type] = {
    "ollama": OllamaProvider,
    "anthropic": AnthropicProvider,
    "google": GoogleProvider,
    "openai": OpenAIProvider,
    "mistral": MistralProvider,
    "groq": GroqProvider,
    "openrouter": OpenRouterProvider,
}

ALIASES = {"claude": "anthropic", "gemini": "google", "gpt": "openai", "fast": "groq"}


def resolve_provider_name(name: str) -> str:
    name = (name or "").lower().strip()
    return ALIASES.get(name, name)


def get_provider_instance(name: str, settings_config: Any) -> BaseProvider:
    """Build a provider instance, merging config.yaml provider settings.

    - ``model`` overrides the class default
    - ``base_url`` overrides the class API base
    - openrouter's ``site_url`` / ``app_name`` flow through as extra headers
    - ollama's ``num_ctx`` sets the local context size
    """
    name = resolve_provider_name(name)
    if name not in PROVIDERS:
        raise ValueError(
            f"Unknown provider: '{name}'. Available: {', '.join(sorted(PROVIDERS))}"
        )

    config_dict = settings_config if isinstance(settings_config, dict) else {}
    provider_cfg = config_dict.get("providers", {}).get(name, {}) or {}
    if not isinstance(provider_cfg, dict):
        provider_cfg = {}

    cls = PROVIDERS[name]
    api_key = credentials_manager.get(name)
    kwargs: Dict[str, Any] = {
        "api_key": api_key,
        "base_url": provider_cfg.get("base_url"),
        "default_model": provider_cfg.get("model"),
    }
    if name == "openrouter":
        kwargs["site_url"] = provider_cfg.get("site_url", "https://github.com/ardan-cli")
        kwargs["app_name"] = provider_cfg.get("app_name", "Ardan")
    if name == "ollama":
        try:
            kwargs["num_ctx"] = int(provider_cfg.get("num_ctx", 8192))
        except (TypeError, ValueError):
            kwargs["num_ctx"] = 8192

    return cls(**kwargs)


def detect_active_provider(cli_flag: Optional[str], env_var: Optional[str], config_val: str) -> str:
    if cli_flag:
        return resolve_provider_name(cli_flag)
    if env_var:
        return resolve_provider_name(env_var)
    return resolve_provider_name(config_val or "ollama")


async def failover_generate(
    messages: List[Any],
    config: Any,
    primary_provider: BaseProvider,
    settings: Any,
):
    """Stream the primary provider; if it fails before producing anything,
    fall through the failover chain.

    Once a stream has started, we never restart on another provider (that
    would duplicate half-finished output).
    """
    config_dict = settings if isinstance(settings, dict) else {}
    agent_cfg = config_dict.get("agent", {}) or {}

    chain: List[str] = []
    if agent_cfg.get("auto_failover", True):
        configured = agent_cfg.get("failover_chain", ["ollama"])
        if isinstance(configured, list):
            chain = [resolve_provider_name(p) for p in configured]
    chain = [name for name in dict.fromkeys([primary_provider.name] + chain) if name]

    last_error: Optional[Exception] = None
    emitted = False

    for name in chain:
        try:
            provider = primary_provider if name == primary_provider.name else None
            if provider is None:
                provider = get_provider_instance(name, config_dict)
            async for chunk in provider.generate(messages, config):
                emitted = True
                yield chunk
            return
        except Exception as error:
            if emitted:
                raise  # mid-stream failure: restart elsewhere = corrupted output
            last_error = error
            continue

    if last_error:
        raise last_error
