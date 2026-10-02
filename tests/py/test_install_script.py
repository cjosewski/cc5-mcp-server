from __future__ import annotations

import os
import shutil
import subprocess
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPT = os.path.join(ROOT, "install-plugin.ps1")


class InstallScriptTest(unittest.TestCase):
    """The installer is never run here: a run with administrator rights would replace the real CC5 plugin."""

    def setUp(self):
        with open(SCRIPT, encoding="utf-8") as f:
            self.text = f.read()

    def test_no_hardcoded_author_path(self):
        self.assertNotIn("C:\\Users\\macka", self.text)

    def test_copies_all_python_modules(self):
        self.assertIn("*.py", self.text)

    def test_refuses_without_administrator_rights_before_touching_anything(self):
        check = self.text.index("IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)")
        for command in ("Remove-Item", "New-Item", "Copy-Item"):
            with self.subTest(command=command):
                self.assertLess(check, self.text.index(command))
        refusal = self.text[check:self.text.index("}", check)]
        self.assertIn("Run as administrator", refusal)
        self.assertIn("exit 1", refusal)

    def test_errors_stop_the_install_and_exit_1(self):
        # Without this, PowerShell's non-terminating "Access denied" errors let the script run on and say "installed".
        self.assertLess(self.text.index('$ErrorActionPreference = "Stop"'), self.text.index("Remove-Item"))
        catch = self.text[self.text.index("} catch {"):]
        self.assertIn("exit 1", catch[:catch.index("\n}")])

    def test_fails_when_a_copied_file_is_missing(self):
        verify = self.text[self.text.index("$missing"):]
        self.assertIn("Test-Path (Join-Path $dest $_)", verify)
        self.assertIn("exit 1", verify)
        self.assertLess(verify.index("exit 1"), verify.index("Plugin installed to"))

    @unittest.skipUnless(shutil.which("powershell"), "Windows PowerShell is not available")
    def test_script_parses(self):
        command = ("$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile("
                   "$env:CC5_INSTALL_SCRIPT, [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count")
        result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
                                env={**os.environ, "CC5_INSTALL_SCRIPT": SCRIPT},
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
