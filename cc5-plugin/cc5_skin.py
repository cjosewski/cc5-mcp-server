"""
Skin and injury-state helpers: image overlays (bruising, dirt, blood), skin
condition tints (pallor, cyanosis), wrinkle strength, and how overlays and a
skin condition reach a Unity export (an FBX carries neither).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from typing import Any

import RLPy

import cc5_api
import cc5_pipeline  # BLEND_SOURCES and REFRESH_METHOD are read through the module, so tests and /reload see one copy
from cc5_pipeline import (IMAGE_EXTENSIONS, _check_existing, _raise_on_error, avatar_key, now_key,
                          read_blend_strength, read_blend_strengths, refresh_current_frame)

REGION_KEYS = {"head": "head", "body": "body", "arms": "arm", "legs": "leg"}
# Diffuse tints (multiplied into the skin colour). Pale has none: a tint can only darken.
SKIN_CONDITIONS: dict[str, tuple[float, float, float]] = {
    "normal": (1.0, 1.0, 1.0),
    "pale": (1.0, 1.0, 1.0),
    "cyanotic": (0.80, 0.86, 0.98),
    "flushed": (1.0, 0.82, 0.80),
    "jaundiced": (1.0, 0.95, 0.70),
}
# Pallor: Digital Human skin shader offsets at amount 1 (0 = the texture as authored). Live CC5 5.13 (Task 18): the old
# pale tint (0.93, 0.90, 0.88) made CC4 Camila's cheeks darker and more saturated; pale 0.8 with these offsets
# (+0.048, -0.2) took them from lightness 0.42 to 0.54 and saturation 0.27 to 0.12. Every condition writes them, so
# normal and the tints clear the pallor.
PALLOR_OFFSETS: dict[str, float] = {"_BaseColorMap Brightness": 0.06, "_BaseColorMap Saturation": -0.25}

# LIVE-CALIBRATE (F-75): how injuries 'bake' paints overlays and a skin condition into an export's diffuse textures.
# These are first guesses until they are fitted to CC5 captures (forearm at overlay 0, 50 and 100; cheek at pale 0 and
# 1) and a cyanotic export is checked in Unity. Then set them and BAKE_CALIBRATED_ON: the replies stop saying the bake
# formula is unchecked.
OVERLAY_BAKE_MODE = "Multiply"  # QPainter.CompositionMode_<name>; also written to the sidecar as "blend"
OVERLAY_BAKE_GAIN = 1.0  # overlay opacity = min(1, strength * gain)
PALLOR_BAKE_SATURATION_GAIN = 1.0  # a saturation s < 0 moves each channel toward qGray (11R+16G+5B)/32 by -s*gain
PALLOR_BAKE_BRIGHTNESS_GAIN = 1.0  # a brightness b > 0 adds b*gain*255 to each channel
# Whether the skin's diffuse colour (cyanotic, flushed, jaundiced) reaches Unity as the FBX material colour. None: not
# verified, so a tint is reported as not verified, never baked, and never stops an export.
TINT_REACHES_UNITY: bool | None = None
BAKE_CALIBRATED_ON: str | None = None  # the date these constants were fitted to CC5
BAKE_CHECK_TOLERANCE = 3  # out of 255: how far a painted pixel may be from baked_pixel before the file is left alone

_BLEND_OFF = 0.001  # a Diffuse Blend strength at or below this shows nothing
_SAME_STRENGTH = 0.005  # a read this close to a strength agrees with it
_OFFSET_ZERO = 1e-4  # pallor offsets this close to 0 are no change
_DIFFUSE_TYPES = r"(?:png|jpe?g|tga|bmp|tiff?)"
_NOT_READABLE = "the overlay image could not be read from CC5 and was not loaded by this bridge"
# P-1: a stale overlay (see _overlay_state) is never shipped or baked: which image CC5 shows is not known.
_IMAGE_NOT_KNOWN = ("the overlay image is not known after an undo or a change made in CC5: re-apply it with "
                    "apply_skin_overlay or load_texture, then export again")
_RECORDED_IMAGES_NOTE = ("Overlay images are named as this bridge last loaded them (apply_skin_overlay, load_texture): "
                         "an image changed in CC5 itself is not seen.")


def is_skin_material(mat: str) -> bool:
    """A skin material: 'skin' in its name, and not an eyelash."""
    low = mat.lower()
    return "skin" in low and "eyelash" not in low


def skin_targets(avatar, region: str) -> list[tuple[str, str]]:
    mat_comp = avatar.GetMaterialComponent()
    out: list[tuple[str, str]] = []
    for mesh in avatar.GetMeshNames(True) or []:
        for mat in mat_comp.GetMaterialNames(mesh) or []:
            if not is_skin_material(mat):
                continue
            if region != "all" and REGION_KEYS[region] not in mat.lower():
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


def apply_skin_overlay(image_path: str, region: str = "all", strength: float = 100.0) -> dict[str, Any]:
    """Blend an image (bruise, dirt, blood) over skin via the Diffuse Blend channel.

    Records each material it changed in cc5_pipeline.BLEND_SOURCES. The result's `strengths` are what CC5 reads back
    per material and `stale` the materials whose read differs from the strength set: CC5's read lags until it renders
    (F-65). A material CC5 cannot read has no entry and is not stale. A failure part-way also names the materials
    changed so far in its error text ("Applied to: ..."): a failed direct call reaches the agent as that text alone
    (HTTP 400, TS-2).
    """
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
    weight = float(strength) / 100.0
    key = avatar_key(avatar)
    applied: list[str] = []
    changed: list[tuple[str, str]] = []
    image_in: tuple[str, str] | None = None  # a material whose new image went in before its record was written
    modified = False
    RLPy.RGlobal.BeginAction("Apply Skin Overlay")
    try:
        for mesh, mat in targets:
            _raise_on_error(mat_comp.LoadImageToTexture(mesh, mat, channel, image_path),
                            f"LoadImageToTexture on {mat}")
            image_in = (mesh, mat)
            # Live-confirmed: the weight is 0-1 (GetTextureWeights returns 1.0 at full strength).
            _raise_on_error(mat_comp.AddTextureWeightKey(now_key(), mesh, mat, channel, weight),
                            f"AddTextureWeightKey on {mat}")
            # Recorded at once: a failure on a later material keeps the records of the materials that did change.
            cc5_pipeline.BLEND_SOURCES[(key, mesh, mat)] = {"image": image_path, "strength": weight}
            image_in = None
            applied.append(mat)
            changed.append((mesh, mat))
        modified = True
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        # Before EndAction: a refresh, when REFRESH_METHOD turns it on, joins the same undo step.
        strengths, stale = read_blend_strengths(mat_comp, changed, weight)
    except Exception as e:
        if image_in is not None:
            # CC5 holds the new image, but the material's record still names the old one: an export must not ship or
            # bake that (P-1). A later apply_skin_overlay or load_texture writes a fresh record.
            rec = cc5_pipeline.BLEND_SOURCES.get((key,) + image_in)
            if rec is not None:
                rec["stale"] = True
        error = str(e)
        if applied:
            error = f"{error.rstrip('.')}. Applied to: {', '.join(applied)}."
        return {"success": False, "error": error, "applied_to": applied}
    finally:
        # Also after a failure part-way: the materials changed so far must still be redrawn.
        if not modified:
            RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        RLPy.RGlobal.EndAction()
    return {"success": True, "applied_to": applied, "strengths": strengths, "stale": stale}


def _reset_blend_strength(mat_comp: Any, mesh: str, mat: str, channel: Any, notes: list[str]) -> bool:
    """Set the material's Diffuse Blend strength to 0 (F-66): an image loaded there later then does not show at the
    old strength. True when it was set. A refusal is a WARNING note, not a failure: the overlay itself is gone."""
    try:
        _raise_on_error(mat_comp.AddTextureWeightKey(now_key(), mesh, mat, channel, 0.0), "AddTextureWeightKey")
    except Exception as e:
        notes.append(f"WARNING: {mat}: strength not reset to 0 ({e})")
        return False
    return True


def remove_skin_overlay(region: str = "all") -> dict[str, Any]:
    """Remove the Diffuse Blend overlay from the region's skin materials and set their strength back to 0 (also on
    materials without an image). A material CC5 refused to clear keeps its overlay and its strength.

    `reset` lists the materials without an image whose strength was set to 0 (X-5): that is a change, and one CC5 undo
    step with the rest of the call. A failure's error text also names what was removed and reset, with each WARNING
    note on its own line: a failed direct call reaches the agent as that text alone (HTTP 400, TS-2).
    """
    avatar, targets, error = _prepare(region)
    if error:
        return {"success": False, "error": error}
    mat_comp = avatar.GetMaterialComponent()
    channel = RLPy.EMaterialTextureChannel_DiffuseBlend
    key = avatar_key(avatar)
    removed: list[str] = []
    no_overlay: list[str] = []
    reset: list[str] = []
    refused: list[str] = []
    notes: list[str] = []
    RLPy.RGlobal.BeginAction("Remove Skin Overlay")
    try:
        # Removing is safe to repeat, so a refusal on one material does not stop the rest.
        for mesh, mat in targets:
            # Live CC5: RemoveMaterialTexture returns an error status when the channel is already empty.
            has_image = bool(mat_comp.HasImage(mesh, mat, channel))
            if has_image:
                try:
                    _raise_on_error(mat_comp.RemoveMaterialTexture(mesh, mat, channel), "RemoveMaterialTexture")
                except Exception as e:
                    refused.append(f"{mat} ({e})")
                    continue
                removed.append(mat)
            else:
                no_overlay.append(mat)
            if _reset_blend_strength(mat_comp, mesh, mat, channel, notes) and not has_image:
                reset.append(mat)
            cc5_pipeline.BLEND_SOURCES.pop((key, mesh, mat), None)
    finally:
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        RLPy.RGlobal.EndAction()
    if refused:
        text = f"Overlay not removed from: {'; '.join(refused)}."
        if removed:
            text += f" Removed from: {', '.join(removed)}."
        if reset:
            text += f" Strength set to 0 on: {', '.join(reset)} (no overlay image there)."
        result: dict[str, Any] = {"success": False, "error": "\n".join([text] + notes), "removed_from": removed,
                                  "no_overlay": no_overlay, "reset": reset}
    else:
        result = {"success": True, "removed_from": removed, "no_overlay": no_overlay, "reset": reset}
    if notes:
        result["notes"] = notes
    return result


def _has_pallor_offsets(mat_comp: Any, mesh: str, mat: str) -> bool:
    """Whether the material's shader has both pallor offsets, each holding one value (the count SWIG expects)."""
    try:
        names = set(mat_comp.GetShaderParameterNames(mesh, mat) or [])
        return all(name in names and len(list(mat_comp.GetShaderParameter(mesh, mat, name))) == 1
                   for name in PALLOR_OFFSETS)
    except Exception:
        return False


def set_skin_condition(condition: str, amount: float = 1.0, region: str = "all",
                       base_rgb: Any = None) -> dict[str, Any]:
    """Move skin toward a clinical appearance (pale = shock, cyanotic = hypoxia).

    Writes the same diffuse key as cc5_api.set_skin_color, so it replaces the skin
    colour. Pass that colour as base_rgb to tint it instead of losing it. Pallor
    lightens and desaturates through the skin shader's PALLOR_OFFSETS; every other
    condition sets them back to 0.

    Every condition sets the Digital Human skin shader's base-colour Brightness and
    Saturation (pale raises Brightness and lowers Saturation; the other conditions set
    both back to 0), so a Brightness or Saturation change made by hand in CC5 is replaced.
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
    mat_comp = avatar.GetMaterialComponent()
    with_offsets = [target for target in targets if _has_pallor_offsets(mat_comp, *target)]
    if condition == "pale" and amount > 0 and not with_offsets:
        return {"success": False, "error": "This character's skin shader has no _BaseColorMap Brightness / "
                                           "_BaseColorMap Saturation offsets (CC5's Digital Human skin), so pale "
                                           "cannot lighten its skin"}
    scale = amount if condition == "pale" else 0.0
    offsets = {name: round(full * scale, 4) + 0.0 for name, full in PALLOR_OFFSETS.items()}
    tr, tg, tb = SKIN_CONDITIONS[condition]
    rgb = tuple(round(b * (1.0 + (t - 1.0) * amount), 4) for b, t in zip(base, (tr, tg, tb)))
    color = cc5_api._cc5_rgb(*rgb)
    applied: list[str] = []
    RLPy.RGlobal.BeginAction("Set Skin Condition")
    try:
        for mesh, mat in targets:
            _raise_on_error(mat_comp.AddDiffuseKey(now_key(), mesh, mat, color), f"AddDiffuseKey on {mat}")
            if (mesh, mat) in with_offsets:
                for name, value in offsets.items():
                    mat_comp.SetShaderParameter(mesh, mat, name, [value])
            applied.append(mat)
    except Exception as e:
        return {"success": False, "error": str(e), "condition": condition, "applied_to": applied}
    finally:
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
        RLPy.RGlobal.EndAction()
    result: dict[str, Any] = {"success": True, "condition": condition, "rgb": list(rgb), "applied_to": applied}
    if condition == "pale":
        result["shader"] = offsets
        without = [mat for mesh, mat in targets if (mesh, mat) not in with_offsets]
        if without:
            result["notes"] = [f"WARNING: no pallor offsets on {', '.join(without)}, so pale did not lighten them"]
    return result


def set_wrinkle_strength(strength: float) -> dict[str, Any]:
    """Set the strength of CC5's expression wrinkles (F-70): the creases its wrinkle system shows while the matching
    expression is active (brow raise, squint, smile...). It does not age a resting face (live: a neutral face did not
    change). There is no getter, so the value cannot be read back."""
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


# --- Injuries in a Unity export (F-75) -----------------------------------------------------------------------------
# An FBX carries neither a Diffuse Blend overlay (on any material) nor the skin shader's pallor offsets, and CC5 has no
# FBX option that bakes Diffuse Blend. cc5_pipeline.export_for_unity reads them here (skin_export_state), refuses an
# export that has them until the user picks how they reach Unity (needs_injury_choice), and carries them
# (carry_injuries): 'bake' paints them into this export's diffuse textures, 'separate' writes the overlay images and a
# sidecar JSON beside the FBX for a Unity material to blend, 'omit' leaves them out. Every report lists what the FBX
# does not carry.

def _pct(weight: float) -> str:
    """A 0-1 strength as a percentage: 0.6 -> '60', 0.333 -> '33.3'."""
    return f"{round(weight * 100, 1):g}"


def _rgb_text(rgb: Any) -> str:
    return ", ".join(f"{float(c):.2f}" for c in rgb)


def _overlay_state(mat_comp: Any, key: Any, mesh: str, mat: str, notes: list[str]) -> dict[str, Any] | None:
    """The overlay one material shows, or None (see skin_export_state). The bridge's record wins over CC5's read,
    which lags until CC5 renders, unless the record cannot say what CC5 shows (P-1): it is stale (an undo or redo ran
    since it was written: cc5_pipeline.mark_blend_sources_stale), or it set 0 while CC5 reads more. Then CC5's read is
    the strength (unknown when it reads 0: never dropped silently), and the image is not known ("stale": True)."""
    read = read_blend_strength(mat_comp, mesh, mat)
    rec = cc5_pipeline.BLEND_SOURCES.get((key, mesh, mat))
    skin = is_skin_material(mat)
    shows = read is not None and read > _BLEND_OFF
    if rec is not None and rec.get("stale"):
        notes.append(f"{mat}: an undo or redo ran since the bridge set this overlay, so CC5's read is used for its "
                     "strength and its image is not known")
        return {"mesh": mesh, "material": mat, "strength": round(read, 4) if shows else None, "image": None,
                "skin": skin, "stale": True}
    if rec is not None:
        strength = float(rec.get("strength") or 0.0)
        if strength <= _BLEND_OFF:
            if not shows:
                return None  # the bridge set it to 0, and CC5 reads 0: hidden
            notes.append(f"{mat}: the bridge last set 0%, CC5 reads {_pct(read)}%: an undo or a change made in CC5; "
                         f"used {_pct(read)}%")
            return {"mesh": mesh, "material": mat, "strength": round(read, 4), "image": None, "skin": skin,
                    "stale": True}
        if shows and abs(read - strength) > _SAME_STRENGTH:
            notes.append(f"{mat}: CC5 reads {_pct(read)}% but the bridge last set {_pct(strength)}%; used "
                         f"{_pct(strength)}% (CC5's read lags until it renders; after an undo or a change made in CC5 "
                         f"itself {_pct(read)}% would be right: capture_viewport and check)")
        elif not shows:
            notes.append(f"{mat}: CC5 read the overlay strength as 0 (it updates when CC5 renders); used the "
                         f"{_pct(strength)}% the bridge set")
        return {"mesh": mesh, "material": mat, "strength": strength, "image": rec.get("image"), "skin": skin}
    if shows:
        # Not set by this bridge (a .ccAvatar's, CC5's own UI, or the content's): the FBX drops it all the same.
        return {"mesh": mesh, "material": mat, "strength": round(read, 4), "image": None, "skin": skin}
    if skin:
        # Reads 0, but the read can be stale until CC5 renders, and an overlay loaded with a .ccAvatar has no record:
        # an overlay of unknown strength, never dropped silently.
        return {"mesh": mesh, "material": mat, "strength": None, "image": None, "skin": True}
    return None  # CC4 Kevin's corneas carry a Diffuse Blend image at 0 by design


def _read_pallor(mat_comp: Any, mesh: str, mat: str, state: dict[str, Any]) -> None:
    try:
        if not _has_pallor_offsets(mat_comp, mesh, mat):
            return
        # round(..., 4) + 0.0: float32 noise and -0.0 never split a group or read as "below 0".
        values = {name: round(float(list(mat_comp.GetShaderParameter(mesh, mat, name))[0]), 4) + 0.0
                  for name in PALLOR_OFFSETS}
    except Exception as e:
        state["notes"].append(f"{mat}: CC5 could not read its skin Brightness/Saturation ({e})")
        return
    brightness = values["_BaseColorMap Brightness"]
    saturation = values["_BaseColorMap Saturation"]
    if abs(brightness) > _OFFSET_ZERO or abs(saturation) > _OFFSET_ZERO:
        state["pallor"].append({"mesh": mesh, "material": mat, "brightness": brightness, "saturation": saturation})


def _read_tint(mat_comp: Any, mesh: str, mat: str, state: dict[str, Any]) -> None:
    try:
        color = mat_comp.GetDiffuseColor(mesh, mat)
        rgb = [float(color.Red()), float(color.Green()), float(color.Blue())]
    except Exception as e:
        state["notes"].append(f"{mat}: CC5 could not read its diffuse colour ({e})")
        return
    if min(rgb) < 254:
        state["tints"].append({"mesh": mesh, "material": mat, "rgb": [round(c / 255.0, 2) for c in rgb]})


def skin_export_state(avatar: Any) -> dict[str, Any]:
    """What the character shows that an FBX does not carry. Never raises.

    overlays: [{mesh, material, strength (0-1, or None = unknown), image (the file this bridge loaded, or None),
    skin, and stale: True when the bridge's record cannot say which image CC5 shows (P-1), so it is neither shipped nor
    baked}], from every material of every mesh in GetMeshNames(True), worn items' too: load_texture('diffuse_blend')
    can put an overlay on any material. pallor: [{mesh, material, brightness, saturation}] of skin materials whose
    pallor offsets are not 0. tints: [{mesh, material, rgb (0-1)}] of skin materials whose diffuse colour is not white.
    unread: materials CC5 could not read (reported as not verified; they never stop an export). notes: reads that
    disagree with the bridge's records, or failed.
    """
    state: dict[str, Any] = {"overlays": [], "pallor": [], "tints": [], "unread": [], "notes": []}
    refresh_current_frame()
    try:
        mat_comp = avatar.GetMaterialComponent()
        meshes = list(avatar.GetMeshNames(True) or [])
        key = avatar_key(avatar)
    except Exception as e:
        state["unread"].append(f"the character's materials: CC5 could not list them ({e}), so overlays and a skin "
                               "condition are not ruled out")
        return state
    channel = RLPy.EMaterialTextureChannel_DiffuseBlend
    for mesh in meshes:
        try:
            mats = list(mat_comp.GetMaterialNames(mesh) or [])
        except Exception as e:
            state["unread"].append(f"{mesh}: CC5 could not list its materials ({e}), so an overlay there is not "
                                   "ruled out")
            continue
        for mat in mats:
            try:
                has_image = bool(mat_comp.HasImage(mesh, mat, channel))
            except Exception as e:
                state["unread"].append(f"{mat}: CC5 could not read its Diffuse Blend layer ({e}), so an overlay "
                                       "there is not ruled out")
                continue
            if not has_image:
                continue
            try:
                overlay = _overlay_state(mat_comp, key, mesh, mat, state["notes"])
            except Exception as e:  # e.g. an id CC5 gave that cannot key BLEND_SOURCES: never stop the export here
                state["unread"].append(f"{mat}: its Diffuse Blend overlay could not be checked ({e}), so an overlay "
                                       "there is not ruled out")
                continue
            if overlay is not None:
                state["overlays"].append(overlay)
    try:
        targets = skin_targets(avatar, "all")
    except Exception as e:
        state["unread"].append(f"the skin materials: CC5 could not list them ({e}), so a skin condition is not "
                               "ruled out")
        targets = []
    for mesh, mat in targets:
        _read_pallor(mat_comp, mesh, mat, state)
        _read_tint(mat_comp, mesh, mat, state)
    return state


def needs_injury_choice(state: dict[str, Any]) -> bool:
    """Whether an export must wait for the user's injuries choice: an overlay (one of unknown strength too: never drop
    silently), pallor, or a tint known not to reach Unity. Materials CC5 could not read do not count."""
    return bool(state["overlays"]) or bool(state["pallor"]) or (TINT_REACHES_UNITY is False and bool(state["tints"]))


def _grouped(items: list[dict[str, Any]], key: Any) -> list[tuple[Any, list[str]]]:
    """(key, [materials]) per distinct key(item), in first-seen order."""
    groups: dict[Any, list[str]] = {}
    for item in items:
        groups.setdefault(key(item), []).append(item["material"])
    return list(groups.items())


def _overlay_line(overlay: dict[str, Any]) -> str:
    name = os.path.basename(overlay["image"]) if overlay.get("image") else "an overlay image"
    if overlay["strength"] is None:
        return (f"{name} on {overlay['material']} (Diffuse Blend overlay; CC5 reads its strength as 0, which can be "
                "stale until CC5 renders, so it may be showing)")
    return f"{name} on {overlay['material']} (Diffuse Blend overlay at {_pct(overlay['strength'])}%)"


def _pallor_lines(pallor: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    for (b, s), mats in _grouped(pallor, lambda p: (f"{p['brightness']:+.3f}", f"{p['saturation']:+.3f}")):
        what = "pale skin" if float(b) >= 0 and float(s) <= 0 else "skin Brightness/Saturation change"
        lines.append(f"{what} on {', '.join(mats)} (Digital Human skin shader: Brightness {b}, Saturation {s})")
    return lines


def injury_report(state: dict[str, Any], choice: str | None) -> dict[str, Any]:
    """The injuries part of an export result: what the FBX does not carry (not_carried), what may not reach Unity
    (unverified), and, filled by carry_injuries, what was baked or written (done) and what was not (failed). When it
    names an overlay image, a note says that image is the one this bridge last loaded (P-1)."""
    not_carried = [_overlay_line(o) for o in state["overlays"]] + _pallor_lines(state["pallor"])
    unverified: list[str] = []
    for rgb, mats in _grouped(state["tints"], lambda t: tuple(t["rgb"])):
        text = f"skin colour ({_rgb_text(rgb)}) on {', '.join(mats)}"
        if TINT_REACHES_UNITY is None:
            unverified.append(f"{text}: CC5 writes it as the FBX material colour, not yet checked in Unity")
        elif TINT_REACHES_UNITY is False:
            not_carried.append(text)
    unverified += list(state["unread"])
    notes = list(state["notes"])
    if any(overlay.get("image") for overlay in state["overlays"]):
        notes.append(_RECORDED_IMAGES_NOTE)
    return {"choice": choice, "not_carried": not_carried, "unverified": unverified, "done": [], "failed": [],
            "notes": notes, "calibrated": BAKE_CALIBRATED_ON}


def _relative(folder: str, path: str) -> str:
    return os.path.relpath(path, folder).replace("\\", "/")


def _inside(path: str, root: str) -> bool:
    """Whether `path` is below `root` (both resolved)."""
    try:
        common = os.path.commonpath([path, root])
    except ValueError:  # another drive, or a mix of absolute and relative paths
        return False
    return os.path.normcase(path) != os.path.normcase(root) and os.path.normcase(common) == os.path.normcase(root)


def _remove_file(path: str) -> bool:
    try:
        os.remove(path)
        return True
    except OSError:
        return False


def _remove_dir_if_empty(path: str) -> None:
    """Remove an empty folder and the .meta Unity made for it."""
    try:
        if os.path.isdir(path) and not os.listdir(path):
            os.rmdir(path)
            if os.path.isfile(path + ".meta"):
                os.remove(path + ".meta")
    except OSError:
        pass


def _path_key(path: str) -> str:
    """One spelling per file: resolved and case-folded as Windows compares paths."""
    return os.path.normcase(os.path.realpath(path))


def _earlier_images(folder: str, name: str) -> list[str] | None:
    """The images an earlier export's <name>_injuries.json lists that are files inside <folder>/Injuries (resolved,
    path-checked), or None when there is no such sidecar. An unreadable sidecar lists none."""
    sidecar = os.path.join(folder, f"{name}_injuries.json")
    if not os.path.isfile(sidecar):
        return None
    try:
        with open(sidecar, encoding="utf-8") as f:
            data = json.load(f)
        listed = [o.get("image") for o in data.get("overlays", []) if isinstance(o, dict)]
    except (OSError, ValueError, AttributeError, TypeError):
        return []  # unreadable: only the sidecar itself goes
    injuries_dir = os.path.realpath(os.path.join(folder, "Injuries"))
    images: list[str] = []
    for rel in listed:
        if not isinstance(rel, str) or not rel:
            continue
        path = os.path.realpath(os.path.join(folder, rel))
        if _inside(path, injuries_dir) and os.path.isfile(path):
            images.append(path)
    return images


def _remove_injuries_files(folder: str, name: str, images: list[str], keep: set[str]) -> list[str]:
    """Delete an earlier export's injuries files, except those in `keep` (the _path_key of each file this export wrote
    over them): each of `images` with its .meta, then <name>_injuries.json with its .meta, then the Injuries folder
    (and its .meta) when it is empty. Returns what was removed."""
    root = os.path.realpath(folder)
    removed: list[str] = []
    for path in images:
        if _path_key(path) in keep:
            continue
        if os.path.isfile(path) and _remove_file(path):
            removed.append(_relative(root, path))
        if os.path.isfile(path + ".meta"):
            _remove_file(path + ".meta")
    sidecar = os.path.join(folder, f"{name}_injuries.json")
    if _path_key(sidecar) not in keep:
        if os.path.isfile(sidecar) and _remove_file(sidecar):
            removed.append(os.path.basename(sidecar))
        if os.path.isfile(sidecar + ".meta"):
            _remove_file(sidecar + ".meta")
    _remove_dir_if_empty(os.path.join(root, "Injuries"))
    return removed


def _remove_earlier_injuries(folder: str, name: str) -> list[str]:
    """Delete the injuries files an earlier export left in `folder`: the images <name>_injuries.json lists (each with
    its .meta, and only inside <folder>/Injuries, path-checked), then the sidecar. Returns what was removed."""
    images = _earlier_images(folder, name)
    if images is None:
        return []
    return _remove_injuries_files(folder, name, images, set())


def _unused_stem(stem: str, used: set[str]) -> str:
    """`stem`, or stem_0001, stem_0002... when this export already used it (as CC5 names its copies)."""
    candidate, n = stem, 0
    while candidate.lower() in used:
        n += 1
        candidate = f"{stem}_{n:04d}"
    used.add(candidate.lower())
    return candidate


def _material_component(avatar: Any) -> Any:
    try:
        return avatar.GetMaterialComponent()
    except Exception:
        return None


def _overlay_file(mat_comp: Any, overlay: dict[str, Any], dest_stem: str) -> str | None:
    """Write the image of one overlay (see skin_export_state) to dest_stem + an extension and return that path, or
    None. None at once for a stale overlay (P-1): which image CC5 shows is not known, and CC5's GetImage is not
    verified live, so it is not asked either.

    First overlay['image'], the file this bridge loaded there (its BLEND_SOURCES record; the exact file, no RLPy call),
    copied with its own extension over any earlier file of that name. Otherwise CC5's image of the layer, saved as
    PNG: overlays this bridge did not load (a .ccAvatar's).
    """
    if overlay.get("stale"):
        return None
    mesh, mat = overlay["mesh"], overlay["material"]
    source = overlay.get("image")
    if isinstance(source, str) and os.path.isfile(source):
        copied: str | None = dest_stem + os.path.splitext(source)[1]
        try:
            if not (os.path.exists(copied) and os.path.samefile(source, copied)):
                shutil.copy2(source, copied)
        except OSError:
            copied = None
        if copied is not None:
            try:
                os.utime(copied, None)  # written by this export, so the export's file list includes it
            except OSError:
                pass
            return copied
    dest = dest_stem + ".png"
    if os.path.isfile(dest):
        _remove_file(dest)  # a file left by an earlier export must not pass for this one
    try:
        # LIVE-VERIFY (F-75): what GetImage returns for a Diffuse Blend layer (RIImage, else a QImage).
        image = mat_comp.GetImage(mesh, mat, RLPy.EMaterialTextureChannel_DiffuseBlend) if mat_comp else None
    except Exception:
        image = None
    if image is not None:
        for method in ("SaveFile", "save"):  # RIImage.SaveFile(path); QImage.save(path)
            save = getattr(image, method, None)
            if not callable(save):
                continue
            try:
                save(dest)
            except Exception:
                continue
            if os.path.isfile(dest) and os.path.getsize(dest) > 0:
                return dest
    if os.path.isfile(dest) and os.path.getsize(dest) == 0:
        _remove_file(dest)
    return None


def _exported_diffuse(files: list[dict[str, Any]], material: str) -> tuple[str | None, str | None]:
    """(this export's <material>_Diffuse image, None), or (None, why there is no single one). Only `files` count:
    list_files since the export started, so an older file never does."""
    exact = re.compile(rf"^{re.escape(material)}_Diffuse\.{_DIFFUSE_TYPES}$", re.IGNORECASE)
    numbered = re.compile(rf"^{re.escape(material)}_Diffuse_\d{{4}}\.{_DIFFUSE_TYPES}$", re.IGNORECASE)
    paths = [f.get("path", "") for f in files if isinstance(f, dict)]
    found = [p for p in paths if exact.match(os.path.basename(p))]
    copies = [p for p in paths if numbered.match(os.path.basename(p))]
    if len(found) == 1 and not copies:
        return found[0], None
    if found or copies:
        names = ", ".join(sorted(os.path.basename(p) for p in found + copies))
        return None, (f"{material}: this export wrote {len(found) + len(copies)} diffuse images for materials named "
                      f"{material} ({names}), and which one is this mesh's is unknown, so nothing was baked")
    return None, f"{material}: this export wrote no {material}_Diffuse image, so nothing was baked into it"


def _ship_overlays(avatar: Any, state: dict[str, Any], folder: str, name: str, files: list[dict[str, Any]],
                   report: dict[str, Any], written: set[str]) -> None:
    """injuries 'separate': each overlay image into <folder>/Injuries/<Material>_DiffuseBlend.<ext>, and the values a
    Unity material needs into <folder>/<name>_injuries.json, each over an earlier file of that name, so its Unity .meta
    stays (P-6). Adds the _path_key of every file it wrote to `written`. A stale overlay is not shipped (P-1). The
    exported textures stay as CC5 wrote them."""
    mat_comp = _material_component(avatar)
    injuries_dir = os.path.join(folder, "Injuries")
    used: set[str] = set()
    overlays: list[dict[str, Any]] = []
    if any(not overlay.get("stale") for overlay in state["overlays"]):
        os.makedirs(injuries_dir, exist_ok=True)
    for overlay in state["overlays"]:
        mat = overlay["material"]
        if overlay.get("stale"):
            report["failed"].append(f"{mat}: {_IMAGE_NOT_KNOWN}")
            continue
        path = _overlay_file(mat_comp, overlay, os.path.join(injuries_dir, _unused_stem(f"{mat}_DiffuseBlend", used)))
        if path is None:
            report["failed"].append(f"{mat}: {_NOT_READABLE}")
            continue
        written.add(_path_key(path))
        image = _relative(folder, path)
        diffuse, _reason = _exported_diffuse(files, mat)
        overlays.append({"mesh": overlay["mesh"], "material": mat, "image": image, "strength": overlay["strength"],
                         "diffuse": _relative(folder, diffuse) if diffuse else None})
        if overlay["strength"] is None:
            report["done"].append(f"{image} ({mat}, strength unknown)")
            report["notes"].append(f"{mat}: strength unknown in the sidecar (null)")
        else:
            report["done"].append(f"{image} ({mat}, {_pct(overlay['strength'])}%)")
    if not overlays:
        _remove_dir_if_empty(injuries_dir)
    pallor = [dict(p) for p in state["pallor"]]
    tints = [dict(t) for t in state["tints"]] if TINT_REACHES_UNITY is not True else []
    if not (overlays or pallor or tints):
        return
    sidecar = os.path.join(folder, f"{name}_injuries.json")
    data = {"format": 1, "character": name, "fbx": f"{name}.fbx", "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "blend": OVERLAY_BAKE_MODE, "overlays": overlays, "pallor": pallor, "tints": tints}
    try:
        text = json.dumps(data, indent=2)
        with open(sidecar, "w", encoding="utf-8") as f:
            f.write(text)
    except (OSError, TypeError, ValueError) as e:
        report["failed"].append(f"{name}_injuries.json could not be written ({e})")
        _remove_file(sidecar)  # a part-written file, or an earlier export's, must not pass for this export's
        return
    written.add(_path_key(sidecar))
    if pallor or tints:
        mats = list(dict.fromkeys(entry["material"] for entry in pallor + tints))
        report["done"].append(f"{name}_injuries.json: skin-condition values for {', '.join(mats)}")
    report["sidecar"] = os.path.abspath(sidecar)


def bake_plan(strength: float | None, brightness: float, saturation: float,
              tint: Any = None) -> tuple[list[tuple[Any, ...]], list[str]]:
    """The bake steps for one material, in painting order: desaturate (saturation below 0), brighten (brightness above
    0), tint, then the overlay at min(1, strength * OVERLAY_BAKE_GAIN). Problems: what a bake cannot do."""
    ops: list[tuple[Any, ...]] = []
    problems: list[str] = []
    brightness = float(brightness or 0.0)
    saturation = float(saturation or 0.0)
    if brightness < -_OFFSET_ZERO:
        problems.append("Brightness below 0 cannot be baked")
    if saturation > _OFFSET_ZERO:
        problems.append("Saturation above 0 cannot be baked")
    if saturation < -_OFFSET_ZERO:
        ops.append(("desaturate", min(1.0, -saturation * PALLOR_BAKE_SATURATION_GAIN)))
    if brightness > _OFFSET_ZERO:
        ops.append(("brighten", brightness * PALLOR_BAKE_BRIGHTNESS_GAIN))
    if tint is not None:
        ops.append(("tint", tuple(float(c) for c in tint)))
    if strength is not None:
        ops.append(("overlay", OVERLAY_BAKE_MODE, min(1.0, strength * OVERLAY_BAKE_GAIN)))
    return ops, problems


def _channel(value: float) -> int:
    """One 8-bit channel, rounded half up and clamped, as QPainter's 8-bit intermediates hold it."""
    return max(0, min(255, int(value + 0.5)))


def _blend_channel(mode: str, c: int, b: int) -> float:
    """Composition mode `mode` of overlay channel b over image channel c (both 0-255)."""
    if mode == "Multiply":
        return c * b / 255.0
    if mode == "Screen":
        return c + b - c * b / 255.0
    if mode == "Overlay":
        return 2.0 * c * b / 255.0 if 2 * c < 255 else 255.0 - 2.0 * (255 - c) * (255 - b) / 255.0
    raise ValueError(f"blend mode {mode} is not supported")


def baked_pixel(rgb: Any, blend_rgba: Any, ops: list[tuple[Any, ...]]) -> tuple[int, int, int]:
    """The reference result of `ops` on one 8-bit pixel, rounded after each step as QPainter's 8-bit intermediates
    are. blend_rgba: the overlay image's pixel there (alpha 255 when it has three values), or None."""
    c = [_channel(v) for v in rgb[:3]]
    for op in ops:
        kind = op[0]
        if kind == "desaturate":
            gray = (c[0] * 11 + c[1] * 16 + c[2] * 5) // 32  # Qt's qGray
            c = [_channel(v * (1.0 - op[1]) + gray * op[1]) for v in c]
        elif kind == "brighten":
            c = [_channel(min(255.0, v + 255.0 * op[1])) for v in c]
        elif kind == "tint":
            c = [_channel(v * t) for v, t in zip(c, op[1])]
        elif kind == "overlay":
            if blend_rgba is None:
                continue
            alpha = blend_rgba[3] if len(blend_rgba) > 3 else 255
            a = op[2] * alpha / 255.0
            c = [_channel(v * (1.0 - a) + _blend_channel(op[1], v, b) * a) for v, b in zip(c, blend_rgba[:3])]
        else:
            raise ValueError(f"unknown bake step {kind}")
    return c[0], c[1], c[2]


def _paint(diffuse: Any, blend: Any, ops: list[tuple[Any, ...]]) -> Any:
    """`ops` painted with QPainter on an ARGB32_Premultiplied copy of `diffuse`; returns that copy. One painter per
    step, so desaturate reads the image as the steps before it left it. The overlay is `blend`, scaled to the
    diffuse size when it differs."""
    from PySide2 import QtCore, QtGui  # here, not at module load: only CC5 (and the tests' stand-in) has PySide2
    image = diffuse.convertToFormat(QtGui.QImage.Format_ARGB32_Premultiplied)
    for op in ops:
        kind = op[0]
        source = None
        if kind == "desaturate":
            source = image.convertToFormat(QtGui.QImage.Format_Grayscale8)
        elif kind == "overlay":
            if blend is None:
                continue
            source = blend
            if (blend.width(), blend.height()) != (image.width(), image.height()):
                source = blend.scaled(image.width(), image.height(), QtCore.Qt.IgnoreAspectRatio,
                                      QtCore.Qt.SmoothTransformation)
        elif kind not in ("brighten", "tint"):
            raise ValueError(f"unknown bake step {kind}")
        painter = QtGui.QPainter(image)
        try:
            if kind == "desaturate":
                painter.setOpacity(op[1])
                painter.drawImage(0, 0, source)
            elif kind == "brighten":
                painter.setCompositionMode(QtGui.QPainter.CompositionMode_Plus)
                painter.setOpacity(op[1])
                painter.fillRect(image.rect(), QtGui.QColor(255, 255, 255))
            elif kind == "tint":
                painter.setCompositionMode(QtGui.QPainter.CompositionMode_Multiply)
                painter.fillRect(image.rect(), QtGui.QColor.fromRgbF(*op[1]))
            else:
                painter.setCompositionMode(getattr(QtGui.QPainter, f"CompositionMode_{op[1]}"))
                painter.setOpacity(op[2])
                painter.drawImage(0, 0, source)
        finally:
            painter.end()
    return image


def _max_bake_error(original: Any, painted: Any, blend_scaled: Any, ops: list[tuple[Any, ...]]) -> int:
    """The largest channel difference between `painted` and baked_pixel, over an 8x8 grid of sample points."""
    width, height = original.width(), original.height()
    worst = 0
    for gy in range(8):
        for gx in range(8):
            x = min(width - 1, (2 * gx + 1) * width // 16)
            y = min(height - 1, (2 * gy + 1) * height // 16)
            o = original.pixelColor(x, y)
            p = painted.pixelColor(x, y)
            blend = None
            if blend_scaled is not None:
                b = blend_scaled.pixelColor(x, y)
                blend = (b.red(), b.green(), b.blue(), b.alpha())
            want = baked_pixel((o.red(), o.green(), o.blue()), blend, ops)
            worst = max(worst, abs(want[0] - p.red()), abs(want[1] - p.green()), abs(want[2] - p.blue()))
    return worst


def _paint_bake(path: str, blend_path: str | None, ops: list[tuple[Any, ...]]) -> str | None:
    """Bake `ops` into the image at `path`, saved over it in its own format (JPG at quality 95). None when written,
    else why the file was left as CC5 wrote it. The temp overlay copy `blend_path` is removed in any case.

    An image with an alpha channel is left alone (P-7): QPainter's Multiply, Plus and SourceOver write alpha where the
    image is transparent, so a bake would fill its cutouts, and the self-check compares colour only."""
    name = os.path.basename(path)
    try:
        from PySide2 import QtCore, QtGui  # here, not at module load: only CC5 (and the tests' stand-in) has PySide2
        original = QtGui.QImage(path)
        if original.isNull():
            return f"Qt could not read {name}"
        if original.hasAlphaChannel():
            return (f"{name} has an alpha channel (transparency), which a bake would change: use separate for this "
                    "character")
        blend = None
        if blend_path is not None:
            loaded = QtGui.QImage(blend_path)
            if loaded.isNull():
                return f"Qt could not read the overlay image for {name}"
            blend = loaded.scaled(original.width(), original.height(), QtCore.Qt.IgnoreAspectRatio,
                                  QtCore.Qt.SmoothTransformation)
        painted = _paint(original, blend, ops)
        error = _max_bake_error(original, painted, blend, ops)
        if error > BAKE_CHECK_TOLERANCE:
            return (f"{name}: the painted result differs from the bake formula by {error}/255, so the file was left "
                    "as CC5 wrote it")
        suffix = os.path.splitext(path)[1].lstrip(".").lower()
        if not painted.save(path, suffix, 95 if suffix in ("jpg", "jpeg") else -1):
            return f"Qt could not write {name}"
        return None
    finally:
        if blend_path is not None and os.path.isfile(blend_path):
            _remove_file(blend_path)


def _bake_material(mat_comp: Any, mat: str, parts: dict[str, Any], folder: str, files: list[dict[str, Any]],
                   overlay_stem: str, report: dict[str, Any]) -> None:
    """Bake one material's overlay, pallor and tint into its diffuse image, or add why not to report['failed']."""
    overlay, pallor, tint = parts.get("overlay"), parts.get("pallor"), parts.get("tint")
    if overlay is not None and overlay.get("stale"):
        report["failed"].append(f"{mat}: {_IMAGE_NOT_KNOWN}")
        return
    if overlay is not None and overlay["strength"] is None:
        report["failed"].append(f"{mat}: the overlay's strength is unknown (CC5 reads 0 until it renders): run "
                                "capture_viewport, then export again")
        return
    ops, problems = bake_plan(overlay["strength"] if overlay else None,
                              pallor["brightness"] if pallor else 0.0, pallor["saturation"] if pallor else 0.0,
                              tint["rgb"] if tint else None)
    if problems:
        report["failed"] += [f"{mat}: {problem}" for problem in problems]
        return
    diffuse, reason = _exported_diffuse(files, mat)
    if diffuse is None:
        report["failed"].append(reason)
        return
    blend_path = None
    if overlay is not None:
        blend_path = _overlay_file(mat_comp, overlay, overlay_stem)
        if blend_path is None:
            report["failed"].append(f"{mat}: {_NOT_READABLE}")
            return
    reason = _paint_bake(diffuse, blend_path, ops)
    if reason:
        report["failed"].append(reason)
        return
    baked: list[str] = []
    if overlay is not None:
        baked.append(f"overlay {_pct(overlay['strength'])}%")
    if pallor is not None:
        baked.append("pale" if pallor["brightness"] >= 0 and pallor["saturation"] <= 0 else "skin brightness/saturation")
    if tint is not None:
        baked.append(f"tint ({_rgb_text(tint['rgb'])})")
    report["done"].append(f"{_relative(folder, diffuse)}: {', '.join(baked)}")


def _bake_into_export(avatar: Any, state: dict[str, Any], folder: str, files: list[dict[str, Any]],
                      report: dict[str, Any]) -> None:
    """injuries 'bake': for each material with an overlay, pallor, or a tint when TINT_REACHES_UNITY is False, paint
    them into this export's <material>_Diffuse image. Fails closed per material: anything unsure leaves the file."""
    mat_comp = _material_component(avatar)
    plan: dict[tuple[str, str], dict[str, Any]] = {}
    tints = state["tints"] if TINT_REACHES_UNITY is False else []
    for kind, entries in (("overlay", state["overlays"]), ("pallor", state["pallor"]), ("tint", tints)):
        for entry in entries:
            plan.setdefault((entry["mesh"], entry["material"]), {})[kind] = entry
    temp_dir = tempfile.mkdtemp(prefix="cc5_bake_")
    try:
        for index, ((_mesh, mat), parts) in enumerate(plan.items()):
            try:
                _bake_material(mat_comp, mat, parts, folder, files, os.path.join(temp_dir, f"overlay_{index}"), report)
            except Exception as e:
                report["failed"].append(f"{mat}: the bake failed ({e}), so the file was left as CC5 wrote it")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def carry_injuries(avatar: Any, state: dict[str, Any], choice: str | None, folder: str, name: str,
                   files: list[dict[str, Any]]) -> dict[str, Any]:
    """Carry the injuries in `state` into the export in `folder` as `choice` says, and return the report.

    For every choice, the injuries files of an earlier export into this folder go: an old sidecar would make a Unity
    material blend an old overlay over this export. None, 'omit' and 'bake' remove them first; then None and 'omit'
    do nothing more, and 'bake' paints this export's diffuse textures. 'separate' first writes the overlay images and
    the sidecar, over the earlier files of the same names so that their Unity .meta files (GUIDs, import settings)
    stay, and then removes only the earlier files it did not write again (P-6). `files` are this export's files
    (list_files since it started)."""
    report = injury_report(state, choice)
    if choice != "separate":
        _note_removed(report, _remove_earlier_injuries(folder, name))
        if choice == "bake":
            _bake_into_export(avatar, state, folder, files, report)
        return report
    earlier = _earlier_images(folder, name)  # read before the sidecar is written again
    written: set[str] = set()
    try:
        _ship_overlays(avatar, state, folder, name, files, report, written)
    finally:
        if earlier is not None:
            _note_removed(report, _remove_injuries_files(folder, name, earlier, written))
    return report


def _note_removed(report: dict[str, Any], removed: list[str]) -> None:
    if removed:
        report["notes"].append(f"Removed the injuries files of an earlier export: {', '.join(removed)}")


ACTIONS: dict[str, Any] = {
    "apply_skin_overlay": lambda p: apply_skin_overlay(p["image_path"], p.get("region", "all"), float(p.get("strength", 100))),
    "remove_skin_overlay": lambda p: remove_skin_overlay(p.get("region", "all")),
    "set_skin_condition": lambda p: set_skin_condition(p["condition"], float(p.get("amount", 1.0)), p.get("region", "all"), p.get("base_rgb")),
    "set_wrinkle_strength": lambda p: set_wrinkle_strength(float(p["strength"])),
    # Lives in cc5_api beside set_skin_color; registered here (extension modules carry new actions).
    "set_skin_shader": lambda p: cc5_api.set_skin_shader(p["parameter_name"], p["values"]),
}
POST_ROUTES: dict[str, str] = {
    "/skin/overlay": "apply_skin_overlay",
    "/skin/overlay/remove": "remove_skin_overlay",
    "/skin/condition": "set_skin_condition",
    "/skin/wrinkle": "set_wrinkle_strength",
    "/skin/shader": "set_skin_shader",
}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "apply_skin_overlay": ["image_path"],
    "set_skin_condition": ["condition"],
    "set_wrinkle_strength": ["strength"],
    "set_skin_shader": ["parameter_name", "values"],
}
