from __future__ import annotations

import threading
import time

from test_auth import BridgeTestCase


class JobsTest(BridgeTestCase):
    def test_job_runs_and_reports_done(self):
        self.srv.ACTION_MAP["work"] = lambda p: {"success": True, "n": p["n"]}
        status, body = self.post("/jobs/start", {"action": "work", "params": {"n": 3}})
        self.assertEqual(status, 200)
        job_id = body["result"]["job_id"]
        for _ in range(50):
            _, st = self.post("/jobs/status", {"job_id": job_id})
            if st["result"]["status"] == "done":
                break
            time.sleep(0.02)
        self.assertEqual(st["result"]["result"], {"success": True, "n": 3})

    def test_failed_result_marks_job_failed(self):
        self.srv.ACTION_MAP["bad"] = lambda p: {"success": False, "error": "nope"}
        _, body = self.post("/jobs/start", {"action": "bad", "params": {}})
        time.sleep(0.2)
        _, st = self.post("/jobs/status", {"job_id": body["result"]["job_id"]})
        self.assertEqual(st["result"]["status"], "failed")

    def test_exec_python_not_allowed_as_job(self):
        self.assertEqual(self.post("/jobs/start", {"action": "exec_python", "params": {"code": "1"}})[0], 400)

    def test_non_object_params_rejected(self):
        self.assertEqual(self.post("/jobs/start", {"action": "search_morphs", "params": 5})[0], 400)

    def test_unknown_job_404(self):
        self.assertEqual(self.post("/jobs/status", {"job_id": "cmd_999999"})[0], 404)

    def test_status_answers_while_job_runs(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        self.srv.ACTION_MAP["slow"] = lambda p: gate.wait(5) or {"success": True}
        _, body = self.post("/jobs/start", {"action": "slow", "params": {}})
        job_id = body["result"]["job_id"]
        for _ in range(50):
            t0 = time.monotonic()
            status, st = self.post("/jobs/status", {"job_id": job_id})
            self.assertLess(time.monotonic() - t0, 1.0)
            self.assertEqual(status, 200)
            if st["result"]["status"] == "running":
                break
            time.sleep(0.02)
        self.assertEqual(st["result"]["status"], "running")
        gate.set()
