from __future__ import annotations

import unittest

import _support


class HarnessTest(unittest.TestCase):
    def test_cc5_api_imports_with_fake_rlpy(self):
        api = _support.fresh_import("cc5_api")
        self.assertTrue(hasattr(api, "export_fbx"))

    def test_server_imports(self):
        srv = _support.fresh_import("server")
        self.assertIn("export_fbx", srv.ACTION_MAP)


if __name__ == "__main__":
    unittest.main()
