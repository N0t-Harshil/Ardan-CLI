from typing import Any, Optional

from ardan.providers.openai_compat import OpenAICompatProvider


class MistralProvider(OpenAICompatProvider):
    name = "mistral"
    display_name = "Mistral"
    api_base = "https://api.mistral.ai/v1"
    supported_models = [
        "codestral-latest",
        "mistral-large-latest",
        "mistral-medium-latest",
    ]
    default_model = "codestral-latest"
    strength = "Dedicated code generation model"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        **extra: Any,
    ):
        super().__init__(api_key, base_url, **extra)
