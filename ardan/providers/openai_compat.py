"""Shared OpenAI-compatible SSE client.

OpenAI, Groq, Mistral and OpenRouter all expose the same
``/chat/completions`` streaming JSON wire format. One robust httpx client
replaces four vendor SDKs with four different failure modes.
"""

import json
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from ardan.agent.messages import GenerationConfig, HealthStatus, Message, ModelInfo
from ardan.providers.base import ArdanProviderError, BaseProvider


def _make_message_list(messages: List[Message]) -> List[Dict[str, str]]:
    return [{"role": m.role, "content": m.content} for m in messages]


class OpenAICompatProvider(BaseProvider):
    """Base class for OpenAI-wire-compatible providers."""

    api_base: str = ""
    requires_api_key = True

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        default_model: Optional[str] = None,
        **extra: Any,
    ):
        super().__init__(api_key, base_url)
        if base_url:
            self.api_base = base_url.rstrip("/")
        self.extra = extra  # e.g. site_url / app_name (OpenRouter)
        if default_model:
            self.default_model = default_model
        self.timeout = httpx.Timeout(300.0, connect=15.0)
        self.last_tokens_per_second: Optional[float] = None

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self.extra.get("site_url"):
            headers["HTTP-Referer"] = str(self.extra["site_url"])
        if self.extra.get("app_name"):
            headers["X-Title"] = str(self.extra["app_name"])
        return headers

    async def generate(
        self, messages: List[Message], config: GenerationConfig
    ) -> AsyncIterator[str]:
        if not self.api_key:
            raise ArdanProviderError(
                f"API key missing for {self.name}. Store it with: ardan keys set {self.name}",
                self.name,
            )

        payload: Dict[str, Any] = {
            "model": self.default_model,
            "messages": _make_message_list(messages),
            "temperature": config.temperature,
            "max_tokens": config.max_tokens,
            "top_p": config.top_p,
            "stream": True,
        }
        if config.stop_sequences:
            payload["stop"] = config.stop_sequences

        url = f"{self.api_base}/chat/completions"
        chars = 0
        import time

        started = time.perf_counter()

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                async with client.stream(
                    "POST", url, json=payload, headers=self._headers()
                ) as response:
                    if response.status_code != 200:
                        body = (await response.aread()).decode("utf-8", errors="replace")[:350]
                        raise ArdanProviderError(
                            f"HTTP {response.status_code} from {url}: {body}", self.name
                        )
                    async for line in response.aiter_lines():
                        if not line or line.startswith(":"):
                            continue  # SSE comment / keep-alive
                        if not line.startswith("data:"):
                            continue
                        data = line[len("data:"):].strip()
                        if data == "[DONE]":
                            break
                        parsed = json.loads(data)
                        for choice in parsed.get("choices") or []:
                            delta = (choice.get("delta") or {}).get("content")
                            if delta:
                                chars += len(delta)
                                yield delta
        except ArdanProviderError:
            raise
        except httpx.HTTPError as error:
            raise ArdanProviderError(f"Connection to {self.name} failed: {error}", self.name)
        except (json.JSONDecodeError, KeyError, TypeError) as error:
            raise ArdanProviderError(f"Malformed response from {self.name}: {error}", self.name)

        elapsed = time.perf_counter() - started
        if elapsed > 0 and chars:
            # ~4 chars per token (rough but honest measurement, not injected
            # into the stream like the old version did).
            self.last_tokens_per_second = round((chars / 4) / elapsed, 1)

    async def list_models(self) -> List[ModelInfo]:
        if not self.api_key:
            return []
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{self.api_base}/models", headers=self._headers()
                )
                response.raise_for_status()
                data = response.json().get("data", [])
        except (httpx.HTTPError, ValueError):
            return []
        models: List[ModelInfo] = []
        for model in data:
            model_id = str(model.get("id", ""))
            if not model_id:
                continue
            models.append(
                ModelInfo(
                    id=model_id,
                    name=model.get("name", model_id),
                    provider=self.name,
                    context_window=int(model.get("context_length") or 0),
                )
            )
        return models

    async def health_check(self) -> HealthStatus:
        if not self.api_key:
            return HealthStatus(
                "unhealthy", f"API key missing. Store it with: ardan keys set {self.name}"
            )
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{self.api_base}/models", headers=self._headers()
                )
            if response.status_code in (200, 404):
                return HealthStatus("healthy", f"{self.display_name} reachable, key accepted.")
            if response.status_code in (401, 403):
                return HealthStatus("unhealthy", "API key rejected (401/403).")
            return HealthStatus("unhealthy", f"HTTP {response.status_code}.")
        except httpx.HTTPError as error:
            return HealthStatus("unhealthy", f"Unreachable: {error}")
