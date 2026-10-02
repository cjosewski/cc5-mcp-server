"""
Skin and injury-state helpers: image overlays (bruising, dirt, blood), skin
condition tints (pallor, cyanosis), and wrinkle strength.
"""

from __future__ import annotations

from typing import Any

import RLPy

import cc5_api
from cc5_pipeline import IMAGE_EXTENSIONS, _check_existing, _raise_on_error

REGION_KEYS = {"head": "head", "body": "body", "arms": "arm", "legs": "leg"}
SKIN_CONDITIONS: dict[str, tuple[float, float, float]] = {
    "normal": (1.0, 1.0, 1.0),
    "pale": (0.93, 0.90, 0.88),
    "cyanotic": (0.80, 0.86, 0.98),
    "flushed": (1.0, 0.82, 0.80),
    "jaundiced": (1.0, 0.95, 0.70),
}


def skin_targets(avatar, region: str) -> list[tuple[str, str]]:
    mat_comp = avatar.GetMaterialComponent()
    out: list[tuple[str, str]] = []
    for mesh in avatar.GetMeshNames(True) or []:
        for mat in mat_comp.GetMaterialNames(mesh) or []:
            low = mat.lower()
            if "skin" not in low or "eyelash" in low:
                continue
            if region != "all" and REGION_KEYS[region] not in low:
                continue
            out.append((mesh, mat))
    return out


def _prepare(region: str) -> tuple[Any, list[tuple[str, str]], str | None]:
    if region != "all" and region not in REGION_KEYS:
        return None, [], f"region must be one of: all, {', '.join(REGION_KEYS)}"
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return None, [], "No avatar in scene"
    targets = skin_targets(avatar, region)
    if not targets:
        return None, [], f"No skin materials found for region '{region}'"
    return avatar, targets, None


def _now_key():
    key = RLPy.RKey()
    key.SetTime(RLPy.RGlobal.GetTime())
    return key


def apply_skin_overlay(image_path: str, region: str = "all", strength: float = 100.0) -> dict[str, Any]:
    """Blend an image (bruise, dirt, blood) over skin via the Diffuse Blend channel."""
    if not 0.0 <= float(strength) <= 100.0:
        return {"success": False, "error": "strength must be 0-100"}
    error = _check_existing(image_path, IMAGE_EXTENSIONS)
    if error:
        return {"success": False, "error": error}
    avatar, targets, error = _prepare(region)
    if error:
        return {"success": False, "error": error}
    mat_comp = avatar.GetMaterialComponent()
    channel = RLPy.EMaterialTextureChannel_DiffuseBlend
    applied: list[str] = []
    RLPy.RGlobal.BeginAction("Apply Skin Overlay")
    try:
        for mesh, mat in targets:
            _raise_on_error(mat_comp.LoadImageToTexture(mesh, mat, channel, image_path),
                            f"LoadImageToTexture on {mat}")
            # Live-confirmed: the weight is 0-1 (GetTextureWeights returns 1.0 at full strength).
            _raise_on_error(mat_comp.AddTextureWeightKey(_now_key(), mesh, mat, channel, float(strength) / 100.0),
                            f"AddTextureWeightKey on {mat}")
            applied.append(mat)
    except Exception as e:
        return {"success": False, "error": str(e), "applied_to": applied}
    finally:
        # Also after a failure part-way: the materials changed so far must still be redrawn.
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        RLPy.RGlobal.EndAction()
    return {"success": True, "applied_to": applied}


def remove_skin_overlay(region: str = "all") -> dict[str, Any]:
    avatar, targets, error = _prepare(region)
    if error:
        return {"success": False, "error": error}
    mat_comp = avatar.GetMaterialComponent()
    removed: list[str] = []
    refused: list[str] = []
    RLPy.RGlobal.BeginAction("Remove Skin Overlay")
    try:
        # Removing is safe to repeat, so a refusal on one material does not stop the rest.
        for mesh, mat in targets:
            try:
                _raise_on_error(mat_comp.RemoveMaterialTexture(mesh, mat, RLPy.EMaterialTextureChannel_DiffuseBlend),
                                "RemoveMaterialTexture")
                removed.append(mat)
            except Exception as e:
                refused.append(f"{mat} ({e})")
    finally:
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        RLPy.RGlobal.EndAction()
    if refused:
        return {"success": False, "error": f"Overlay not removed from: {'; '.join(refused)}", "removed_from": removed}
    return {"success": True, "removed_from": removed}


def set_skin_condition(condition: str, amount: float = 1.0, region: str = "all",
                       base_rgb: Any = None) -> dict[str, Any]:
    """Tint skin toward a clinical appearance (pale = shock, cyanotic = hypoxia).

    Writes the same diffuse key as cc5_api.set_skin_color, so it replaces the skin
    colour. Pass that colour as base_rgb to tint it instead of losing it.
    """
    if condition not in SKIN_CONDITIONS:
        return {"success": False, "error": f"condition must be one of: {', '.join(SKIN_CONDITIONS)}"}
    base = (1.0, 1.0, 1.0) if base_rgb is None else tuple(float(c) for c in base_rgb)
    if len(base) != 3 or not all(0.0 <= c <= 1.0 for c in base):
        return {"success": False, "error": "base_rgb must be three values 0-1"}
    amount = max(0.0, min(1.0, float(amount)))
    avatar, targets, error = _prepare(region)
    if error:
        return {"success": False, "error": error}
    tr, tg, tb = SKIN_CONDITIONS[condition]
    rgb = tuple(round(b * (1.0 + (t - 1.0) * amount), 4) for b, t in zip(base, (tr, tg, tb)))
    color = RLPy.RRgb(*rgb)
    mat_comp = avatar.GetMaterialComponent()
    applied: list[str] = []
    RLPy.RGlobal.BeginAction("Set Skin Condition")
    try:
        for mesh, mat in targets:
            _raise_on_error(mat_comp.AddDiffuseKey(_now_key(), mesh, mat, color), f"AddDiffuseKey on {mat}")
            applied.append(mat)
    except Exception as e:
        return {"success": False, "error": str(e), "condition": condition, "applied_to": applied}
    finally:
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        RLPy.RGlobal.EndAction()
    return {"success": True, "condition": condition, "rgb": list(rgb), "applied_to": applied}


def set_wrinkle_strength(strength: float) -> dict[str, Any]:
    strength = max(0.0, min(1.0, float(strength)))
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    parts = [n for n in dir(RLPy) if n.startswith("EWrinkleFacePart_") and not n.endswith("_None")]
    if not parts:
        return {"success": False, "error": "Wrinkle API (RLPy.EWrinkleFacePart_*) not available in this CC5 build"}
    mat_comp = avatar.GetMaterialComponent()
    done: list[str] = []
    RLPy.RGlobal.BeginAction("Set Wrinkle Strength")
    try:
        for name in parts:
            _raise_on_error(mat_comp.SetWrinkleDetailStrength(getattr(RLPy, name), strength),
                            f"SetWrinkleDetailStrength on {name}")
            done.append(name)
    except Exception as e:
        return {"success": False, "error": str(e), "parts": done}
    finally:
        # Refresh whatever changed, also when a face part failed part-way.
        if done:
            avatar.UpdateWrinkle()
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        RLPy.RGlobal.EndAction()
    return {"success": True, "parts": parts}


ACTIONS: dict[str, Any] = {
    "apply_skin_overlay": lambda p: apply_skin_overlay(p["image_path"], p.get("region", "all"), float(p.get("strength", 100))),
    "remove_skin_overlay": lambda p: remove_skin_overlay(p.get("region", "all")),
    "set_skin_condition": lambda p: set_skin_condition(p["condition"], float(p.get("amount", 1.0)), p.get("region", "all"), p.get("base_rgb")),
    "set_wrinkle_strength": lambda p: set_wrinkle_strength(float(p["strength"])),
}
POST_ROUTES: dict[str, str] = {
    "/skin/overlay": "apply_skin_overlay",
    "/skin/overlay/remove": "remove_skin_overlay",
    "/skin/condition": "set_skin_condition",
    "/skin/wrinkle": "set_wrinkle_strength",
}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "apply_skin_overlay": ["image_path"],
    "set_skin_condition": ["condition"],
    "set_wrinkle_strength": ["strength"],
}
