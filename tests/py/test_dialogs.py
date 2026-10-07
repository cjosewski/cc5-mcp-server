"""A command that opens a CC5 dialog: the caller hears about it at once, can read it, answer it, then read the job."""
from __future__ import annotations

import contextlib
import io
import os
import re
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

import _support
from test_auth import BridgeTestCase

LAYER_QUESTION = ("The target object layer already exists.\n"
                  "Do you want to replace the object, or the material only?")


class _QObject:
    """PySide2's QObject: inherits() answers by Qt class name, as QObject.inherits() does."""

    qt_classes: tuple = ()

    def inherits(self, class_name):
        return class_name in self.qt_classes


class _QmlView(_QObject):
    """A QQuickWidget, or a QWindowContainer around a QML window: the buttons it shows are QML items (F-99)."""

    def __init__(self, qt_class="QQuickWidget"):
        self.qt_classes = (qt_class, "QWidget", "QObject")


class _Label(_QObject):
    def __init__(self, text, visible=True):
        self._text, self._visible = text, visible

    def text(self):
        return self._text

    def isVisible(self):
        return self._visible


class _Button(_Label):
    def __init__(self, text, on_click=None, visible=True, enabled=True):
        super().__init__(text, visible)
        self._enabled, self._on_click = enabled, on_click
        self.clicked = 0

    def isEnabled(self):
        return self._enabled

    def click(self):
        self.clicked += 1
        if self._on_click:
            self._on_click(self)


class _CC5Dialog:
    """CC5's own dialog: a QDialog whose question sits in QLabels (not a QMessageBox). `children`: its other child
    objects (a QML view)."""

    def __init__(self, title, labels, buttons, children=()):
        self._title, self._labels, self._buttons, self._children = title, labels, buttons, list(children)

    def windowTitle(self):
        return self._title

    def findChildren(self, cls):
        if cls is _QObject:  # every child object: QObject.findChildren() searches the whole tree
            return [*self._labels, *self._buttons, *self._children]
        return list(self._labels if cls is _Label else self._buttons)


class _ProgressDialog(_CC5Dialog):
    """A QProgressDialog: a command's progress window, whatever its buttons say."""


def _fake_qt(singleshot_calls):
    widgets = types.ModuleType("PySide2.QtWidgets")
    widgets.QLabel, widgets.QPushButton = _Label, _Button
    widgets.QMessageBox = type("QMessageBox", (), {})
    widgets.QProgressDialog = _ProgressDialog
    core = types.ModuleType("PySide2.QtCore")
    class QTimer:
        """Fires on start(). Live, QTimer.singleShot(0, callable) never fired in CC5, so it must not be used."""
        singleShot = None

        def __init__(self):
            self._fns = []
            self.timeout = types.SimpleNamespace(connect=self._fns.append)

        def setSingleShot(self, flag):
            self.single = flag

        def start(self, ms):
            singleshot_calls.append(self)
            for fn in self._fns:
                fn()

    core.QTimer, core.QObject = QTimer, _QObject
    pkg = types.ModuleType("PySide2")
    pkg.QtWidgets, pkg.QtCore = widgets, core
    return {"PySide2": pkg, "PySide2.QtWidgets": widgets, "PySide2.QtCore": core}


class DialogTest(BridgeTestCase):
    def setUp(self):
        super().setUp()
        self.clicks: list = []
        p = mock.patch.dict(sys.modules, _fake_qt(self.clicks))
        p.start()
        self.addCleanup(p.stop)
        self.answer: list[str] = []
        self.dialog = None
        mw = mock.patch.object(self.srv, "_modal_widget", side_effect=lambda: self.dialog)
        mw.start()
        self.addCleanup(mw.stop)
        self.srv.DIALOG_REPORT_SECONDS = 0.2

        def close(button):
            self.answer.append(button.text())
            self.dialog = None

        self.layer_dialog = _CC5Dialog(
            "Character Creator 5",
            [_Label("The target object layer already exists."),
             _Label("Do you want to replace the object, or the material only?"),
             _Label("hidden", visible=False)],
            [_Button("&Replace", close), _Button("Material Only", close), _Button("Cancel", close),
             _Button("Help", visible=False)])

        def load_eyes(p):
            # Like RFileIO.LoadFile: CC5 opens its question and runs a nested event loop until it is answered.
            self.dialog = self.layer_dialog
            end = time.monotonic() + 10
            while self.dialog is not None and time.monotonic() < end:
                # Inside the dialog's nested loop only the dialog timer fires: Qt never re-fires the command
                # timer whose callback is running this very command.
                self.srv.process_dialog_lane()
                time.sleep(0.01)
            return {"success": True, "answer": self.answer[-1] if self.answer else None}

        self.srv.ACTION_MAP["load_eyes"] = load_eyes

    def test_describes_cc5_dialogs_from_their_labels_and_buttons(self):
        self.dialog = self.layer_dialog
        self.assertEqual(self.srv._describe_modal(), {
            "title": "Character Creator 5", "text": LAYER_QUESTION,
            "buttons": ["Replace", "Material Only", "Cancel"], "text_read": True, "progress": False,
            "buttons_unreadable": False})

    def test_plain_strips_rich_text(self):
        self.assertEqual(self.srv._plain("<p>Save <b>Kevin</b>?</p><p>Tom &amp; Jerry</p>"), "Save Kevin?\nTom & Jerry")

    def test_caller_hears_about_the_dialog_answers_it_and_reads_the_job(self):
        started = time.monotonic()
        status, body = self.srv._execute_sync("load_eyes", {}, timeout=30)
        self.assertLess(time.monotonic() - started, 5)  # not the full 30 s timeout
        self.assertEqual(status, 409)
        self.assertEqual(body["state"], "waiting_for_dialog")
        self.assertEqual(body["dialog"]["buttons"], ["Replace", "Material Only", "Cancel"])
        job_id = body["job_id"]
        self.assertIn(f'job_status("{job_id}")', body["error"])
        self.assertIn("Buttons: Replace, Material Only, Cancel", body["error"])
        self.assertIn("The target object layer already exists. Do you want to replace", body["error"])

        # While the command still waits inside the dialog, the dialog lane answers.
        status, seen = self.srv._execute_sync("get_dialog", {}, timeout=5)
        self.assertEqual(status, 200)
        self.assertEqual(seen["result"]["waiting_job"], job_id)
        self.assertEqual(seen["result"]["dialog"]["title"], "Character Creator 5")

        status, clicked = self.srv._execute_sync("answer_dialog", {"button": "material only"}, timeout=5)
        self.assertEqual(status, 200)
        self.assertEqual(clicked["result"]["clicked"], "Material Only")
        # Clicked directly, in the same call: live, deferred clicks never reached CC5's QMessageBox.
        self.assertEqual(self.clicks, [])  # no QTimer was used
        self.assertEqual(self.answer, ["Material Only"])

        end = time.monotonic() + 5
        job: dict = {}
        while time.monotonic() < end:
            job = self.srv._job_status(job_id)[1]["result"]
            if job["status"] in ("done", "failed"):
                break
            time.sleep(0.02)
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["result"], {"success": True, "answer": "Material Only"})
        # F-98: the job the direct call became keeps the answer given in it.
        self.assertEqual(job["answers"], [{"button": "Material Only", "title": "Character Creator 5"}])

    def test_answer_with_an_unknown_button_lists_the_buttons(self):
        self.dialog = self.layer_dialog
        r = self.srv.answer_dialog("OK")
        self.assertFalse(r["success"])
        self.assertEqual(r["error"], 'No single button "OK" in the dialog. Buttons: Replace, Material Only, Cancel')
        self.assertEqual([b.clicked for b in self.layer_dialog._buttons], [0, 0, 0, 0])

    def test_hidden_and_disabled_buttons_cannot_be_clicked(self):
        self.dialog = self.layer_dialog
        self.assertFalse(self.srv.answer_dialog("Help")["success"])

    def test_answer_without_a_dialog(self):
        self.assertEqual(self.srv.answer_dialog("OK"), {"success": False, "error": "No CC5 dialog is open"})

    def test_the_crash_recovery_prompt_is_the_users_to_answer(self):
        self.dialog = _CC5Dialog("Character Creator 5", [_Label("Unsaved project data found. Would you like to "
                                                                "update your project with the unsaved changes?")],
                                 [_Button("OK"), _Button("Cancel")])
        r = self.srv.answer_dialog("OK")
        self.assertFalse(r["success"])
        self.assertIn("user's decision", r["error"])
        self.assertEqual([b.clicked for b in self.dialog._buttons], [0, 0])

    def test_the_recovery_prompt_is_refused_wherever_its_words_sit(self):
        self.dialog = _CC5Dialog("Character Creator 5",
                                 [_Label("Character Creator 5 closed unexpectedly."),
                                  _Label("Unsaved project data found. Would you like to update your project?")],
                                 [_Button("OK"), _Button("Cancel")])
        self.assertIn("user's decision", self.srv.answer_dialog("OK")["error"])
        self.dialog = _CC5Dialog("Unsaved Project Data Found", [], [_Button("OK")])
        self.assertFalse(self.srv.answer_dialog("OK")["success"])
        self.assertEqual(self.dialog._buttons[0].clicked, 0)

    def _recovery_prompt(self):
        self.dialog = _CC5Dialog("Character Creator 5", [_Label("Unsaved project data found. Would you like to "
                                                                "update your project with the unsaved changes?")],
                                 [_Button("OK"), _Button("Cancel")])
        return self.dialog

    def test_recovery_policy_defaults_to_ask(self):
        with mock.patch.dict("os.environ", {"CC5_RECOVERY_ANSWER": ""}):
            self.assertEqual(self.srv._recovery_policy(), "ask")
        with mock.patch.dict("os.environ", {"CC5_RECOVERY_ANSWER": "yes please"}):
            self.assertEqual(self.srv._recovery_policy(), "ask")
        with mock.patch.dict("os.environ", {"CC5_RECOVERY_ANSWER": " Cancel "}):
            self.assertEqual(self.srv._recovery_policy(), "cancel")

    def test_the_lane_answers_the_recovery_prompt_with_the_configured_button(self):
        # Chad, 2026-10-05 (F-52): when Claude launched CC5, the prompt is answered Cancel automatically.
        prompt = self._recovery_prompt()
        with mock.patch.object(self.srv, "RECOVERY_ANSWER", "cancel"):
            self.srv.process_dialog_lane()
            self.assertEqual([b.clicked for b in prompt._buttons], [0, 1])
            r = self.srv.get_dialog()
        self.assertEqual(r["recovery_policy"], "cancel")
        self.assertEqual(r["recovery_answered"][-1]["button"], "Cancel")
        self.assertIn("Unsaved project data found", r["recovery_answered"][-1]["text"])

    def test_the_lane_leaves_the_recovery_prompt_alone_by_default(self):
        prompt = self._recovery_prompt()
        with mock.patch.object(self.srv, "RECOVERY_ANSWER", "ask"):
            self.srv.process_dialog_lane()
        self.assertEqual([b.clicked for b in prompt._buttons], [0, 0])

    def test_the_lane_never_answers_another_dialog(self):
        self.dialog = self.layer_dialog
        with mock.patch.object(self.srv, "RECOVERY_ANSWER", "cancel"):
            self.srv.process_dialog_lane()
        self.assertEqual([b.clicked for b in self.layer_dialog._buttons], [0, 0, 0, 0])

    def test_the_lane_stops_watching_after_startup(self):
        prompt = self._recovery_prompt()
        with mock.patch.object(self.srv, "RECOVERY_ANSWER", "cancel"), \
                mock.patch.object(self.srv, "_recovery_watch_started", self.srv.time.monotonic() - 10_000):
            self.srv.process_dialog_lane()
        self.assertEqual([b.clicked for b in prompt._buttons], [0, 0])

    def test_a_failed_automatic_click_does_not_stop_the_lane(self):
        prompt = self._recovery_prompt()
        prompt._buttons[1].click = mock.Mock(side_effect=RuntimeError("wrapped C/C++ object has been deleted"))
        with mock.patch.object(self.srv, "RECOVERY_ANSWER", "cancel"),                 mock.patch.object(self.srv, "_drain_dialog_queue") as drain:
            self.srv.process_dialog_lane()
        drain.assert_called_once()
        self.assertNotIn("recovery_answered", self.srv.get_dialog())

    def test_an_unreadable_prompt_is_never_answered_automatically(self):
        class Unreadable(_CC5Dialog):
            def findChildren(self, cls):
                if cls is _Label:
                    raise RuntimeError("deleted")
                return super().findChildren(cls)
        self.dialog = Unreadable("Unsaved project data found", [], [_Button("OK"), _Button("Cancel")])
        with mock.patch.object(self.srv, "RECOVERY_ANSWER", "cancel"):
            self.srv.process_dialog_lane()
        self.assertEqual([b.clicked for b in self.dialog._buttons], [0, 0])

    def test_answer_dialog_may_give_only_the_configured_recovery_answer(self):
        prompt = self._recovery_prompt()
        with mock.patch.object(self.srv, "RECOVERY_ANSWER", "cancel"):
            refused = self.srv.answer_dialog("OK")
            self.assertFalse(refused["success"])
            self.assertIn('may only be answered "Cancel"', refused["error"])
            self.assertTrue(self.srv.answer_dialog("Cancel")["success"])
        self.assertEqual([b.clicked for b in prompt._buttons], [0, 1])

    def _progress_window(self):
        # A command's own progress window: only Cancel (F-56: an export's would be reported as a question).
        self.dialog = _CC5Dialog("Exporting", [_Label("Exporting FBX...")], [_Button("Cancel")])
        return self.dialog

    def test_get_dialog_marks_a_progress_window(self):
        self._progress_window()
        view = self.srv.get_dialog()["dialog"]
        self.assertTrue(view["progress"])
        self.dialog = self.layer_dialog
        self.assertFalse(self.srv.get_dialog()["dialog"]["progress"])

    def test_answer_dialog_will_not_cancel_a_progress_window(self):
        window = self._progress_window()
        r = self.srv.answer_dialog("Cancel")
        self.assertFalse(r["success"])
        self.assertIn("progress window", r["error"])
        self.assertEqual(window._buttons[0].clicked, 0)

    def test_a_qprogressdialog_is_a_progress_window_whatever_its_button_says(self):
        # F-56: only the QProgressDialog check catches a progress window whose button is "Abort", not "Cancel".
        window = _ProgressDialog("Exporting", [_Label("Exporting FBX... 40%")], [_Button("Abort")])
        self.dialog = window
        self.assertTrue(self.srv._describe_modal()["progress"])
        self.assertTrue(self.srv.get_dialog()["dialog"]["progress"])
        r = self.srv.answer_dialog("Abort")
        self.assertFalse(r["success"])
        self.assertIn("progress window", r["error"])
        self.assertEqual(window._buttons[0].clicked, 0)
        self.dialog = None  # closed again: a window already open when a command is queued holds it (modal guard)

        def export(p):
            self.dialog = window
            end = time.monotonic() + 0.8
            while time.monotonic() < end:
                self.srv.process_dialog_lane()
                time.sleep(0.01)
            self.dialog = None
            return {"success": True}

        self.srv.ACTION_MAP["export"] = export
        status, body = self.srv._execute_sync("export", {}, timeout=10)
        self.assertEqual((status, body["result"]), (200, {"success": True}))  # not a 409 "waiting for an answer"

    def test_refuses_a_dialog_whose_text_cannot_be_read(self):
        class Unreadable(_CC5Dialog):
            def findChildren(self, cls):
                if cls is _Label:
                    raise RuntimeError("wrapped C/C++ object has been deleted")
                return super().findChildren(cls)
        self.dialog = Unreadable("Character Creator 5", [], [_Button("OK")])
        r = self.srv.answer_dialog("OK")
        self.assertFalse(r["success"])
        self.assertIn("could not be read", r["error"])
        self.assertEqual(self.dialog._buttons[0].clicked, 0)

    def test_expect_guards_against_answering_the_wrong_dialog(self):
        self.dialog = self.layer_dialog
        wrong = self.srv.answer_dialog("Cancel", expect="Delete Kevin?")
        self.assertFalse(wrong["success"])
        self.assertIn("not the one expected", wrong["error"])
        right = self.srv.answer_dialog("Material Only", expect="target object  layer already EXISTS")
        self.assertTrue(right["success"], right)
        self.assertEqual(self.answer, ["Material Only"])

    def test_plugin_driven_dialogs_are_left_to_their_tool(self):
        self.dialog = _CC5Dialog("Create Mixer Assets", [_Label("Name")], [_Button("Create"), _Button("Cancel")])
        r = self.srv.answer_dialog("Create")
        self.assertFalse(r["success"])
        self.assertIn("driven by its own tool", r["error"])

    def test_a_progress_window_is_not_a_question(self):
        self.assertFalse(self.srv._is_question({"buttons": ["Cancel"], "progress": False}))
        self.assertFalse(self.srv._is_question({"buttons": ["Stop", "Go"], "progress": True}))
        self.assertTrue(self.srv._is_question({"buttons": ["OK"], "progress": False}))

        progress = _CC5Dialog("Loading", [_Label("Loading Kevin... 40%")], [_Button("Cancel")])

        def slow_load(p):
            self.dialog = progress
            end = time.monotonic() + 0.8
            while time.monotonic() < end:
                self.srv.process_dialog_lane()
                time.sleep(0.01)
            self.dialog = None
            return {"success": True}

        self.srv.ACTION_MAP["slow_load"] = slow_load
        status, body = self.srv._execute_sync("slow_load", {}, timeout=10)
        self.assertEqual((status, body["result"]), (200, {"success": True}))

    def test_a_job_waiting_on_a_dialog_reports_it(self):
        _, body = self.srv._start_job("load_eyes", {})
        job_id = body["result"]["job_id"]
        end = time.monotonic() + 5
        job: dict = {}
        while time.monotonic() < end:
            job = self.srv._job_status(job_id)[1]["result"]
            if "dialog" in job:
                break
            time.sleep(0.02)
        self.assertEqual(job["status"], "running")
        self.assertEqual(job["dialog"]["buttons"], ["Replace", "Material Only", "Cancel"])
        self.assertIn(f'job_status("{job_id}")', job["dialog_message"])
        self.srv._execute_sync("answer_dialog", {"button": "Replace"}, timeout=5)
        while time.monotonic() < end + 5:
            job = self.srv._job_status(job_id)[1]["result"]
            if job["status"] == "done":
                break
            time.sleep(0.02)
        self.assertEqual(job["result"], {"success": True, "answer": "&Replace"})  # the button's raw Qt label
        self.assertNotIn("dialog", job)

    def test_a_job_queued_behind_a_dialog_says_so_and_runs_after_the_answer(self):
        # C2b review: a job queued behind another command's dialog said "Still running" with no word of the question,
        # so a recipe's later steps each waited their full budget.
        self.srv.ACTION_MAP["later"] = lambda p: {"success": True, "ran": "later"}
        first = self.srv._start_job("load_eyes", {})[1]["result"]["job_id"]
        second = self.srv._start_job("later", {})[1]["result"]["job_id"]
        end = time.monotonic() + 5
        job: dict = {}
        while time.monotonic() < end:
            job = self.srv._job_status(second)[1]["result"]
            if "dialog_message" in job:
                break
            time.sleep(0.02)
        self.assertEqual((job["status"], job.get("blocked_by")), ("queued", first))
        self.assertTrue(job["dialog_message"].startswith(
            f"Job {second} has not started: it is queued behind job {first}. CC5 is waiting for an answer to "
            '"The target object layer already exists. Do you want to replace the object, or the material only?"'),
            job["dialog_message"])
        self.assertTrue(job["dialog_message"].endswith(
            f'Job {second} runs after that answer; read its result with job_status("{second}").'))
        self.assertEqual(job["dialog"]["buttons"], ["Replace", "Material Only", "Cancel"])
        self.srv._execute_sync("answer_dialog", {"button": "Replace"}, timeout=5)
        while time.monotonic() < end + 5:
            job = self.srv._job_status(second)[1]["result"]
            if job["status"] == "done":
                break
            time.sleep(0.02)
        self.assertEqual(job["result"], {"success": True, "ran": "later"})
        self.assertNotIn("dialog_message", job)

    def test_a_dialog_command_being_run_is_never_reported_cancelled(self):
        gate = threading.Event()
        self.srv.ACTION_MAP["get_dialog"] = lambda p: gate.wait(2) and {"success": True}
        status, body = self.srv._execute_sync("get_dialog", {}, timeout=0.3)
        gate.set()
        self.assertEqual((status, body["state"]), (504, "running"))
        self.assertEqual(self.srv._cancelled, set())

    def test_get_dialog_when_none_is_open(self):
        self.assertEqual(self.srv.get_dialog(), {"success": True, "dialog": None, "waiting_job": None,
                                                  "recovery_policy": "ask"})

    # Live CC5 5.13 (F-84, F-85): SkinGen's About box ("CCSkinGen") has no buttons, and one label shows the licence
    # serial. A made-up serial here; the real one is never written anywhere.
    SERIAL = "ABCDE-12345-FGHIJ-67890"
    ABOUT_TEXT = "S/N : (serial)\nProduct Version : 1.0.0824.1\nwww.reallusion.com"

    def _about_box(self):
        return _CC5Dialog("CCSkinGen", [_Label(f"S/N : {self.SERIAL}"), _Label("Product Version : 1.0.0824.1"),
                                        _Label("www.reallusion.com")], [])

    def test_get_dialog_shows_the_about_box_with_its_serial_redacted(self):
        self.dialog = self._about_box()
        r = self.srv.get_dialog()
        self.assertEqual(r["dialog"], {"title": "CCSkinGen", "text": self.ABOUT_TEXT, "buttons": [], "text_read": True,
                                       "progress": False})
        self.assertNotIn(self.SERIAL, repr(r))

    def test_the_queue_guard_names_the_about_box_and_never_its_text(self):
        self.dialog = self._about_box()
        self.srv.MODAL_WAIT_SECONDS = 0.2
        status, body = self.srv._execute_sync("ping", {}, timeout=5)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], 'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character '
                                        "Creator 5 (no MCP tool can close it), then try again.")

    def test_a_command_waiting_in_the_about_box_is_told_to_close_it_with_its_serial_redacted(self):
        # The dialog lane still reports a command's own window with no buttons (_is_question is unchanged); its
        # text is redacted in the 409 reply and in job_status. Review #7 / #19: answer_cc5_dialog has nothing to click
        # there, so the caller is told to close it, as the queue guard words it (F-84: bake_skin_textures opened it).
        about = self._about_box()

        def opens_about(p):
            self.dialog = about
            end = time.monotonic() + 10
            while self.dialog is not None and time.monotonic() < end:
                self.srv.process_dialog_lane()
                time.sleep(0.01)
            return {"success": True}

        self.srv.ACTION_MAP["opens_about"] = opens_about
        status, body = self.srv._execute_sync("opens_about", {}, timeout=30)
        self.assertEqual(status, 409)
        job_id = body["job_id"]
        self.assertEqual(body["dialog"], {"title": "CCSkinGen", "text": self.ABOUT_TEXT, "buttons": [], "text_read": True})
        closing = (f'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool '
                   f'can close it). The command is still running as job {job_id}: read its result with '
                   f'job_status("{job_id}") once it is closed.')
        self.assertEqual(body["error"], closing)
        job = self.srv._job_status(job_id)[1]["result"]
        self.assertEqual(job["dialog"]["text"], self.ABOUT_TEXT)
        self.assertEqual(job["dialog_message"], closing)
        self.assertNotIn(self.SERIAL, repr(body) + repr(job))
        self.dialog = None  # closed in CC5: the command finishes
        self.assertEqual(self._job_when(job_id, lambda j: j["status"] == "done")["status"], "done")

    def _job_when(self, job_id, ready, seconds=5.0):
        """The job's status once `ready(job)` holds, or after `seconds`."""
        end = time.monotonic() + seconds
        job = self.srv._job_status(job_id)[1]["result"]
        while not ready(job) and time.monotonic() < end:
            time.sleep(0.02)
            job = self.srv._job_status(job_id)[1]["result"]
        return job

    def _wait_in(self, window):
        """A command that opens `window` and waits in it, as LoadFile waits in CC5's question, until it is closed."""
        self.dialog = window
        end = time.monotonic() + 10
        while self.dialog is not None and time.monotonic() < end:
            self.srv.process_dialog_lane()  # inside the dialog's nested loop only the dialog timer fires
            time.sleep(0.01)
        return {"success": True}

    def _job_waiting_in(self, window):
        """Start a job whose command opens `window` and waits in it; its id, once job_status reports the window."""
        self.srv.ACTION_MAP["opens"] = lambda p: self._wait_in(window)
        job_id = self.srv._start_job("opens", {})[1]["result"]["job_id"]
        self.assertIn("dialog", self._job_when(job_id, lambda j: "dialog" in j))
        return job_id

    def _close_and_finish(self, job_id):
        self.dialog = None  # closed in CC5: the command finishes
        self.assertEqual(self._job_when(job_id, lambda j: j["status"] == "done")["status"], "done")

    def test_a_job_queued_behind_a_window_to_close_runs_once_it_is_closed(self):
        self.srv.ACTION_MAP["later"] = lambda p: {"success": True}
        first = self._job_waiting_in(self._about_box())
        second = self.srv._start_job("later", {})[1]["result"]["job_id"]
        job = self._job_when(second, lambda j: "dialog_message" in j)
        self.assertEqual((job["status"], job.get("blocked_by")), ("queued", first))
        self.assertEqual(job["dialog_message"], (
            f'Job {second} has not started: it is queued behind job {first}. CC5 has a window open with no buttons: '
            f'"CCSkinGen" - close it in Character Creator 5 (no MCP tool can close it). The command is still running as '
            f'job {first}: read its result with job_status("{first}") once it is closed. Job {second} runs once that '
            f'window is closed; read its result with job_status("{second}").'))
        self._close_and_finish(first)
        self.assertEqual(self._job_when(second, lambda j: j["status"] == "done")["result"], {"success": True})

    def test_a_command_waiting_in_an_untitled_window_names_the_welcome_page(self):
        # F-94: CC5's Welcome / What's New page is untitled and has no text; worded as the queue guard words it.
        job_id = self._job_waiting_in(_CC5Dialog("", [], []))
        self.assertEqual(self.srv._job_status(job_id)[1]["result"]["dialog_message"], (
            "CC5's Welcome / What's New page (or another untitled CC5 window) is open - close it in Character Creator 5 "
            f"(tick \"Don't show this again\" so it stays closed). The command is still running as job {job_id}: read "
            f'its result with job_status("{job_id}") once it is closed.'))
        self._close_and_finish(job_id)

    def test_a_command_waiting_in_a_dialog_whose_text_could_not_be_read_goes_to_the_user(self):
        # answer_dialog refuses such a dialog (it may be the crash-recovery prompt), so the caller is not told to use it.
        class Unreadable(_CC5Dialog):
            def findChildren(self, cls):
                if cls is _Label:
                    raise RuntimeError("wrapped C/C++ object has been deleted")
                return super().findChildren(cls)

        job_id = self._job_waiting_in(Unreadable("Character Creator 5", [], [_Button("OK")]))
        job = self.srv._job_status(job_id)[1]["result"]
        self.assertFalse(job["dialog"]["text_read"])
        self.assertEqual(job["dialog_message"], (
            f'CC5 is waiting for an answer to "Character Creator 5". Buttons: OK. The command is still running as job '
            f'{job_id}: its text could not be read, so ask the user to answer it in CC5, then check its result with '
            f'job_status("{job_id}").'))
        self._close_and_finish(job_id)

    def test_an_untitled_window_whose_text_could_not_be_read_is_never_named_the_welcome_page(self):
        # Only a window whose text was read and is empty is CC5's Welcome page. One whose labels could not be read
        # may be any question, the crash-recovery prompt too: the queue guard sends it to the user, as the waiting text
        # does (before, the guard named it the Welcome page and said to close it).
        class Unreadable(_CC5Dialog):
            def findChildren(self, cls):
                if cls is _Label:
                    raise RuntimeError("wrapped C/C++ object has been deleted")
                return super().findChildren(cls)

        window = Unreadable("", [], [])
        self.dialog = window
        self.assertFalse(self.srv._describe_modal()["text_read"])
        self.srv.MODAL_WAIT_SECONDS = 0.2
        status, body = self.srv._execute_sync("ping", {}, timeout=5)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], 'CC5 is waiting for an answer to "a dialog" - its text could not be read, so '
                                        "ask the user to answer it in CC5, then try again.")
        self.dialog = None  # closed: a window already open when a command is queued holds it (the guard above)
        job_id = self._job_waiting_in(window)
        self.assertEqual(self.srv._job_status(job_id)[1]["result"]["dialog_message"], (
            f'CC5 is waiting for an answer to "a dialog". Buttons: none found. The command is still running as job '
            f'{job_id}: its text could not be read, so ask the user to answer it in CC5, then check its result with '
            f'job_status("{job_id}").'))
        self._close_and_finish(job_id)

    def test_a_command_waiting_in_the_recovery_prompt_is_never_told_to_close_it(self):
        # Closing it decides about the user's unsaved work: it stays a question even when its buttons could not be read.
        prompt = _CC5Dialog("Character Creator 5", [_Label("Unsaved project data found. Would you like to update your "
                                                           "project with the unsaved changes?")], [])
        with mock.patch.object(self.srv, "RECOVERY_ANSWER", "ask"):
            job_id = self._job_waiting_in(prompt)
            message = self.srv._job_status(job_id)[1]["result"]["dialog_message"]
        self.assertEqual(message, (
            'CC5 is waiting for an answer to "Unsaved project data found. Would you like to update your project with the '
            'unsaved changes?" (the "Character Creator 5" window). Buttons: none found. The command is still running as '
            f'job {job_id}: the user must answer it in CC5, then check its result with job_status("{job_id}").'))
        self._close_and_finish(job_id)

    # F-99 (live CC5 5.13): CC5's Export FBX dialog (IC::CFbxExportDialog) is one QQuickWidget: its buttons are QML items,
    # and its only button widget is the title bar's unlabelled close button.
    def _export_fbx_dialog(self, qt_class="QQuickWidget"):
        return _CC5Dialog("Export FBX", [], [_Button("")], children=[_QmlView(qt_class)])

    def test_a_qml_dialog_is_one_whose_buttons_cannot_be_read(self):
        for qt_class in ("QQuickWidget", "QWindowContainer"):
            with self.subTest(qt_class=qt_class):
                self.dialog = self._export_fbx_dialog(qt_class)
                self.assertEqual(self.srv._describe_modal(), {
                    "title": "Export FBX", "text": "", "buttons": [], "text_read": True, "progress": False,
                    "buttons_unreadable": True})
        # A window with a button the bridge can click, or with no QML part (SkinGen's About box), is not.
        self.dialog = _CC5Dialog("Export FBX", [], [_Button("Export")], children=[_QmlView()])
        self.assertFalse(self.srv._describe_modal()["buttons_unreadable"])
        self.dialog = self._about_box()
        self.assertFalse(self.srv._describe_modal()["buttons_unreadable"])

    def test_get_dialog_says_whether_the_buttons_and_the_text_could_be_read(self):
        self.dialog = self._export_fbx_dialog()
        self.assertEqual(self.srv.get_dialog()["dialog"], {"title": "Export FBX", "text": "", "buttons": [],
                                                           "text_read": True, "buttons_unreadable": True,
                                                           "progress": False})
        self.dialog = self.layer_dialog
        view = self.srv.get_dialog()["dialog"]
        self.assertNotIn("buttons_unreadable", view)  # only when set
        self.assertTrue(view["text_read"])

        # Review #8: the tools word a dialog whose text could not be read as the queue guard does.
        class Unreadable(_CC5Dialog):
            def findChildren(self, cls):
                if cls is _Label:
                    raise RuntimeError("wrapped C/C++ object has been deleted")
                return super().findChildren(cls)

        self.dialog = Unreadable("Character Creator 5", [], [])
        self.assertEqual(self.srv.get_dialog()["dialog"], {"title": "Character Creator 5", "text": "", "buttons": [],
                                                           "text_read": False, "progress": False})

    def test_answer_dialog_refuses_a_qml_dialog(self):
        window = self._export_fbx_dialog()
        self.dialog = window
        self.assertEqual(self.srv.answer_dialog("Export"), {"success": False, "error": (
            'CC5 has a window open whose buttons this bridge cannot read: "Export FBX" - answer or close it in '
            "Character Creator 5 (no MCP tool can click its buttons).")})
        self.assertEqual(window._buttons[0].clicked, 0)

    def test_a_command_waiting_in_a_qml_dialog_is_told_to_answer_or_close_it_in_cc5(self):
        job_id = self._job_waiting_in(self._export_fbx_dialog())
        job = self.srv._job_status(job_id)[1]["result"]
        self.assertEqual(job["dialog"], {"title": "Export FBX", "text": "", "buttons": [], "text_read": True,
                                         "buttons_unreadable": True})
        self.assertEqual(job["dialog_message"], (
            'CC5 has a window open whose buttons this bridge cannot read: "Export FBX" - answer or close it in Character '
            f"Creator 5 (no MCP tool can click its buttons). The command is still running as job {job_id}: read its "
            f'result with job_status("{job_id}") once it is closed.'))
        self._close_and_finish(job_id)

    # F-98 (live): after the user's Cancel in Replace / Material Only, the continued recipe reported the step OK although
    # CC5 applied nothing. The job waiting in the dialog now keeps what was clicked in it.

    def test_an_answer_is_recorded_on_the_job_waiting_in_the_dialog_and_no_other(self):
        self.srv.ACTION_MAP["later"] = lambda p: {"success": True}
        waiting = self.srv._start_job("load_eyes", {})[1]["result"]["job_id"]
        other = self.srv._start_job("later", {})[1]["result"]["job_id"]
        self._job_when(waiting, lambda j: "dialog" in j)
        status, body = self.srv._execute_sync("answer_dialog", {"button": "replace"}, timeout=5)
        self.assertEqual((status, body["result"]["clicked"]), (200, "Replace"))
        job = self._job_when(waiting, lambda j: j["status"] == "done")
        self.assertEqual(job["result"], {"success": True, "answer": "&Replace"})  # the button's raw Qt label
        self.assertEqual(job["answers"], [{"button": "Replace", "title": "Character Creator 5"}])  # its plain label
        self.assertNotIn("answers", self._job_when(other, lambda j: j["status"] == "done"))
        _, polled = self.post("/jobs/status", {"job_id": waiting})  # what the MCP server reads
        self.assertEqual(polled["result"]["answers"], [{"button": "Replace", "title": "Character Creator 5"}])

    def test_an_answer_with_no_command_waiting_is_recorded_on_no_job(self):
        self.srv.ACTION_MAP["earlier"] = lambda p: {"success": True}
        job_id = self.srv._start_job("earlier", {})[1]["result"]["job_id"]
        self._job_when(job_id, lambda j: j["status"] == "done")
        self.dialog = self.layer_dialog  # a dialog no command waits in (the user's own)
        self.assertTrue(self.srv.answer_dialog("Replace")["success"])
        self.assertNotIn("answers", self.srv._job_status(job_id)[1]["result"])

    def test_the_recovery_prompt_answered_by_the_lane_is_recorded_on_no_job(self):
        def close(button):
            self.dialog = None

        prompt = _CC5Dialog("Character Creator 5", [_Label("Unsaved project data found. Would you like to update your "
                                                           "project with the unsaved changes?")],
                            [_Button("OK", close), _Button("Cancel", close)])
        self.srv.ACTION_MAP["opens_prompt"] = lambda p: self._wait_in(prompt)
        with mock.patch.object(self.srv, "RECOVERY_ANSWER", "cancel"):
            job_id = self.srv._start_job("opens_prompt", {})[1]["result"]["job_id"]
            job = self._job_when(job_id, lambda j: j["status"] == "done")
        self.assertEqual(job["status"], "done")
        self.assertEqual([b.clicked for b in prompt._buttons], [0, 1])  # the lane answered Cancel (F-52)
        self.assertNotIn("answers", job)

    # P-4 / DT-4: a form shows the label and the serial in two labels, and a QMessageBox can end its text with the
    # label and hold the serial in its informative text. Made-up keys only.

    def test_a_serial_in_the_label_after_its_label_is_redacted(self):
        for labels, text in (
                (["Serial Number:", "XK29QZ7731ABCD"], "Serial Number:\n(serial)"),
                (["S/N", "XK29QZ7731"], "S/N\n(serial)"),
                # No digit and no ':': only a label line on its own marks the next label as the value.
                (["Licence Key", "QWERTYUIOPASDF", "Product Version : 1.0.0824.1"],
                 "Licence Key\n(serial)\nProduct Version : 1.0.0824.1"),
                # The label ends a longer label: the joined text is redacted again.
                (["Enter your Serial Number:", "XK29QZ7731ABCD"], "Enter your Serial Number:\n(serial)"),
                (["Your S/N", "XK29QZ7731"], "Your S/N\n(serial)")):
            with self.subTest(labels=labels):
                self.dialog = _CC5Dialog("Activation", [_Label(t) for t in labels], [_Button("OK")])
                self.assertEqual(self.srv._describe_modal()["text"], text)
                r = self.srv.get_dialog()
                self.assertEqual(r["dialog"]["text"], text)
                self.assertNotIn(labels[1], repr(r))

    def test_a_message_box_with_the_serial_in_its_informative_text_is_redacted(self):
        qt = sys.modules["PySide2.QtWidgets"]

        class MessageBox(qt.QMessageBox, _CC5Dialog):
            def __init__(self, text, info):
                _CC5Dialog.__init__(self, "Activation", [], [_Button("OK")])
                self._text, self._info = text, info

            def text(self):
                return self._text

            def informativeText(self):
                return self._info

        for text, info, shown in (
                ("Character Creator 5 is activated.\nSerial Number:", "XK29QZ7731ABCD",
                 "Character Creator 5 is activated.\nSerial Number:\n(serial)"),
                ("Character Creator 5 is activated with this S/N", "XK29QZ7731",
                 "Character Creator 5 is activated with this S/N\n(serial)")):
            with self.subTest(text=text):
                self.dialog = MessageBox(text, info)
                described = self.srv._describe_modal()
                self.assertEqual((described["text"], described["buttons"]), (shown, ["OK"]))
                r = self.srv.get_dialog()
                self.assertEqual(r["dialog"]["text"], shown)
                self.assertNotIn(info, repr(r))

    def test_text_without_a_serial_keeps_every_label(self):
        self.dialog = _CC5Dialog("Character Creator 5", [_Label("This content requires a license."),
                                                         _Label("Do you want to buy it now?")],
                                 [_Button("Yes"), _Button("No")])
        self.assertEqual(self.srv.get_dialog()["dialog"]["text"],
                         "This content requires a license.\nDo you want to buy it now?")

    def test_bad_button_argument(self):
        for bad in (None, "", "   ", 5, "x" * 101):
            self.assertFalse(self.srv.answer_dialog(bad)["success"], bad)

    def test_dialog_actions_cannot_run_as_jobs(self):
        for action in ("get_dialog", "answer_dialog"):
            self.assertEqual(self.srv._start_job(action, {"button": "OK"})[0], 400)

    def test_dialog_lane_serves_while_the_command_queue_is_blocked(self):
        gate = threading.Event()
        self.srv.ACTION_MAP["busy"] = lambda p: self._busy(gate)
        t = threading.Thread(target=self.srv._execute_sync, args=("busy", {}, 10))
        t.start()
        time.sleep(0.1)
        status, body = self.srv._execute_sync("get_dialog", {}, timeout=3)
        gate.set()
        t.join(5)
        self.assertEqual(status, 200)

    def _busy(self, gate):
        while not gate.is_set():
            self.srv.process_dialog_lane()
            time.sleep(0.01)
        return {"success": True}

    def test_a_command_without_a_dialog_is_unaffected(self):
        status, body = self.srv._execute_sync("ping", {}, timeout=5)
        self.assertEqual((status, body["result"]), (200, {"success": True, "pong": True}))

    def test_routes(self):
        self.assertEqual(self.srv.POST_ROUTES["/dialog"], "get_dialog")
        self.assertEqual(self.srv.POST_ROUTES["/dialog/answer"], "answer_dialog")
        self.assertEqual(self.srv.REQUIRED_PARAMS["answer_dialog"], ["button"])


class MainTimersTest(unittest.TestCase):
    """main.py must run the dialog lane on its own timer: Qt does not re-fire the command timer while its
    callback (a command waiting in a CC5 dialog) is still running."""

    def test_initialize_starts_a_separate_dialog_timer(self):
        started = []

        class QTimer:
            def __init__(self):
                self.timeout = types.SimpleNamespace(connect=lambda fn: setattr(self, "fn", fn))

            def start(self, ms):
                started.append((self.fn.__name__, ms))

            def stop(self):
                pass

        core = types.ModuleType("PySide2.QtCore")
        core.QTimer = QTimer
        pkg = types.ModuleType("PySide2")
        pkg.QtCore = core
        with mock.patch.dict(sys.modules, {"PySide2": pkg, "PySide2.QtCore": core}):
            sys.modules.pop("main", None)
            main = _support.fresh_import("main")
            with mock.patch.object(main.bridge_server, "start_server", return_value=mock.Mock()):
                main.initialize_plugin()
            names = dict(started)
            self.assertEqual(names["_on_timer"], 16)
            self.assertEqual(names["_on_dialog_timer"], 50)
            with mock.patch.object(main.bridge_server, "process_dialog_lane") as lane:
                main._on_dialog_timer()
            lane.assert_called_once()
            with mock.patch.object(main.bridge_server, "stop_server"):
                main.uninitialize_plugin()
            self.assertIsNone(main._dialog_timer)
        sys.modules.pop("main", None)

    def test_the_image_watch_starts_after_the_timers_and_stops_before_the_server(self):
        # F-104: the watch behind the queue's capture gate (server.start_image_watch / stop_image_watch).
        calls = []

        class QTimer:
            def __init__(self):
                self.timeout = types.SimpleNamespace(connect=lambda fn: setattr(self, "fn", fn))

            def start(self, ms):
                calls.append(f"timer {self.fn.__name__}")

            def stop(self):
                pass

        core = types.ModuleType("PySide2.QtCore")
        core.QTimer = QTimer
        pkg = types.ModuleType("PySide2")
        pkg.QtCore = core
        with mock.patch.dict(sys.modules, {"PySide2": pkg, "PySide2.QtCore": core}):
            sys.modules.pop("main", None)
            main = _support.fresh_import("main")
            srv = main.bridge_server
            with mock.patch.object(srv, "start_server", return_value=mock.Mock()), \
                    mock.patch.object(srv, "start_image_watch", side_effect=lambda: calls.append("watch") or True):
                main.initialize_plugin()
            self.assertEqual(calls, ["timer _on_timer", "timer _on_dialog_timer", "timer _on_health_timer", "watch"])
            calls.clear()
            with mock.patch.object(srv, "stop_image_watch", side_effect=lambda: calls.append("stop watch")), \
                    mock.patch.object(srv, "stop_server", side_effect=lambda: calls.append("stop server")):
                main.uninitialize_plugin()
            self.assertEqual(calls, ["stop watch", "stop server"])
        sys.modules.pop("main", None)



class RequestLogTest(unittest.TestCase):
    """Failed requests are written to requests.log, never printed (F-57: every request was printed from an HTTP
    thread; F-63: the failed ones still were, into CC5's console and a running exec_python's output)."""

    STAMP = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ")

    def setUp(self):
        _support.install_fake_rlpy()
        self.srv = _support.fresh_import("server")
        self.unpatched_path = self.srv._request_log_path
        self.log = os.path.join(tempfile.mkdtemp(), "requests.log")
        p = mock.patch.object(self.srv, "_request_log_path", return_value=self.log)
        p.start()
        self.addCleanup(p.stop)

    def _log(self, fmt, *args):
        with mock.patch("builtins.print") as printed:
            self.srv.BridgeHandler.log_message(mock.Mock(), fmt, *args)
        printed.assert_not_called()

    def _lines(self, path=None):
        path = path or self.log
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as f:
            return f.read().splitlines()

    def _texts(self, path=None):
        """The logged lines without their timestamps (each line must start with one)."""
        lines = self._lines(path)
        for line in lines:
            self.assertRegex(line, self.STAMP)
        return [line[len("YYYY-mm-dd HH:MM:SS "):] for line in lines]

    def test_successful_requests_and_redirects_write_nothing(self):
        self._log('"%s" %s %s', "GET /health HTTP/1.1", "200", "-")
        self._log('"%s" %s %s', "POST /dialog HTTP/1.1", "200", "-")
        self._log('"%s" %s %s', "GET /x HTTP/1.1", "304", "-")
        self.assertEqual(self._lines(), [])

    def test_failed_requests_and_errors_are_written_with_a_timestamp(self):
        self._log('"%s" %s %s', "POST /scene/delete HTTP/1.1", "400", "-")
        self._log("code %d, message %s", 404, "Not Found")
        self.assertEqual(self._texts(), ['"POST /scene/delete HTTP/1.1" 400 -', "code 404, message Not Found"])

    def test_errors_without_a_status_are_written(self):
        # BaseHTTPRequestHandler.log_error("Request timed out: %r", e) carries no status.
        self._log("Request timed out: %r", TimeoutError())
        self.assertEqual(self._texts(), ["Request timed out: TimeoutError()"])

    def test_nothing_reaches_a_redirected_stdout(self):
        # Live (F-63): a running exec_python's output held '"POST /exec/python HTTP/1.1" 409 -'.
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.srv.BridgeHandler.log_message(mock.Mock(), '"%s" %s %s', "GET /avatars HTTP/1.1", "400", "-")
        self.assertEqual(buf.getvalue(), "")
        self.assertEqual(self._texts(), ['"GET /avatars HTTP/1.1" 400 -'])

    def test_a_log_that_cannot_be_written_raises_nothing(self):
        blocker = os.path.join(tempfile.mkdtemp(), "a_file")
        open(blocker, "wb").close()
        with mock.patch.object(self.srv, "_request_log_path", return_value=os.path.join(blocker, "requests.log")):
            self._log('"%s" %s %s', "GET /avatars HTTP/1.1", "401", "-")  # no exception, nothing printed

    def test_the_log_moves_to_requests_log_1_past_its_size_limit(self):
        with mock.patch.object(self.srv, "REQUEST_LOG_MAX_BYTES", 10):
            self._log('"%s" %s %s', "GET /a HTTP/1.1", "404", "-")
            self._log('"%s" %s %s', "GET /b HTTP/1.1", "404", "-")
        self.assertEqual(self._texts(self.log + ".1"), ['"GET /a HTTP/1.1" 404 -'])
        self.assertEqual(self._texts(), ['"GET /b HTTP/1.1" 404 -'])

    def test_the_log_sits_next_to_the_token(self):
        self.assertEqual(self.unpatched_path(),
                         os.path.join(os.path.dirname(self.srv._token_path()), "requests.log"))


if __name__ == "__main__":
    unittest.main()
