from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import _support


def _drain(srv, stop):
    while not stop.is_set():
        srv.process_command_queue()
        stop.wait(0.01)


class BridgeTestCase(unittest.TestCase):
    """Starts a real bridge on a free port with a thread standing in for CC5's main thread."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.environ["LOCALAPPDATA"] = self.tmp
        os.environ.pop("CC5_BRIDGE_TOKEN", None)
        os.environ.pop("CC5_DEV_MODE", None)
        os.environ.pop("CC5_ALLOW_EXEC", None)
        self.srv = _support.fresh_import("server")
        # Keep the bridge's per-request log lines out of the test output.
        self.srv.BridgeHandler.log_message = lambda *args: None
        self.srv.ACTION_MAP["ping"] = lambda p: {"success": True, "pong": True}
        self.srv.POST_ROUTES["/ping"] = "ping"
        self.srv.start_server(port=0)
        self.port = self.srv._httpd.server_address[1]
        self.stop = threading.Event()
        self.drain = threading.Thread(target=_drain, args=(self.srv, self.stop), daemon=True)
        self.drain.start()

    def tearDown(self):
        self.stop.set()
        self.srv.stop_server()

    def post(self, path, body, headers=None, token=True):
        h = {"Content-Type": "application/json"}
        if token:
            h["X-CC5-Token"] = self.srv.TOKEN
        h.update(headers or {})
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode(),
            method="POST", headers=h)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read().decode() or "{}")

    def get(self, path, token=True):
        h = {"X-CC5-Token": self.srv.TOKEN} if token else {}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers=h)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read().decode() or "{}")


class AuthTest(BridgeTestCase):
    def test_token_file_created(self):
        path = os.path.join(self.tmp, "CC5_MCP_Bridge", "token")
        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), self.srv.TOKEN)

    def test_missing_token_rejected(self):
        self.assertEqual(self.post("/ping", {}, token=False)[0], 401)

    def test_valid_token_accepted(self):
        self.assertEqual(self.post("/ping", {})[0], 200)

    def test_non_json_content_type_rejected(self):
        self.assertEqual(self.post("/ping", {}, {"Content-Type": "text/plain"})[0], 415)

    def test_foreign_host_rejected(self):
        self.assertEqual(self.post("/ping", {}, {"Host": "evil.example:80"})[0], 403)

    def test_dev_mode_off_by_default(self):
        self.assertFalse(self.srv.DEV_MODE)
        self.assertEqual(self.post("/exec/python", {"code": "result=1"})[0], 403)

    def test_health_needs_no_token(self):
        self.assertEqual(self.get("/health", token=False)[0], 200)

    def test_get_routes_need_token(self):
        self.assertEqual(self.get("/api", token=False)[0], 401)
        self.assertEqual(self.get("/avatars", token=False)[0], 401)
        self.assertEqual(self.get("/api")[0], 200)

    def test_reload_off_without_dev_mode(self):
        self.assertEqual(self.get("/reload")[0], 403)
        self.assertEqual(self.get("/reload", token=False)[0], 401)

    def test_exec_python_api_refuses_by_default(self):
        os.environ.pop("CC5_ALLOW_EXEC", None)
        api = _support.fresh_import("cc5_api")
        self.assertFalse(api.exec_python("result = 1")["success"])
