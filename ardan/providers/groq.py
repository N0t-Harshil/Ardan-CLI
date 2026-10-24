from typing import Any, Optional

from ardan.providers.openai_compat import OpenAICompatProvider


class GroqProvider(OpenAICompatProvider):
    name = "groq"
    display_name = "Groq"
    api_base = "https://api.groq.com/openai/v1"
    supported_models = [
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
        "qwen-2.5-coder-32b",
    ]
    default_model = "llama-3.3-70b-versatile"
    strength = "Extreme inference speed (excellent fallback)"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        **extra: Any,
    ):
        super().__init__(api_key, base_url, **extra)
