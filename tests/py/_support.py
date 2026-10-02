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
PLUGIN_MODULES = ("server", "cc5_api", "cc5_pipeline", "cc5_skin", "cc5_builder")


def install_fake_rlpy() -> mock.MagicMock:
    fake = mock.MagicMock(name="RLPy")
    sys.modules["RLPy"] = fake
    if PLUGIN_DIR not in sys.path:
        sys.path.insert(0, PLUGIN_DIR)
    return fake


def fresh_import(name: str):
    for mod in PLUGIN_MODULES:
        sys.modules.pop(mod, None)
    return importlib.import_module(name)


install_fake_rlpy()
