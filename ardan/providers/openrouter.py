from typing import Any, Optional

from ardan.providers.openai_compat import OpenAICompatProvider


class OpenRouterProvider(OpenAICompatProvider):
    name = "openrouter"
    display_name = "OpenRouter"
    api_base = "https://openrouter.ai/api/v1"
    supported_models = [
        "deepseek/deepseek-chat",
        "deepseek/deepseek-r1",
        "qwen/qwen-2.5-coder-32b-instruct",
    ]
    default_model = "deepseek/deepseek-chat"
    strength = "Huge model catalogue behind one key"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        **extra: Any,
    ):
        super().__init__(api_key, base_url, **extra)
