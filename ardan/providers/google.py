from typing import AsyncIterator, List, Optional

from ardan.agent.messages import GenerationConfig, HealthStatus, Message, ModelInfo
from ardan.providers.base import ArdanProviderError, BaseProvider

try:
    import google.generativeai as genai
except ImportError:
    genai = None


class GoogleProvider(BaseProvider):
    name = "google"
    display_name = "Google"
    requires_api_key = True
    supported_models = [
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.0-flash",
    ]
    default_model = "gemini-2.5-flash"

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None):
        super().__init__(api_key, base_url)
        if genai and api_key:
            genai.configure(api_key=api_key)

    async def generate(
        self, messages: List[Message], config: GenerationConfig
    ) -> AsyncIterator[str]:
        if not genai:
            raise ArdanProviderError(
                "Google SDK not installed. Install with: pip install ardan[google]",
                self.name,
            )
        if not self.api_key:
            raise ArdanProviderError(
                "API key missing. Store it with: ardan keys set google", self.name
            )

        system_instruction = next((m.content for m in messages if m.role == "system"), None)
        contents = [
            {"role": "user" if m.role == "user" else "model", "parts": [m.content]}
            for m in messages
            if m.role != "system"
        ]

        model = genai.GenerativeModel(
            model_name=self.default_model, system_instruction=system_instruction
        )

        try:
            response = await model.generate_content_async(
                contents,
                generation_config=genai.types.GenerationConfig(
                    temperature=config.temperature,
                    max_output_tokens=config.max_tokens,
                    top_p=config.top_p,
                ),
                stream=True,
            )
            async for chunk in response:
                text = getattr(chunk, "text", None)
                if text:
                    yield text
        except Exception as error:
            raise ArdanProviderError(str(error), self.name)

    async def list_models(self) -> List[ModelInfo]:
        return [
            ModelInfo(
                id="gemini-2.5-pro",
                name="Gemini 2.5 Pro",
                provider=self.name,
                context_window=2000000,
                pricing_per_1m_tokens=1.25,
                strength="Huge context, strong reasoning",
            ),
            ModelInfo(
                id="gemini-2.5-flash",
                name="Gemini 2.5 Flash",
                provider=self.name,
                context_window=1000000,
                pricing_per_1m_tokens=0.10,
                strength="Fast Google workhorse",
            ),
            ModelInfo(
                id="gemini-2.0-flash",
                name="Gemini 2.0 Flash",
                provider=self.name,
                context_window=1000000,
                pricing_per_1m_tokens=0.10,
                strength="Budget option",
            ),
        ]

    async def health_check(self) -> HealthStatus:
        if not genai:
            return HealthStatus("unhealthy", "Google SDK not installed: pip install ardan[google]")
        if not self.api_key:
            return HealthStatus("unhealthy", "API key missing. Use: ardan keys set google")
        return HealthStatus("healthy", "Google configured.")
