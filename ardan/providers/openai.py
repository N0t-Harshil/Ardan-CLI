from typing import Any, Optional

from ardan.providers.openai_compat import OpenAICompatProvider


class OpenAIProvider(OpenAICompatProvider):
    name = "openai"
    display_name = "OpenAI"
    api_base = "https://api.openai.com/v1"
    supported_models = [
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4o",
        "gpt-4o-mini",
        "o4-mini",
    ]
    default_model = "gpt-4.1"
    strength = "Best all-round tool-use accuracy"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        **extra: Any,
    ):
        super().__init__(api_key, base_url, **extra)
