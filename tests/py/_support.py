"""Test support: a fake RLPy module so plugin code imports outside CC5."""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
from unittest import mock

# Keep server.py's token file out of the developer's real %LOCALAPPDATA%.
os.environ["LOCALAPPDATA"] = tempfile.mkdtemp(prefix="cc5-pytest-")

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "cc5-plugin"))
PLUGIN_MODULES = ("server", "cc5_api", "cc5_pipeline", "cc5_skin", "cc5_builder", "cc5_scene")


def assert_token_dir_is_temp() -> None:
    """Raise unless server.py's token file (LOCALAPPDATA\\CC5_MCP_Bridge\\token) is inside the temp folder.

    Importing server.py reads or creates that file; outside the temp folder it may be the developer's real
    CC5 bridge token, which a test must never read, overwrite or delete.
    """
    if os.environ.get("CC5_BRIDGE_TOKEN", "").strip():
        return  # server.py uses the variable and never touches the file
    tmp = os.path.normcase(os.path.realpath(tempfile.gettempdir()))
    token_dir = os.path.normcase(os.path.realpath(
        os.path.join(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir(), "CC5_MCP_Bridge")))
    try:
        inside = os.path.commonpath([tmp, token_dir]) == tmp
    except ValueError:  # different drives
        inside = False
    if not inside:
        raise RuntimeError(f"Refusing to touch {token_dir}: it is outside the temp folder {tmp}, "
                           "so it may hold the real CC5 bridge token")


def install_fake_rlpy() -> mock.MagicMock:
    fake = mock.MagicMock(name="RLPy")
    sys.modules["RLPy"] = fake
    if PLUGIN_DIR not in sys.path:
        sys.path.insert(0, PLUGIN_DIR)
    return fake


def fresh_import(name: str):
    assert_token_dir_is_temp()
    for mod in PLUGIN_MODULES:
        sys.modules.pop(mod, None)
    return importlib.import_module(name)


install_fake_rlpy()
