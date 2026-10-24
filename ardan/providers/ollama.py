import asyncio
import json
from typing import AsyncIterator, List, Optional

import httpx

from ardan.agent.messages import GenerationConfig, HealthStatus, Message, ModelInfo
from ardan.providers.base import ArdanProviderError, BaseProvider

DEFAULT_OLLAMA_URL = "http://localhost:11434"


class OllamaProvider(BaseProvider):
    name = "ollama"
    display_name = "Ollama"
    requires_api_key = False
    supported_models = ["qwen2.5-coder:14b", "qwen2.5-coder:7b", "codellama:13b", "llama3", "mistral"]
    default_model = "qwen2.5-coder:14b"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        num_ctx: int = 8192,
        **extra,
    ):
        super().__init__(api_key, base_url)
        self.base_url = (self.base_url or DEFAULT_OLLAMA_URL).rstrip("/")
        self.num_ctx = num_ctx
        self.timeout = httpx.Timeout(600.0, connect=10.0)
        self.last_tokens_per_second: Optional[float] = None

    async def generate(
        self, messages: List[Message], config: GenerationConfig
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.default_model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": config.stream,
            "options": {"temperature": config.temperature, "num_ctx": self.num_ctx},
        }

        max_retries = 3
        backoff = 1.0
        last_error: Optional[str] = None

        for attempt in range(max_retries):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    async with client.stream(
                        "POST", f"{self.base_url}/api/chat", json=payload
                    ) as response:
                        if response.status_code == 404:
                            body = (await response.aread()).decode("utf-8", errors="replace")
                            raise ArdanProviderError(
                                f"Model '{self.default_model}' not found locally (404). "
                                f"Pull it first: ollama pull {self.default_model} "
                                f"[server said: {body[:200]}]",
                                self.name,
                            )
                        if response.status_code != 200:
                            body = (await response.aread()).decode("utf-8", errors="replace")
                            raise ArdanProviderError(
                                f"Ollama HTTP {response.status_code}: {body[:200]}", self.name
                            )

                        prompt_tokens = eval_tokens = 0
                        import time

                        started = time.perf_counter()
                        first_token_at: Optional[float] = None
                        async for line in response.aiter_lines():
                            if not line:
                                continue
                            chunk = json.loads(line)
                            if "message" in chunk and "content" in chunk["message"]:
                                if first_token_at is None:
                                    first_token_at = time.perf_counter()
                                yield chunk["message"]["content"]
                            summary = chunk.get("eval_count"), chunk.get("eval_duration")
                            if chunk.get("done") and summary[0] and summary[1]:
                                eval_tokens, eval_nanos = summary
                                seconds = eval_nanos / 1e9
                                if seconds > 0:
                                    self.last_tokens_per_second = round(eval_tokens / seconds, 1)
                            if chunk.get("done"):
                                return
                        return

            except ArdanProviderError:
                raise  # never retry deterministic errors like 404
            except (httpx.ConnectError, httpx.TimeoutException, json.JSONDecodeError) as error:
                last_error = str(error)
                if attempt < max_retries - 1:
                    await asyncio.sleep(backoff)
                    backoff *= 2
                continue

        raise ArdanProviderError(
            f"Ollama unreachable at {self.base_url} after {max_retries} attempts: {last_error}. "
            "Start it with: ollama serve (and pull the model: ollama pull "
            f"{self.default_model})",
            self.name,
        )

    async def list_models(self) -> List[ModelInfo]:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                response.raise_for_status()
                data = response.json().get("models", [])
        except (httpx.HTTPError, ValueError):
            return []
        return [
            ModelInfo(
                id=m["name"],
                name=m["name"],
                provider=self.name,
                context_window=int(m.get("context_length") or 0),
                strength="100% local, zero cost",
            )
            for m in data
        ]

    async def health_check(self) -> HealthStatus:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
            if response.status_code == 200:
                models = response.json().get("models", [])
                available = ", ".join(m["name"] for m in models[:8]) or "none yet"
                return HealthStatus("healthy", f"Ollama live. Local models: {available}")
            return HealthStatus("unhealthy", f"Ollama HTTP {response.status_code}.")
        except httpx.HTTPError as error:
            return HealthStatus(
                "unhealthy",
                f"Ollama unreachable at {self.base_url}: {error}. Start with: ollama serve",
            )
