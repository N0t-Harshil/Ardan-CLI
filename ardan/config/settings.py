import os
from pathlib import Path

import yaml
from typing import Any, Dict, List, Optional


class Settings:
    """Loads config.yaml from (in order of priority):

    1. ``ARDAN_CONFIG`` env var
    2. ``./config.yaml`` relative to the current directory
    3. the package root (works for editable/dev checkouts)
    Falls back to sane defaults when no file is found.
    """

    def __init__(self, config_path: Optional[str] = None) -> None:
        if config_path is None:
            config_path = os.getenv("ARDAN_CONFIG")
        if config_path is None and os.path.isfile("config.yaml"):
            config_path = "config.yaml"
        if config_path is None:
            candidate = Path(__file__).parent.parent.parent / "config.yaml"
            if candidate.is_file():
                config_path = str(candidate)
        self.config_path: Optional[str] = config_path
        self.config: Dict[str, Any] = self._load_config()
        self._override_from_env()

    def _load_config(self) -> Dict[str, Any]:
        if self.config_path and os.path.isfile(self.config_path):
            try:
                with open(self.config_path, "r", encoding="utf-8") as handle:
                    return yaml.safe_load(handle) or {}
            except (OSError, yaml.YAMLError) as error:
                print(f"[ardan] Warning: failed to load {self.config_path}: {error}")
        return {}

    def _override_from_env(self) -> None:
        # Provider-level overrides (legacy keys kept for compatibility).
        if "ARDAN_OLLAMA_BASE_URL" in os.environ:
            self.set_provider_config("ollama", base_url=os.getenv("ARDAN_OLLAMA_BASE_URL"))
        if "ARDAN_MODEL" in os.environ:
            self.set_provider_config("ollama", model=os.getenv("ARDAN_MODEL"))

        # Agent-level overrides.
        if "ARDAN_WORKSPACE" in os.environ:
            self.set("agent", "workspace", os.getenv("ARDAN_WORKSPACE").lstrip())
        if "ARDAN_MAX_STEPS" in os.environ:
            try:
                self.set("agent", "max_steps", int(os.getenv("ARDAN_MAX_STEPS", "40")))
            except ValueError:
                pass
        if "ARDAN_AUTO_CONFIRM" in os.environ:
            env = os.getenv("ARDAN_AUTO_CONFIRM", "").lower()
            self.set("agent", "auto_confirm", env in ("1", "true", "yes"))

    # ---------------------------------------------------------------- config

    def get(self, section: str, key: str, default: Any = None) -> Any:
        return self.config.get(section, {}).get(key, default)

    def set(self, section: str, key: str, value: Any) -> None:
        if not isinstance(self.config.get(section), dict):
            self.config[section] = {}
        self.config[section][key] = value

    def provider_config(self, name: str) -> Dict[str, Any]:
        providers = self.config.get("providers", {})
        cfg = providers.get(name)
        return cfg if isinstance(cfg, dict) else {}

    def set_provider_config(self, name: str, **values: Any) -> None:
        providers = self.config.setdefault("providers", {})
        providers.setdefault(name, {}).update(values)

    def _save_config(self) -> None:
        if not self.config_path:
            return
        with open(self.config_path, "w", encoding="utf-8") as handle:
            yaml.safe_dump(self.config, handle, sort_keys=False)

    # ------------------------------------------------------------ properties

    @property
    def default_provider(self) -> str:
        return self.get("ardan", "default_provider", "ollama")

    @property
    def agent_workspace(self) -> str:
        return self.get("agent", "workspace", "./ardan-output")

    @property
    def agent_max_steps(self) -> int:
        return int(self.get("agent", "max_steps", 40))

    @property
    def agent_max_turns_per_step(self) -> int:
        return int(self.get("agent", "max_turns_per_step", 5))

    @property
    def agent_auto_confirm(self) -> bool:
        return bool(self.get("agent", "auto_confirm", False))

    @property
    def agent_auto_failover(self) -> bool:
        return bool(self.get("agent", "auto_failover", True))

    @property
    def agent_failover_chain(self) -> List[str]:
        chain = self.get("agent", "failover_chain", ["ollama"])
        return list(chain) if isinstance(chain, list) else ["ollama"]

    @property
    def show_raw_llm_output(self) -> bool:
        return bool(self.get("ui", "show_raw_llm_output", False))

    @property
    def mcp_servers(self) -> Dict[str, Any]:
        servers = self.config.get("mcp", {}).get("servers", {})
        return servers if isinstance(servers, dict) else {}


# Singleton used across the CLI.
settings = Settings()
