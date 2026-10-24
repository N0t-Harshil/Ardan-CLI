from typing import AsyncIterator, List, Optional

from ardan.agent.messages import GenerationConfig, HealthStatus, Message, ModelInfo
from ardan.providers.base import ArdanProviderError, BaseProvider

try:
    import anthropic
except ImportError:
    anthropic = None


class AnthropicProvider(BaseProvider):
    name = "anthropic"
    display_name = "Anthropic"
    requires_api_key = True
    supported_models = [
        "claude-sonnet-4-5",
        "claude-opus-4-1",
        "claude-haiku-4-5",
    ]
    default_model = "claude-sonnet-4-5"

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None):
        super().__init__(api_key, base_url)
        self.client = (
            anthropic.AsyncAnthropic(api_key=api_key) if (anthropic and api_key) else None
        )

    async def generate(
        self, messages: List[Message], config: GenerationConfig
    ) -> AsyncIterator[str]:
        if not self.client:
            raise ArdanProviderError(
                "Anthropic SDK not installed or API key missing. "
                "Install with: pip install ardan[anthropic], then: ardan keys set anthropic",
                self.name,
            )

        system_prompt = next((m.content for m in messages if m.role == "system"), "")
        anthropic_messages = [
            {"role": m.role, "content": m.content}
            for m in messages
            if m.role != "system"
        ]

        kwargs = {
            "model": self.default_model,
            "max_tokens": config.max_tokens,
            "messages": anthropic_messages,
            "temperature": config.temperature,
        }
        if system_prompt:
            kwargs["system"] = system_prompt

        # NOTE: no "stream" kwarg here - client.messages.stream() handles
        # streaming itself (passing stream=True used to crash with TypeError).
        try:
            async with self.client.messages.stream(**kwargs) as stream:
                async for text in stream.text_stream:
                    yield text
        except Exception as error:
            raise ArdanProviderError(str(error), self.name)

    async def list_models(self) -> List[ModelInfo]:
        # Static catalogue: those IDs are proven-stable API names.
        return [
            ModelInfo(
                id="claude-sonnet-4-5",
                name="Claude Sonnet 4.5",
                provider=self.name,
                context_window=200000,
                pricing_per_1m_tokens=3.0,
                strength="Excellent everyday coding",
            ),
            ModelInfo(
                id="claude-opus-4-1",
                name="Claude Opus 4.1",
                provider=self.name,
                context_window=200000,
                pricing_per_1m_tokens=15.0,
                strength="Most powerful complex reasoning",
            ),
            ModelInfo(
                id="claude-haiku-4-5",
                name="Claude Haiku 4.5",
                provider=self.name,
                context_window=200000,
                pricing_per_1m_tokens=1.0,
                strength="Fastest Claude",
            ),
        ]

    async def health_check(self) -> HealthStatus:
        if not anthropic:
            return HealthStatus("unhealthy", "Anthropic SDK not installed: pip install ardan[anthropic]")
        if not self.api_key:
            return HealthStatus("unhealthy", "API key missing. Use: ardan keys set anthropic")
        return HealthStatus("healthy", "Anthropic configured.")
