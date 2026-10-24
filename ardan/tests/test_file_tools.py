import os
import tempfile
import unittest

from ardan.tools.file_tools import (
    append_file,
    delete_file,
    list_files,
    read_file,
    search_and_replace,
    write_file,
)


class TestFileTools(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "hello.txt")

    def test_write_read_delete(self):
        self.assertTrue(write_file(self.path, "test content").success)
        self.assertEqual(read_file(self.path).output, "test content")
        self.assertTrue(delete_file(self.path).success)
        self.assertFalse(os.path.exists(self.path))

    def test_append(self):
        write_file(self.path, "one\n")
        append_file(self.path, "two\n")
        self.assertEqual(read_file(self.path).output, "one\ntwo\n")

    def test_search_and_replace(self):
        write_file(self.path, "hello world")
        result = search_and_replace(self.path, "world", "ardan")
        self.assertTrue(result.success)
        self.assertEqual(read_file(self.path).output, "hello ardan")
        missing = search_and_replace(self.path, "nope", "x")
        self.assertFalse(missing.success)

    def test_read_missing(self):
        self.assertFalse(read_file(os.path.join(self.tmp, "nope.txt")).success)

    def test_list_files(self):
        write_file(os.path.join(self.tmp, "a.txt"), "x")
        result = list_files(self.tmp)
        self.assertTrue(result.success)
        self.assertIn("a.txt", result.output)


if __name__ == "__main__":
    unittest.main()
