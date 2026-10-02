"""
Character-building helpers that go beyond morphs: Headshot photo-to-head and
facial profiles. Content search lives on the TypeScript side (browse_content).
"""

from __future__ import annotations

import os
from typing import Any

import RLPy

import cc5_api
from cc5_pipeline import _check_existing, _raise_on_error, check_path

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def _headshot_modes() -> list[str]:
    return [n for n in dir(RLPy) if n.startswith("EHSMode_")]


def headshot_from_photo(photo_path: str) -> dict[str, Any]:
    """Generate a head from a front-facing photo (needs the Headshot 3 plugin)."""
    error = _check_existing(photo_path, PHOTO_EXTENSIONS)
    if error:
        return {"success": False, "error": error}
    modes = _headshot_modes()
    if not modes:
        return {"success": False, "error": "Headshot is not available in this CC5 install (Headshot 3 plugin required)"}
    mode = next((m for m in modes if "Pro" in m), modes[0])
    RLPy.RGlobal.BeginAction("Headshot From Photo")
    try:
        _raise_on_error(
            RLPy.RHeadshot.CreateHeadFromPhoto(photo_path, getattr(RLPy, mode), RLPy.RHeadshotOption()),
            "CreateHeadFromPhoto",
        )
    except Exception as e:
        return {"success": False, "error": f"Headshot failed ({e}). Check the Headshot 3 plugin is installed and licensed."}
    finally:
        RLPy.RGlobal.EndAction()
    cc5_api._invalidate_caches()
    return {"success": True, "mode": mode}


def load_facial_profile(file_path: str) -> dict[str, Any]:
    error = check_path(file_path)
    if error:
        return {"success": False, "error": error}
    ext = os.path.splitext(file_path)[1].lower()
    if not (ext.startswith(".cc") or ext.startswith(".i")):
        return {"success": False, "error": f"Not a CC content file: {ext}"}
    if not os.path.isfile(file_path):
        return {"success": False, "error": f"File not found: {file_path}"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    RLPy.RGlobal.BeginAction("Load Facial Profile")
    try:
        _raise_on_error(avatar.GetFacialProfileComponent().LoadProfile(file_path), "LoadProfile")
        RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Attribute)
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True}


ACTIONS: dict[str, Any] = {
    "headshot_from_photo": lambda p: headshot_from_photo(p["photo_path"]),
    "load_facial_profile": lambda p: load_facial_profile(p["file_path"]),
}
POST_ROUTES: dict[str, str] = {"/builder/facial_profile": "load_facial_profile"}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "headshot_from_photo": ["photo_path"],
    "load_facial_profile": ["file_path"],
}
