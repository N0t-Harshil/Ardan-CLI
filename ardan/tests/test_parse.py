import unittest

from ardan.utils.parse import (
    extract_finished_summary,
    extract_json_array,
    extract_tool_calls,
    is_finished,
)


class TestJsonArrayExtraction(unittest.TestCase):
    def test_bare_array(self):
        raw = '[{"id": 1}, {"id": 2}]'
        self.assertEqual(extract_json_array(raw), [{"id": 1}, {"id": 2}])

    def test_fenced_array(self):
        raw = "Sure! Here's the plan:\n```json\n[{\"id\": 1}]\n```"
        self.assertEqual(extract_json_array(raw), [{"id": 1}])

    def test_prose_wrapped_with_brackets_in_strings(self):
        raw = 'Result: [{"desc": "a [weird] step"}, {"desc": "ok"}] done.'
        parsed = extract_json_array(raw)
        self.assertEqual(len(parsed), 2)
        self.assertIn("weird", parsed[0]["desc"])

    def test_no_array(self):
        self.assertIsNone(extract_json_array("no data here"))


class TestToolCallExtraction(unittest.TestCase):
    def test_tagged_call(self):
        text = 'I should write the file.\n<tool>{"name": "write_file", "args": {"path": "a.py", "content": "print(1)"}}</tool>'
        calls = extract_tool_calls(text)
        self.assertEqual(calls, [("write_file", {"path": "a.py", "content": "print(1)"})])

    def test_multiple_calls(self):
        text = '<tool>{"name": "read_file", "args": {"path": "x.py"}}</tool><tool>{"name": "lint_python", "args": {"path": "x.py"}}</tool>'
        calls = extract_tool_calls(text)
        self.assertEqual(len(calls), 2)

    def test_fenced_call_fallback(self):
        text = '```json\n{"name": "list_files", "args": {"directory": "."}}\n```'
        self.assertEqual(extract_tool_calls(text), [("list_files", {"directory": "."})])

    def test_bare_json_fallback(self):
        text = 'Reasoning...\n{"name": "git_status", "args": {"cwd": "."}}\n'
        self.assertEqual(extract_tool_calls(text), [("git_status", {"cwd": "."})])

    def test_garbage_returns_empty(self):
        self.assertEqual(extract_tool_calls("just chatting"), [])

    def test_dedupe_repeats(self):
        text = '<tool>{"name": "write_file", "args": {"path": "a"}}</tool><tool>{"name": "write_file", "args": {"path": "a"}}</tool>'
        self.assertEqual(len(extract_tool_calls(text)), 1)


class TestFinished(unittest.TestCase):
    def test_detects_finished(self):
        self.assertTrue(is_finished("<finished>done</finished>"))
        self.assertTrue(is_finished("Here is the summary <finished>all good</finished>"))

    def test_not_finished(self):
        self.assertFalse(is_finished("<tool>{}...</tool>"))

    def test_summary_extracted(self):
        self.assertEqual(extract_finished_summary("<finished>did the thing</finished>"), "did the thing")


if __name__ == "__main__":
    unittest.main()
