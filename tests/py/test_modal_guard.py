from __future__ import annotations

import sys
import threading
import time
import types
import unittest
from unittest import mock

import _support
from test_auth import BridgeTestCase

RECOVERY = ("Character Creator 5",
            "Unsaved project data found. Would you like to update your project with the unsaved changes?")


class ModalGuardTest(BridgeTestCase):
    """Live CC5 crashed when the bridge ran an FBX export inside the nested event loop of a modal dialog
    (the crash-recovery prompt): commands wait while a modal dialog is open, then fail with its text."""

    def setUp(self):
        super().setUp()
        self.dialog = RECOVERY  # (title, text) of a readable OK/Cancel question, a full description, or None
        p = mock.patch.object(self.srv, "_describe_modal", side_effect=self._described)
        p.start()
        self.addCleanup(p.stop)
        self.ran: list[object] = []
        self.srv.ACTION_MAP["mark"] = lambda p: self.ran.append(self.dialog) or {"success": True}

    def _described(self):
        if self.dialog is None or isinstance(self.dialog, dict):
            return self.dialog
        title, text = self.dialog
        return {"title": title, "text": text, "buttons": ["OK", "Cancel"], "text_read": True, "progress": False}

    def test_waits_for_the_dialog_then_runs(self):
        threading.Timer(0.3, lambda: setattr(self, "dialog", None)).start()
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 200)
        self.assertEqual(self.ran, [None])  # ran only after the dialog closed

    def test_fails_with_the_dialog_text_when_it_stays_open(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 400)
        self.assertFalse(body["success"])
        self.assertEqual(self.ran, [])
        self.assertIn('CC5 is waiting for an answer to "Unsaved project data found. Would you like to update '
                      'your project with the unsaved changes?"', body["error"])
        self.assertIn('"Character Creator 5"', body["error"])
        self.assertIn("OK restores your last unsaved work, Cancel discards it", body["error"])
        self.assertTrue(body["error"].endswith("then try again."))

    def test_other_dialogs_get_no_recovery_hint(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        self.dialog = ("CCSkinGen", "")  # live: bake_skin_textures opens SkinGen's About box
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 400)
        # The guard runs only while no MCP command runs, so no command waits on this dialog: it may be the user's own,
        # and answering it is not a confirmation of something the user asked for (C2 review).
        self.assertEqual(body["error"], 'CC5 is waiting for an answer to "CCSkinGen" - no MCP command is waiting on it, '
                                        "so it is probably the user's own or CC5's: ask the user to answer or close it "
                                        "in CC5, then try again.")
        self.assertNotIn("Unsaved", body["error"])
        self.assertNotIn("answer_cc5_dialog", body["error"])

    def test_a_progress_window_is_reported_as_busy_not_as_a_question(self):
        # F-56: a command's progress window (an export's) is not a question, and its Cancel aborts that command.
        self.srv.MODAL_WAIT_SECONDS = 0.2
        for buttons, progress in ((["Cancel"], False), ([], True)):
            with self.subTest(buttons=buttons, progress=progress):
                self.dialog = {"title": "Exporting", "text": "Exporting FBX...", "buttons": buttons,
                               "text_read": True, "progress": progress}
                status, body = self.srv._execute_sync("mark", {}, timeout=5)
                self.assertEqual(status, 400)
                self.assertEqual(body["error"], 'CC5 is busy with "Exporting" (the progress window of a command it is '
                                                "running) - try again when it closes. Do not cancel it unless the user "
                                                "asks; they cancel it in CC5.")
        self.assertEqual(self.ran, [])

    def test_a_dialog_whose_text_could_not_be_read_goes_to_the_user(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        self.dialog = {"title": "Character Creator 5", "text": "", "buttons": ["OK", "Cancel"], "text_read": False,
                       "progress": False}
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], 'CC5 is waiting for an answer to "Character Creator 5" - its text could not be '
                                        "read, so ask the user to answer it in CC5, then try again.")

    def test_an_untitled_window_is_named_as_the_welcome_page(self):
        # Live CC5 5.13 can start with its full-screen Welcome / What's New page: untitled, with no text.
        self.srv.MODAL_WAIT_SECONDS = 0.2
        self.dialog = ("", "")
        status, body = self.srv._execute_sync("mark", {}, timeout=5)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "CC5's Welcome / What's New page (or another untitled CC5 window) is open - "
                                        "close it in Character Creator 5 (tick \"Don't show this again\" so it stays "
                                        "closed), then try again.")
        self.assertEqual(self.ran, [])

    def test_does_not_wait_longer_than_needed(self):
        self.srv.MODAL_WAIT_SECONDS = 0.3
        started = time.monotonic()
        self.srv._execute_sync("mark", {}, timeout=5)
        self.assertLess(time.monotonic() - started, 2)

    def test_a_job_fails_with_the_dialog_text(self):
        self.srv.MODAL_WAIT_SECONDS = 0.2
        _, body = self.srv._start_job("mark", {})
        job_id = body["result"]["job_id"]
        end = time.monotonic() + 5
        job: dict = {}
        while time.monotonic() < end:
            job = self.srv._job_status(job_id)[1]["result"]
            if job["status"] in ("done", "failed"):
                break
            time.sleep(0.02)
        self.assertEqual(job["status"], "failed")
        self.assertIn("Unsaved project data found", job["result"]["error"])
        self.assertEqual(self.ran, [])

    def test_commands_behind_the_waiting_one_keep_their_order(self):
        threading.Timer(0.3, lambda: setattr(self, "dialog", None)).start()
        order: list[str] = []
        self.srv.ACTION_MAP["first"] = lambda p: order.append("first") or {"success": True}
        self.srv.ACTION_MAP["second"] = lambda p: order.append("second") or {"success": True}
        t = threading.Thread(target=self.srv._execute_sync, args=("first", {}, 5))
        t.start()
        time.sleep(0.05)
        self.srv._execute_sync("second", {}, timeout=5)
        t.join(5)
        self.assertEqual(order, ["first", "second"])

    def test_actions_built_to_run_inside_their_own_dialog_are_not_held(self):
        self.srv.MODAL_WAIT_SECONDS = 30
        for action in ("silent_configure_and_click", "silent_finalize", "get_export_status",
                       "get_mixer_status", "exec_python"):
            with self.subTest(action=action):
                self.srv.ACTION_MAP[action] = lambda p, a=action: {"success": True, "ran": a}
                status, body = self.srv._execute_sync(action, {"code": "result=1"}, timeout=2)
                self.assertEqual((status, body["result"]["ran"]), (200, action))

    def test_waits_five_seconds_by_default(self):
        self.assertEqual(_support.fresh_import("server").MODAL_WAIT_SECONDS, 5.0)


class _Widget:
    def __init__(self, title="", visible=True, modal=True):
        self._title, self._visible, self._modal = title, visible, modal

    def windowTitle(self):
        return self._title

    def isVisible(self):
        return self._visible

    def isModal(self):
        return self._modal


class _Dialog(_Widget):
    pass


class _MessageBox(_Dialog):
    def __init__(self, title, text, **kw):
        super().__init__(title, **kw)
        self._text = text

    def text(self):
        return self._text


class ActiveModalDialogTest(unittest.TestCase):
    """server._active_modal_dialog reads PySide2; outside CC5 (no PySide2 or no QApplication) it says None."""

    def setUp(self):
        self.srv = _support.fresh_import("server")
        self.app = types.SimpleNamespace(modal=None, tops=[], exists=True)
        app = self.app

        class QApplication:
            @staticmethod
            def instance():
                return object() if app.exists else None

            @staticmethod
            def activeModalWidget():
                return app.modal

            @staticmethod
            def topLevelWidgets():
                return list(app.tops)

        widgets = types.ModuleType("PySide2.QtWidgets")
        widgets.QApplication, widgets.QDialog, widgets.QMessageBox = QApplication, _Dialog, _MessageBox
        pkg = types.ModuleType("PySide2")
        pkg.QtWidgets = widgets
        p = mock.patch.dict(sys.modules, {"PySide2": pkg, "PySide2.QtWidgets": widgets})
        p.start()
        self.addCleanup(p.stop)

    def test_none_without_pyside2(self):
        with mock.patch.dict(sys.modules, {"PySide2": None, "PySide2.QtWidgets": None}):
            self.assertIsNone(self.srv._active_modal_dialog())

    def test_none_without_a_qapplication(self):
        self.app.exists = False
        self.app.modal = _MessageBox(*RECOVERY)
        self.assertIsNone(self.srv._active_modal_dialog())

    def test_none_when_no_dialog_is_open(self):
        self.app.tops = [_Widget("Character Creator 5", modal=False), _Dialog("Hidden", visible=False),
                         _Dialog("Modeless panel", modal=False)]
        self.assertIsNone(self.srv._active_modal_dialog())

    def test_active_modal_message_box(self):
        self.app.modal = _MessageBox(*RECOVERY)
        self.assertEqual(self.srv._active_modal_dialog(), RECOVERY)

    def test_active_modal_widget_that_is_not_a_message_box(self):
        self.app.modal = _Dialog("Export FBX")
        self.assertEqual(self.srv._active_modal_dialog(), ("Export FBX", ""))

    def test_untitled_modal_widget_is_not_named_by_its_qt_class(self):
        # Live CC5 5.13 can start with its full-screen "What's New" page: an untitled application-modal QWidget.
        # Its Qt class name means nothing to the user, so it stays untitled and the error describes the page.
        page = _Widget("")
        page.metaObject = lambda: types.SimpleNamespace(className=lambda: "CRLWhatsNewWebEngineWidget")
        self.app.modal = page
        self.assertEqual(self.srv._active_modal_dialog(), ("", ""))

    def test_visible_modal_message_box_among_top_level_widgets(self):
        self.app.tops = [_Widget("Character Creator 5", modal=False), _MessageBox(*RECOVERY)]
        self.assertEqual(self.srv._active_modal_dialog(), RECOVERY)

    def test_qt_errors_mean_no_dialog(self):
        self.app.modal = mock.Mock(windowTitle=mock.Mock(side_effect=RuntimeError("deleted")))
        self.assertIsNone(self.srv._active_modal_dialog())


if __name__ == "__main__":
    unittest.main()
