import json
import os
import tempfile
import unittest

from ardan.agent.memory import Memory


class TestMemory(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.mkdtemp()

    def _memory(self):
        # Unique session id per test so sessions never collide cross-test.
        Memory._ids = getattr(Memory, "_ids", 1_700_000_000)
        Memory._ids += 1
        return Memory(self.workspace, session_id=Memory._ids)

    def test_sessions_persist(self):
        mem = self._memory()
        mem.add_step("EXECUTOR_REASONING", "thinking about it")
        mem.record_command("echo hi")
        mem.record_error("boom")

        clone = Memory(self.workspace, session_id=mem.session_id)
        self.assertEqual(len(clone.history), 1)
        self.assertEqual(clone.commands_run, ["echo hi"])
        self.assertEqual(clone.errors, ["boom"])

    def test_records_are_absolute_and_undo_works(self):
        mem = self._memory()
        created = os.path.join(self.workspace, "generated.txt")
        with open(created, "w", encoding="utf-8") as handle:
            handle.write("v1")

        mem.record_file_created(os.path.join(self.workspace, "new.txt"))
        mem.record_modification(created)  # backs up v1
        with open(created, "w", encoding="utf-8") as handle:
            handle.write("v2")

        self.assertTrue(os.path.isabs(mem.files_created[0]))
        self.assertEqual(mem.backups[created], "v1")

        count = mem.undo_last_run()
        self.assertGreaterEqual(count, 1)
        self.assertFalse(os.path.exists(os.path.join(self.workspace, "new.txt")))
        with open(created, "r", encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "v1")

    def test_diff_reports_paths(self):
        mem = self._memory()
        mem.record_file_created(os.path.join(self.workspace, "x.py"))
        diff = mem.get_diff()
        self.assertIn("x.py", diff)
        self.assertIn("Files Created", diff)

    def test_list_sessions(self):
        mem = self._memory()
        mem.add_step("TYPE", "content")
        sessions = Memory(self.workspace, session_id=0).list_sessions()
        self.assertIn(mem.session_id, sessions)


if __name__ == "__main__":
    unittest.main()
