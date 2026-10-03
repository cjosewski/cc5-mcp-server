"""
Character-building helpers that go beyond morphs: facial profiles, and the switched-off
Headshot photo-to-head. Content search lives on the TypeScript side (browse_content).
"""

from __future__ import annotations

import os
from typing import Any

import RLPy

import cc5_api
from cc5_pipeline import _raise_on_error, check_path

# Chad's ruling (2026-10-03): switched off. Live in CC5 5.13 (Task 18), RHeadshot.CreateHeadFromPhoto crashed CC5
# (CharacterCreator.exe+0xcc1e1b) in both Headshot modes. Keep the text in sync with HEADSHOT_DISABLED in
# src/recipe.ts. The RLPy implementation is in git history (commit 664b455) for when a later CC5 is re-tested.
HEADSHOT_DISABLED = (
    "headshot_from_photo is switched off because it crashed Character Creator 5. Make the head by hand instead: "
    "use the Headshot plugin inside Character Creator 5.")


def headshot_from_photo(photo_path: Any = None) -> dict[str, Any]:
    """Switched off: fails at once with HEADSHOT_DISABLED and never touches CC5."""
    return {"success": False, "error": HEADSHOT_DISABLED}


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
    "headshot_from_photo": lambda p: headshot_from_photo(),
    "load_facial_profile": lambda p: load_facial_profile(p["file_path"]),
}
POST_ROUTES: dict[str, str] = {"/builder/facial_profile": "load_facial_profile"}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "load_facial_profile": ["file_path"],
}
