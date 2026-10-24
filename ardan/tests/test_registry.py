import unittest
from typing import AsyncIterator, List

import ardan.providers.registry as registry
from ardan.agent.messages import GenerationConfig, HealthStatus, Message, ModelInfo
from ardan.providers.base import ArdanProviderError, BaseProvider


class OkProvider(BaseProvider):
    name = "faketwo"
    display_name = "Fake OK"
    requires_api_key = False
    default_model = "ok-1"

    def __init__(self, **_):
        super().__init__(None)

    async def generate(self, messages: List[Message], config: GenerationConfig):
        for _ in range(2):
            yield "ok"

    async def list_models(self):
        return []

    async def health_check(self):
        return HealthStatus("healthy", "x")


class DeadProvider(BaseProvider):
    name = "fakedead"
    display_name = "Fake Dead"
    requires_api_key = False
    default_model = "dead-1"

    def __init__(self, **_):
        super().__init__(None)

    async def generate(self, messages: List[Message], config: GenerationConfig):
        raise ArdanProviderError("down", self.name)
        yield ""  # pragma: no cover

    async def list_models(self):
        return []

    async def health_check(self):
        return HealthStatus("unhealthy", "x")


class PartialProvider(BaseProvider):
    """Streams one chunk, then dies. Failover must NOT restart after this."""

    name = "fakepartial"
    display_name = "Fake Partial"
    requires_api_key = False
    default_model = "p-1"

    def __init__(self, **_):
        super().__init__(None)

    async def generate(self, messages: List[Message], config: GenerationConfig):
        yield "partial"
        raise ArdanProviderError("mid-stream boom", self.name)
        yield ""  # pragma: no cover

    async def list_models(self):
        return []

    async def health_check(self):
        return HealthStatus("unhealthy", "x")


class TestFailoverCreate(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._target = None
        for provider in (OkProvider, DeadProvider, PartialProvider):
            registry.PROVIDERS[provider.name] = provider
        self._originals = dict(registry.PROVIDERS)

    def tearDown(self):
        for name in ("faketwo", "fakedead", "fakepartial"):
            registry.PROVIDERS.pop(name, None)

    async def test_failover_when_primary_upfront_fails(self):
        primary = DeadProvider()
        config = {"agent": {"auto_failover": True, "failover_chain": ["faketwo"]}}
        chunks = []
        async for chunk in registry.failover_generate(
            [Message(role="user", content="hi")], GenerationConfig(), primary, config
        ):
            chunks.append(chunk)
        self.assertEqual(chunks, ["ok", "ok"])

    async def test_no_failover_when_disabled(self):
        primary = DeadProvider()
        config = {"agent": {"auto_failover": False, "failover_chain": ["faketwo"]}}
        with self.assertRaises(ArdanProviderError):
            async for _ in registry.failover_generate(
                [Message(role="user", content="hi")], GenerationConfig(), primary, config
            ):
                pass

    async def test_mid_stream_failure_does_not_restart(self):
        primary = PartialProvider()
        config = {"agent": {"auto_failover": True, "failover_chain": ["faketwo"]}}
        chunks = []
        with self.assertRaises(ArdanProviderError):
            async for chunk in registry.failover_generate(
                [Message(role="user", content="hi")], GenerationConfig(), primary, config
            ):
                chunks.append(chunk)
        self.assertEqual(chunks, ["partial"])

    async def test_all_down_raises_last_error(self):
        primary = DeadProvider()
        config = {"agent": {"auto_failover": True, "failover_chain": ["fakedead", "faketwo"]}}
        # chain: fakedead is primary (deduped), then faketwo succeeds.
        chunks = []
        async for chunk in registry.failover_generate(
            [Message(role="user", content="hi")], GenerationConfig(), primary, config
        ):
            chunks.append(chunk)
        self.assertEqual(chunks, ["ok", "ok"])

        config["agent"]["failover_chain"] = []
        with self.assertRaises(ArdanProviderError):
            async for _ in registry.failover_generate(
                [Message(role="user", content="hi")], GenerationConfig(), primary, config
            ):
                pass


if __name__ == "__main__":
    unittest.main()
