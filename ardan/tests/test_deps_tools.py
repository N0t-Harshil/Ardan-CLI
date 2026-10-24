import os
import tempfile
import unittest

from ardan.tools.deps_tools import scan_imports


class TestDepsTools(unittest.TestCase):
    def test_scan_imports(self):
        tmp = tempfile.mkdtemp()
        with open(os.path.join(tmp, "sample.py"), "w", encoding="utf-8") as handle:
            handle.write("import os\nfrom typing import List\nimport requests\n")
        os.makedirs(os.path.join(tmp, "node_modules"))

        result = scan_imports(tmp)
        self.assertTrue(result.success)
        self.assertIn("os", result.output)
        self.assertIn("typing", result.output)
        self.assertIn("requests", result.output)


if __name__ == "__main__":
    unittest.main()
