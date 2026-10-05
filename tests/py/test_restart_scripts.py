from __future__ import annotations

import glob
import os
import re
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
RECOVERY_GUIDANCE = ('If CC5 shows "Unsaved project data found", answer it yourself: '
                     'OK restores the auto-saved changes, Cancel discards them.')


def read(name: str) -> str:
    with open(os.path.join(SCRIPTS, name), encoding="utf-8") as f:
        return f.read()


class RestartScriptsTest(unittest.TestCase):
    """The scripts are never run here: they start and stop the real Character Creator 5."""

    def test_no_script_sends_keys_or_clicks_to_cc5(self):
        # Keys sent to CC5 answer its "Unsaved project data found" question for the user (Enter = OK restores,
        # Escape = Cancel discards). The plugin's Export Head helper (cc5-plugin) is upstream and not scanned.
        scripts = glob.glob(os.path.join(SCRIPTS, "**", "*.ps1"), recursive=True)
        self.assertTrue(scripts)
        for path in scripts:
            with open(path, encoding="utf-8") as f:
                text = f.read()
            for api in ("SendKeys", "SetForegroundWindow", "keybd_event", "SendInput"):
                with self.subTest(script=os.path.relpath(path, ROOT), api=api):
                    self.assertNotRegex(text, re.compile(re.escape(api), re.IGNORECASE))

    def test_restart_does_not_kill_cc5_without_force(self):
        text = read("cc5-restart.ps1")
        self.assertIn("[switch]$Force", text)
        refusal_at = text.index("if (-not $Force)")
        refusal = text[refusal_at:text.index("}", refusal_at)]
        self.assertIn("close CC5 yourself", refusal)
        self.assertIn("exit 1", refusal)
        self.assertLess(refusal_at, text.index("Stop-Process"))
        self.assertIn("Unsaved work is lost", text[refusal_at:text.index("Stop-Process")])

    def test_restart_tells_the_user_to_answer_the_recovery_prompt_when_asked_to(self):
        text = read("cc5-restart.ps1")
        self.assertIn(RECOVERY_GUIDANCE, text)
        self.assertIn('if ($RecoveryAnswer -eq "ask")', text)

    def test_restart_has_the_plugin_answer_the_recovery_prompt_by_default(self):
        # Chad, 2026-10-05 (F-52): when Claude launches CC5, "Unsaved project data found" is answered Cancel.
        text = read("cc5-restart.ps1")
        self.assertIn('[ValidateSet("cancel", "ok", "ask")]', text)
        self.assertIn('[string]$RecoveryAnswer = "cancel"', text)
        self.assertLess(text.index("$env:CC5_RECOVERY_ANSWER = $RecoveryAnswer"), text.index("Start-Process $cc5Path"))

    def test_force_leaves_the_recovery_prompt_to_the_user_unless_told_otherwise(self):
        # -Force kills CC5: the recovery prompt is then the only way back to that work (review of F-52).
        text = read("cc5-restart.ps1")
        self.assertIn('if ($Force -and -not $PSBoundParameters.ContainsKey("RecoveryAnswer")) {', text)
        self.assertLess(text.index('$RecoveryAnswer = "ask"'), text.index("Start-Process $cc5Path"))

    def test_launch_script_does_not_restart_cc5_and_prints_the_guidance(self):
        text = read("launch_cc5_for_test.ps1")
        self.assertNotIn("cc5-restart.ps1", text)
        self.assertIn(RECOVERY_GUIDANCE, text)


if __name__ == "__main__":
    unittest.main()
