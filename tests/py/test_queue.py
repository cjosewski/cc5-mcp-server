from __future__ import annotations

import threading
import unittest

import _support
from test_auth import BridgeTestCase


class QueueTest(BridgeTestCase):
    def test_timed_out_queued_command_never_runs(self):
        ran = []
        self.srv.ACTION_MAP["mark"] = lambda p: ran.append(1) or {"success": True}
        self.stop.set()
        self.drain.join(2)  # "main thread" busy: nothing drains the queue
        status, body = self.srv._execute_sync("mark", {}, timeout=0.2)
        self.assertEqual(status, 504)
        self.assertEqual(body["state"], "cancelled")
        self.srv.process_command_queue()  # CC5 becomes free
        self.assertEqual(ran, [])

    def test_retry_after_cancel_applies_once(self):
        ran = []
        self.srv.ACTION_MAP["mark"] = lambda p: ran.append(1) or {"success": True}
        self.stop.set()
        self.drain.join(2)  # main thread busy: nothing drains the queue
        status, body = self.srv._execute_sync("mark", {}, timeout=0.2)
        self.assertEqual((status, body["state"]), (504, "cancelled"))
        threading.Timer(0.05, self.srv.process_command_queue).start()  # CC5 frees up during the retry
        status, _ = self.srv._execute_sync("mark", {}, timeout=2)
        self.assertEqual(status, 200)
        self.assertEqual(ran, [1])  # the cancelled original was dropped; only the retry ran

    def test_timeout_while_running_says_running(self):
        gate = threading.Event()
        self.srv.ACTION_MAP["slow"] = lambda p: gate.wait(2) or {"success": True}
        status, body = self.srv._execute_sync("slow", {}, timeout=0.2)
        gate.set()
        self.assertEqual(status, 504)
        self.assertEqual(body["state"], "running")

    def test_result_published_at_deadline_is_returned(self):
        # Review Focus #2: a command that finishes right as the wait expires ran,
        # so it must not be reported as "cancelled" (that invites a double-apply retry).
        ran = []
        self.srv.ACTION_MAP["mark"] = lambda p: ran.append(1) or {"success": True}

        class LateEvent(threading.Event):
            def wait(self, timeout=None):
                super().wait(timeout)  # CC5 finishes and publishes the result...
                return False           # ...just as the deadline passes

        from unittest import mock
        with mock.patch.object(self.srv.threading, "Event", LateEvent):
            status, body = self.srv._execute_sync("mark", {}, timeout=2)
        self.assertEqual(ran, [1])
        self.assertEqual(status, 200)
        self.assertEqual(body["result"], {"success": True})
        self.assertEqual(self.srv._cancelled, set())

    def test_health_answers_while_command_runs(self):
        gate, started = threading.Event(), threading.Event()

        def slow_action(p):
            started.set()
            gate.wait(3)
            return {"success": True}

        self.srv.ACTION_MAP["slow"] = slow_action
        self.srv.POST_ROUTES["/slow"] = "slow"
        slow = threading.Thread(target=self.post, args=("/slow", {}), daemon=True)
        slow.start()
        try:
            # Wait until the /slow request is being handled, so /health has to
            # be answered while a command is in progress.
            self.assertTrue(started.wait(2), "slow command never started")
            import urllib.request
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=1) as r:
                self.assertEqual(r.status, 200)
        finally:
            gate.set()
            slow.join(5)


class ExtensionTest(unittest.TestCase):
    def test_extension_tables_merged(self):
        import sys, types
        ext = types.ModuleType("cc5_fake_ext")
        ext.ACTIONS = {"fake_action": lambda p: {"success": True}}
        ext.POST_ROUTES = {"/fake": "fake_action"}
        ext.REQUIRED_PARAMS = {"fake_action": ["x"]}
        sys.modules["cc5_fake_ext"] = ext
        srv = _support.fresh_import("server")
        srv.EXTENSION_MODULES[:] = ["cc5_fake_ext"]
        self.assertEqual(srv.load_extensions(), ["cc5_fake_ext"])
        self.assertIn("fake_action", srv.ACTION_MAP)
        self.assertEqual(srv.POST_ROUTES["/fake"], "fake_action")
        self.assertEqual(srv.REQUIRED_PARAMS["fake_action"], ["x"])
