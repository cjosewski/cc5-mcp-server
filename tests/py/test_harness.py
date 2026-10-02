from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

import _support

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


class HarnessTest(unittest.TestCase):
    def test_cc5_api_imports_with_fake_rlpy(self):
        api = _support.fresh_import("cc5_api")
        self.assertTrue(hasattr(api, "export_fbx"))

    def test_server_imports(self):
        srv = _support.fresh_import("server")
        self.assertIn("export_fbx", srv.ACTION_MAP)

    def test_refuses_to_import_server_when_its_token_file_is_outside_the_temp_folder(self):
        # As if _support had not redirected LOCALAPPDATA: importing server.py would read or create the real token.
        before = sys.modules.get("server")
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": REPO}), mock.patch.dict(os.environ, {"CC5_BRIDGE_TOKEN": ""}):
            with self.assertRaisesRegex(RuntimeError, "Refusing to touch"):
                _support.fresh_import("server")
        self.assertIs(sys.modules.get("server"), before)  # refused before the import
        self.assertFalse(os.path.exists(os.path.join(REPO, "CC5_MCP_Bridge")))

    def test_temp_token_folder_is_accepted(self):
        _support.assert_token_dir_is_temp()


if __name__ == "__main__":
    unittest.main()
