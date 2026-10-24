"""End-to-end executor loop test with a scripted fake provider (no network)."""

import os
import tempfile
import unittest

from ardan.agent.executor import Executor
from ardan.agent.memory import Memory
from ardan.agent.messages import GenerationConfig, Message
from ardan.agent.planner import Planner, normalize_plan
from ardan.providers.base import ArdanProviderError, BaseProvider


class FakeProvider(BaseProvider):
    """Plays back scripted assistant turns, one per generate() call."""

    name = "fake"
    display_name = "Fake"
    requires_api_key = False
    default_model = "fake-1"

    def __init__(self, script, **kwargs):
        super().__init__(None, None)
        self.script = list(script)
        self.calls = 0

    async def generate(self, messages, config: GenerationConfig):
        self.calls += 1
        if not self.script:
            raise ArdanProviderError("Script exhausted", self.name)
        text = self.script.pop(0)
        for piece in text.split("|"):
            yield piece

    async def list_models(self):
        return []

    async def health_check(self):
        pass


class TestExecutorLoop(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.cwd = os.getcwd()
        self.tmp = tempfile.mkdtemp()
        os.chdir(self.tmp)
        Memory._ids = getattr(Memory, "_ids", 1_700_000_000)
        Memory._ids += 1
        self.memory = Memory(self.tmp, session_id=Memory._ids)

    def tearDown(self):
        os.chdir(self.cwd)

    async def test_write_read_finish(self):
        provider = FakeProvider(
            [
                "I will create the file.|<tool>{\"name\": \"write_file\", \"args\": {\"path\": \"hello.py\", \"content\": \"print('hi')\"}}</tool>",
                "<tool>{\"name\": \"read_file\", \"args\": {\"path\": \"hello.py\"}}</tool>",
                "<finished>created hello.py</finished>",
            ]
        )
        executor = Executor(provider, self.memory, settings={})
        events = []
        async for event in executor.execute_step({"id": 1, "description": "write a file"}):
            events.append(event)

        kinds = [e["t"] for e in events]
        self.assertIn("tool_call", kinds)
        self.assertIn("obs", kinds)
        self.assertIn("finished", kinds)
        self.assertTrue(os.path.exists("hello.py"))
        self.assertIn(os.path.abspath("hello.py"), self.memory.files_created)

        obs_success = [e for e in events if e["t"] == "obs"]
        self.assertTrue(all(e["success"] for e in obs_success))

    async def test_unknown_tool_gracefully_reported(self):
        provider = FakeProvider(
            [
                "<tool>{\"name\": \"nonexistent_tool\", \"args\": {}}</tool>",
                "<tool>{\"name\": \"list_files\", \"args\": {\"directory\": \".\"}}</tool>",
                "<finished>ok</finished>",
            ]
        )
        executor = Executor(provider, self.memory, settings={})
        events = []
        async for event in executor.execute_step({"id": 1, "description": "x"}):
            events.append(event)
        failures = [e for e in events if e["t"] == "obs" and not e["success"]]
        self.assertTrue(failures, "unknown tool should surface a failure observation")
        self.assertEqual(self.memory.errors[-1].startswith("nonexistent_tool"), True)

    async def test_catalog_lists_registered_tools(self):
        executor = Executor(FakeProvider([]), self.memory, settings={})
        catalog = executor.tool_catalog()
        self.assertIn("write_file(path, content)", catalog)
        self.assertIn("run_command(command, cwd, timeout)", catalog)


class TestPlannerParse(unittest.IsolatedAsyncioTestCase):
    async def test_plan_extension_from_prose(self):
        provider = FakeProvider(
            ['Sure! [ {"id": 3, "description": "step three", "tool_hint": "", "depends_on": []} ]']
        )
        planner = Planner(provider)
        plan = await planner.create_plan("do things")
        self.assertEqual(plan[0]["id"], 1)
        self.assertEqual(plan[0]["description"], "step three")

    async def test_normalize_remaps_dependencies(self):
        plan = normalize_plan(
            [
                {"id": 77, "description": "a"},
                {"id": 88, "description": "b", "depends_on": [77]},
            ]
        )
        self.assertEqual([s["id"] for s in plan], [1, 2])
        self.assertEqual(plan[1]["depends_on"], [1])


if __name__ == "__main__":
    unittest.main()
