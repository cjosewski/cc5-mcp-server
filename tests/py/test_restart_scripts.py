from __future__ import annotations

import ast
import glob
import os
import re
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
RECOVERY_GUIDANCE = ('If CC5 shows "Unsaved project data found", answer it yourself: '
                     'OK restores the auto-saved changes, Cancel discards them.')
# Windows PowerShell 5.1 (powershell.exe, which runs these scripts) also calls Invoke-WebRequest iwr, curl and wget;
# curl.exe is curl itself.
WEB_REQUEST = re.compile(r"(?<![\w$.-])(?:Invoke-WebRequest|iwr|curl|wget)(?![\w.-])", re.IGNORECASE)
USE_BASIC_PARSING = re.compile(r"(?<![\w-])-UseBasicParsing\b", re.IGNORECASE)
# What PowerShell does not run: block comments and here-strings (blanked first, keeping the line breaks), then on each
# line quoted text and a comment (a '#' that starts a word).
NOT_RUN_BLOCKS = re.compile(r"""<#.*?#>|@(["'])[ \t]*\r?\n.*?\r?\n\1@""", re.DOTALL)
NOT_RUN_ON_LINE = re.compile(r"""'[^']*'?|"(?:`.|[^"`])*"?|(?<![^\s;({|])#.*""")


def read(name: str) -> str:
    with open(os.path.join(SCRIPTS, name), encoding="utf-8") as f:
        return f.read()


def ps_statements(text: str) -> list[tuple[int, str]]:
    """(first line, code) for each statement of a PowerShell script: what PowerShell does not run is blanked out, and
    a line ending in a backtick is joined to the next one. A word found in the code is one the script runs."""
    text = NOT_RUN_BLOCKS.sub(lambda m: re.sub(r"[^\r\n]", " ", m.group()), text)
    statements, parts, start = [], [], 0
    for number, line in enumerate(text.split("\n"), 1):
        code = NOT_RUN_ON_LINE.sub(lambda m: " " * len(m.group()), line.rstrip("\r"))
        if not parts:
            start = number
        if code.endswith("`"):
            parts.append(code[:-1])
            continue
        parts.append(code)
        statements.append((start, " ".join(parts)))
        parts = []
    if parts:
        statements.append((start, " ".join(parts)))
    return statements


def web_requests_without_basic_parsing(text: str) -> list[tuple[int, str]]:
    """(line, code) of each statement that calls Invoke-WebRequest, by any of its names, without -UseBasicParsing."""
    return [(line, code.strip()) for line, code in ps_statements(text)
            if WEB_REQUEST.search(code) and not USE_BASIC_PARSING.search(code)]


def posted_routes(statements: list[ast.stmt]) -> set[str]:
    """The bridge routes these statements of live_smoke_test.py POST to with call("POST", "<route>", ...)."""
    routes = set()
    for statement in statements:
        for node in ast.walk(statement):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "call"
                    and len(node.args) >= 2 and all(isinstance(arg, ast.Constant) for arg in node.args[:2])
                    and node.args[0].value == "POST"):
                routes.add(node.args[1].value)
    return routes


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

    def test_every_invoke_webrequest_passes_usebasicparsing(self):
        # F-93: in Windows PowerShell 5.1, Invoke-WebRequest without -UseBasicParsing threw on every answer, and the
        # wait loop's empty catch hid it: every launch waited the whole limit and said the bridge had not answered,
        # while it had been up after about 70 s. Invoke-RestMethod (launch_cc5_for_test.ps1) was not affected.
        scripts = glob.glob(os.path.join(SCRIPTS, "**", "*.ps1"), recursive=True)
        self.assertTrue(scripts)
        for path in scripts:
            with open(path, encoding="utf-8-sig") as f:
                calls = web_requests_without_basic_parsing(f.read())
            with self.subTest(script=os.path.relpath(path, ROOT)):
                self.assertEqual(calls, [], "add -UseBasicParsing (F-93), or call curl.exe for curl itself")

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

    def test_restart_timeout_points_at_the_cc5_window_not_at_a_slow_start(self):
        # Review of F-93: no live start took over two minutes (they took up to about 70 s), so a bridge silent after
        # 240 s is no slow start: the message names what to check in the CC5 window.
        for name in ("cc5-restart.ps1", "launch_cc5_for_test.ps1"):
            with self.subTest(script=name):
                self.assertNotIn("over two minutes", read(name))
        text = read("cc5-restart.ps1")
        timeout = text[text.index("if (-not $up)"):]
        self.assertNotIn("may still be starting", timeout)
        self.assertIn('"[CC5] The bridge did not answer within $BridgeWaitSeconds s (live starts took up to about '
                      '70 s)."', timeout)
        self.assertIn('"[CC5] Check the CC5 window (the 3D Creator / AI Studio chooser, a startup dialog), and check '
                      'the bridge with: curl.exe http://127.0.0.1:5101/health"', timeout)

    def test_restart_measures_the_time_to_the_bridge(self):
        # Live it printed "Bridge up after 34s" and "16s": a count of the 2 s sleeps, which left out one sleep and the
        # time of every health request. A stopwatch started right after the launch measures it.
        text = read("cc5-restart.ps1")
        launch = text.index("Start-Process $cc5Path")
        clock = text.index("$clock = [System.Diagnostics.Stopwatch]::StartNew()")
        between = text[launch:clock].splitlines()[1:]
        self.assertLess(launch, clock)
        self.assertTrue(all(not line.strip() or line.strip().startswith("#") for line in between), between)
        self.assertLess(clock, text.index("for ($i = 0;"))
        self.assertIn('Write-Host "[CC5] Bridge up after $([math]::Floor($clock.Elapsed.TotalSeconds))s"', text)
        self.assertNotIn("$i * 2", text)

    def test_launch_script_does_not_restart_cc5_and_prints_the_guidance(self):
        text = read("launch_cc5_for_test.ps1")
        self.assertNotIn("cc5-restart.ps1", text)
        self.assertIn(RECOVERY_GUIDANCE, text)

    def test_launch_script_measures_the_wait(self):
        # As in cc5-restart.ps1: a wait counted from the 2 s sleeps leaves out the time of each request.
        text = read("launch_cc5_for_test.ps1")
        clock = text.index("$clock = [System.Diagnostics.Stopwatch]::StartNew()")
        self.assertLess(text.index("Start-Process -FilePath $exe"), clock)
        self.assertLess(clock, text.index("for ($i = 0;"))
        self.assertIn("$waited = [math]::Floor($clock.Elapsed.TotalSeconds)", text)
        self.assertIn('"[launch] bridge UP at http://127.0.0.1:5101 after ${waited}s"', text)
        self.assertIn('"[launch] bridge DOWN after ${waited}s - ', text)


class LiveSmokeTestScriptTest(unittest.TestCase):
    """scripts/live_smoke_test.py needs a running CC5, so it is read here, not run."""

    def test_the_light_checks_set_the_light_back(self):
        # Live 2026-10-07 the script left "Key Light - Up" red at multiplier 1: the colour and the multiplier are set
        # back in a finally, so also when a check in between fails.
        tree = ast.parse(read("live_smoke_test.py"))
        tries = [node for node in ast.walk(tree)
                 if isinstance(node, ast.Try) and "/light/color" in posted_routes(node.body)]
        self.assertEqual(len(tries), 1)
        self.assertIn("/light/multiplier", posted_routes(tries[0].body))
        self.assertLessEqual({"/light/color", "/light/multiplier"}, posted_routes(tries[0].finalbody))

    def test_exec_python_is_judged_by_the_bridge_answer(self):
        # Live 2026-10-07 CC5 ran with CC5_DEV_MODE=1 while the script did not, so "exec_python blocked without dev
        # mode" FAILed: CC5's environment decides whether exec_python runs, so the bridge's answer decides the check.
        text = read("live_smoke_test.py")
        self.assertNotIn("exec_python blocked without dev mode", text)
        exec_check = text[text.index('call("POST", "/exec/python"'):text.index("STATUS_TIMES = []")]
        self.assertIn('ok("exec_python (CC5 allows it)", True', exec_check)
        self.assertIn('elif s == 403:\n    ok("exec_python blocked (CC5 runs without dev mode)", True', exec_check)


# Lines 4, 6, 8 and 13 call Invoke-WebRequest without -UseBasicParsing (8: curl is Invoke-WebRequest in Windows
# PowerShell 5.1; 13: there the switch is only text in a string). The rest is clean: comments (1 to 3), the switch
# (5), text in a string and a comment (7), curl.exe (9), Invoke-RestMethod (10), a call continued onto the next line
# (11 and 12) and a here-string (14 to 16).
WEB_REQUEST_SNIPPET = '''\
<# Invoke-WebRequest in a block comment
#>
# Invoke-WebRequest without -UseBasicParsing threw (F-93)
$a = Invoke-WebRequest -Uri "http://127.0.0.1:5101/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
$b = Invoke-WebRequest -Uri "http://127.0.0.1:5101/health" -TimeoutSec 2 -UseBasicParsing
$c = iwr $health
Write-Host "Invoke-WebRequest failed" # iwr
curl http://127.0.0.1:5101/health
curl.exe http://127.0.0.1:5101/health
$d = Invoke-RestMethod -Uri $health -TimeoutSec 2
$e = Invoke-WebRequest -Uri "http://127.0.0.1:5101/#a" `
    -UseBasicParsing
$f = Invoke-WebRequest -Uri $health -Headers @{ "X" = "-UseBasicParsing" }
$g = @"
Invoke-WebRequest in a here-string
"@
'''


class WebRequestScanTest(unittest.TestCase):
    """The scan above finds what it looks for: a scan that never fires would pass any script."""

    def test_the_scan_finds_calls_without_usebasicparsing(self):
        found = web_requests_without_basic_parsing(WEB_REQUEST_SNIPPET)
        self.assertEqual([line for line, _code in found], [4, 6, 8, 13])

    def test_the_scan_sees_the_restart_scripts_health_check(self):
        text = read("cc5-restart.ps1")
        self.assertEqual(web_requests_without_basic_parsing(text), [])
        found = web_requests_without_basic_parsing(text.replace(" -UseBasicParsing", ""))
        self.assertEqual(len(found), 1, found)
        self.assertIn("Invoke-WebRequest -Uri", found[0][1])


if __name__ == "__main__":
    unittest.main()
