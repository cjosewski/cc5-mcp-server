from __future__ import annotations

import os
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class InstallScriptTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(ROOT, "install-plugin.ps1"), encoding="utf-8") as f:
            self.text = f.read()

    def test_no_hardcoded_author_path(self):
        self.assertNotIn("C:\\Users\\macka", self.text)

    def test_copies_all_python_modules(self):
        self.assertIn("*.py", self.text)
