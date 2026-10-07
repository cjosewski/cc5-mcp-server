"""
F-34: a before/after comparison around a character-content load.

Chad (2026-10-05): every preset load is checked before and after and reports what else changed. That is protocol,
not the agent's judgment, and P7-3 showed clothing does it too (the US Army uniform pants swapped out CC4 Kevin's
Boxers while the recipe said every step succeeded). load_asset reads the target character just before and just after
RFileIO.LoadFile, in the same main-thread command, and returns the differences as plain facts (`changes`); the MCP
server (src/change-report.ts) turns them into CHECK / NOT CHECKED lines.

It only reads. It makes no BeginAction of its own and no RenderImage, Undo, Redo, SetRenderExportParameter, camera or
selection call, and it never reads GetGlossinessWeight, GetSpecularWeight or GetTextureWeights, which are stale until
CC5 renders (F-65).

It is not an extension module: it has no ACTIONS and is never added to server.EXTENSION_MODULES (load_extensions
merges every listed module's ACTIONS, so listing it would stop the bridge from starting). cc5_api imports it lazily,
inside load_asset, and drops it from sys.modules at its own import, so /reload picks up changes to this file too.
"""

from __future__ import annotations

import math
import os
import time
from typing import Any

import RLPy

# Applied to each read separately (before and after the load), each counted from its own start: a load that waited
# for the user's answer in a CC5 dialog is still compared afterwards.
TIME_LIMIT_SECONDS = 2.5
# At most this many facts are returned; `truncated` says when there were more.
MAX_FACTS = 300
# Every deadline and duration (tests patch it).
_now = time.monotonic

# CC5_CHANGE_CHECK switches the comparison off: an operator's escape hatch, set only when a person launches CC5 for
# debugging. Every load then says so.
_OFF_VALUES = ("0", "false", "no", "off")
# (group, label): the worn-item groups, and how a group CC5 could not read is named in the WARNING note.
_WORN_GROUPS = (("clothing", "clothing"), ("hair", "hair"), ("accessory", "accessories"))
_BODY_MESH = "CC_Base_Body"

SWITCHED_OFF = "WARNING: the before/after comparison is switched off (CC5_CHANGE_CHECK=0): nothing was compared"
NOT_READ_BEFORE = "WARNING: the character could not be read before the load ({}), so nothing was compared"
NOT_FOUND_AFTER = "WARNING: the character was not found after the load, so nothing was compared afterwards"
NOT_COMPARED = "WARNING: not compared, because CC5 could not read them before or after the load: {}"
FAILED_AFTER = "WARNING: the before/after comparison failed after the load: {}"


def enabled() -> bool:
    """Whether the comparison runs: CC5_CHANGE_CHECK 0, false, no or off switches it off (read on every call)."""
    return os.environ.get("CC5_CHANGE_CHECK", "").strip().lower() not in _OFF_VALUES


def _is_padding(name: Any) -> bool:
    # The same rule as cc5_api._is_shader_padding (F-69), duplicated rather than imported: this module never imports
    # cc5_api.
    return str(name).lower().startswith("padding")


# --- Plain values: every stored value is an int, float, str, bool or a list of floats. A value that cannot be
# coerced, or a float that is not finite, counts as unread and its field is left out of the comparison (the reply
# must stay JSON without NaN: cc5-bridge.ts parses it with response.json()). ---

def _number(value: Any, digits: int) -> float:
    """`value` as a finite float rounded to `digits`; raises for anything else."""
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"not a finite number: {number}")
    return round(number, digits)


def _channel(value: Any) -> int:
    """A colour channel on CC5's 0-255 scale, as get_diffuse_color reads it."""
    return int(_number(value, 0))


# --- One read of the character ---

def _worn_items(avatar: Any, group: str) -> Any:
    if group == "clothing":
        return avatar.GetClothes()
    if group == "hair":
        return avatar.GetHairs()
    return avatar.GetAccessories(True)


def _read_worn(avatar: Any, group: str) -> dict[str, dict[str, Any]]:
    """{str(id): {name, meshes}} for one worn-item group; raises when CC5 cannot list the group."""
    items = _worn_items(avatar, group)
    worn: dict[str, dict[str, Any]] = {}
    for item in (list(items) if items is not None else []):
        try:
            # Read the same way as set_hair_color reads hair items; a failure only loses the mesh names.
            meshes = [str(m) for m in (item.GetMeshNames(True) or [])]
        except Exception:
            meshes = []
        worn[str(item.GetID())] = {"name": str(item.GetName()), "meshes": meshes}
    return worn


def _read_morphs(avatar: Any) -> tuple[dict[str, Any], int]:
    """({id: weight}, sliders read) for the shaping morphs; raises when CC5 cannot read them.

    Only sliders away from 0 are kept (a slider missing from a read counts as 0). A slider whose weight is not a
    finite number is kept as None: it is left out of the comparison and not counted as read.
    """
    comp = avatar.GetAvatarShapingComponent()
    morphs: dict[str, Any] = {}
    total = 0
    if comp is None:
        return morphs, total
    for category in list(comp.GetShapingMorphCatergoryNames()):  # CC5's own spelling, as in cc5_api.get_avatar_info
        for morph_id in list(comp.GetShapingMorphIDs(category)):
            raw = comp.GetShapingMorphWeight(morph_id)
            try:
                weight = _number(raw, 4)
            except (TypeError, ValueError, OverflowError):
                morphs[str(morph_id)] = None
                continue
            total += 1
            if abs(weight) > 1e-4:
                morphs[str(morph_id)] = weight
    return morphs, total


def _list_materials(avatar: Any, mat_comp: Any) -> tuple[list[tuple[str, str]], list[str]]:
    """((mesh, material) keys, meshes whose materials CC5 could not list); raises when the meshes cannot be listed."""
    meshes = list(dict.fromkeys(str(m) for m in avatar.GetMeshNames(True)))
    if _BODY_MESH in meshes:
        meshes.remove(_BODY_MESH)
        meshes.insert(0, _BODY_MESH)
    keys: list[tuple[str, str]] = []
    unlisted: list[str] = []
    for mesh in meshes:
        try:
            names = mat_comp.GetMaterialNames(mesh)
            found = [(mesh, str(m)) for m in (list(names) if names is not None else [])]
        except Exception:
            unlisted.append(mesh)
            continue
        keys += found
    return list(dict.fromkeys(keys)), unlisted


def _read_material(mat_comp: Any, mesh: str, material: str) -> dict[Any, Any]:
    """The material's compared fields, in read order. A field that fails, or holds no finite number, is left out."""
    fields: dict[Any, Any] = {}
    if hasattr(mat_comp, "GetShader"):
        try:
            fields["shader"] = str(mat_comp.GetShader(mesh, material))
        except Exception:
            pass
    try:
        color = mat_comp.GetDiffuseColor(mesh, material)
        fields["diffuse"] = [_channel(color.Red()), _channel(color.Green()), _channel(color.Blue())]
    except Exception:
        pass
    try:
        # CC5 keeps opacity on 0-100 (cc5_api._from_weight_scale).
        fields["opacity"] = _number(float(mat_comp.GetOpacity(mesh, material)) / 100.0, 3)
    except Exception:
        pass
    if hasattr(RLPy, "EMaterialTextureChannel_DiffuseBlend") and hasattr(mat_comp, "HasImage"):
        try:
            fields["blend_image"] = bool(mat_comp.HasImage(mesh, material, RLPy.EMaterialTextureChannel_DiffuseBlend))
        except Exception:
            pass
    try:
        names = list(mat_comp.GetShaderParameterNames(mesh, material) or [])
    except Exception:
        names = []
    for name in names:
        if _is_padding(name):
            continue  # shader filler, never read (F-69)
        try:
            fields[("param", str(name))] = [_number(v, 3) for v in mat_comp.GetShaderParameter(mesh, material, name)]
        except Exception:
            pass
    return fields


def snapshot(avatar: Any, deadline: float, prefer: Any = ()) -> dict[str, Any]:
    """The character's worn items, shaping morphs, subdivision level and materials, read at one moment. Never raises.

    Each part sits in its own try: a part CC5 cannot read is named in `unread` and left out of the comparison.
    Material values are read until _now() reaches `deadline`, the keys in `prefer` first (the materials the read
    before the load got to), so the rest are not read.

    Returns {worn, morphs, morph_total, subdivision?, keys, unlisted, values, unread, ms}: `worn` holds only the
    groups that were read, and `morphs` / `keys` are None when they could not be read.
    """
    start = _now()
    snap: dict[str, Any] = {"worn": {}, "morphs": None, "morph_total": 0, "keys": None, "unlisted": [],
                            "values": {}, "unread": [], "ms": 0.0}
    for group, label in _WORN_GROUPS:
        try:
            snap["worn"][group] = _read_worn(avatar, group)
        except Exception:
            snap["unread"].append(label)
    try:
        snap["morphs"], snap["morph_total"] = _read_morphs(avatar)
    except Exception:
        snap["morphs"], snap["morph_total"] = None, 0
        snap["unread"].append("shaping morphs")
    try:
        if hasattr(avatar, "GetSubdivMeshLevel"):
            snap["subdivision"] = int(avatar.GetSubdivMeshLevel())
    except Exception:
        pass  # left out silently: an unreadable level does not make the comparison incomplete
    mat_comp = None
    try:
        mat_comp = avatar.GetMaterialComponent()
        if mat_comp is None:
            raise RuntimeError("the character has no material component")
        snap["keys"], snap["unlisted"] = _list_materials(avatar, mat_comp)
    except Exception:
        snap["keys"], snap["unlisted"] = None, []
        snap["unread"].append("the material list")
    if snap["keys"] is not None:
        try:
            listed = set(snap["keys"])
            order = [key for key in dict.fromkeys(prefer) if key in listed]
            first = set(order)
            order += [key for key in snap["keys"] if key not in first]
            for key in order:
                if _now() >= deadline:
                    break  # out of time: the rest are not read (finish counts them in `skipped`)
                snap["values"][key] = _read_material(mat_comp, key[0], key[1])
        except Exception:
            pass
    try:
        snap["ms"] = (_now() - start) * 1000.0
    except Exception:
        pass
    return snap


# --- The comparison ---

def diff(a: dict[str, Any], b: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    """(facts, truncated): what differs between the read before (a) and after (b) the load.

    Facts come in the order worn, morph, material, subdivision, at most MAX_FACTS of them.
    """
    facts: list[dict[str, Any]] = []
    # Meshes of the worn items that came or went: their materials are reported once, by the worn fact.
    item_meshes: set[str] = set()
    for group, _label in _WORN_GROUPS:
        if group not in a["worn"] or group not in b["worn"]:
            continue
        before, after = a["worn"][group], b["worn"][group]
        for item_id, item in after.items():
            if item_id not in before:
                facts.append({"kind": "worn_added", "group": group, "id": item_id, "name": item["name"]})
                item_meshes.update(item["meshes"])
        for item_id, item in before.items():
            if item_id not in after:
                facts.append({"kind": "worn_removed", "group": group, "id": item_id, "name": item["name"]})
                item_meshes.update(item["meshes"])

    if a["morphs"] is not None and b["morphs"] is not None:
        morphs_a, morphs_b = a["morphs"], b["morphs"]
        for morph_id in list(morphs_a) + [m for m in morphs_b if m not in morphs_a]:
            before_w, after_w = morphs_a.get(morph_id, 0.0), morphs_b.get(morph_id, 0.0)
            if before_w is None or after_w is None:
                continue  # unreadable in one read: not compared
            if abs(after_w - before_w) > 1e-4:
                facts.append({"kind": "morph", "id": morph_id, "before": before_w, "after": after_w})

    if a["keys"] is not None and b["keys"] is not None:
        keys_a, keys_b = set(a["keys"]), set(b["keys"])
        unlisted = set(a["unlisted"]) | set(b["unlisted"])
        for key in list(a["keys"]) + [k for k in b["keys"] if k not in keys_a]:
            mesh, material = key
            if (key in keys_a) != (key in keys_b):
                # A garment, hair or accessory that came or went is reported by its worn fact, not again here; a
                # mesh whose materials one read could not list proves nothing.
                if mesh not in unlisted and mesh not in item_meshes:
                    facts.append({"kind": "material", "mesh": mesh, "material": material, "field": "present",
                                  "before": key in keys_a, "after": key in keys_b})
                continue
            values_a, values_b = a["values"].get(key), b["values"].get(key)
            if values_a is None or values_b is None:
                continue  # not read in both (time limit): counted in `skipped`
            for field, before_v in values_a.items():
                if field not in values_b or values_b[field] == before_v:
                    continue
                fact: dict[str, Any] = {"kind": "material", "mesh": mesh, "material": material}
                if isinstance(field, tuple):
                    fact["field"], fact["name"] = "param", field[1]
                else:
                    fact["field"] = field
                fact["before"], fact["after"] = before_v, values_b[field]
                facts.append(fact)

    if "subdivision" in a and "subdivision" in b and a["subdivision"] != b["subdivision"]:
        facts.append({"kind": "subdivision", "before": a["subdivision"], "after": b["subdivision"]})
    return facts[:MAX_FACTS], len(facts) > MAX_FACTS


def _counts(a: dict[str, Any], b: dict[str, Any]) -> tuple[int, int, int, int]:
    """(worn, morphs, materials, skipped) as the contract defines them."""
    worn = sum(len(set(a["worn"][g]) | set(b["worn"][g])) for g, _label in _WORN_GROUPS
               if g in a["worn"] and g in b["worn"])
    morphs = int(b["morph_total"]) if a["morphs"] is not None and b["morphs"] is not None else 0
    materials = skipped = 0
    if a["keys"] is not None and b["keys"] is not None:
        listed_after = set(b["keys"])
        for key in a["keys"]:
            if key not in listed_after:
                continue
            if key in a["values"] and key in b["values"]:
                materials += 1
            else:
                skipped += 1
    return worn, morphs, materials, skipped


def _stub(state: Any, extra_ms: float = 0.0) -> dict[str, Any]:
    """The `changes` of a load that was not compared."""
    state = state if isinstance(state, dict) else {}
    try:
        elapsed = int(round(float(state.get("before_ms") or 0.0) + extra_ms))
    except Exception:
        elapsed = 0
    return {"complete": False, "target": state.get("target"), "target_is_first": bool(state.get("target_is_first")),
            "elapsed_ms": elapsed, "compared": {"worn": 0, "morphs": 0, "materials": 0}, "skipped": 0,
            "truncated": False, "facts": []}


def _find_avatar(avatar_id: Any) -> Any:
    """The scene's character with this ID, as a fresh SWIG proxy, or None.

    Compared by ID, never with `is`: SWIG returns new proxy objects on every call.
    """
    for candidate in list(RLPy.RScene.GetAvatars()):
        try:
            if str(candidate.GetID()) == avatar_id:
                return candidate
        except Exception:
            continue
    return None


def begin(avatar: Any, target_name: Any) -> dict[str, Any]:
    """Read the target character just before the load. Never raises.

    Returns the state finish() needs: {enabled, avatar_id, target, target_is_first, before, before_ms, notes}.
    """
    state: dict[str, Any] = {"enabled": False, "avatar_id": None, "target": None, "target_is_first": False,
                             "before": None, "before_ms": 0.0, "notes": []}
    try:
        state["target"] = None if target_name is None else str(target_name)
        state["enabled"] = enabled()
        if not state["enabled"]:
            state["notes"] = [SWITCHED_OFF]
            return state  # no RLPy read at all
        t0 = _now()
        try:
            state["avatar_id"] = str(avatar.GetID())
            try:
                first = list(RLPy.RScene.GetAvatars())[0]
                state["target_is_first"] = str(first.GetID()) == state["avatar_id"]
            except Exception:
                state["target_is_first"] = False
            state["before"] = snapshot(avatar, t0 + TIME_LIMIT_SECONDS)
        except Exception as e:
            state["before"] = None
            state["notes"] = [NOT_READ_BEFORE.format(e)]
        state["before_ms"] = (_now() - t0) * 1000.0
    except Exception as e:
        state["before"] = None
        state["notes"] = [NOT_READ_BEFORE.format(e)]
    return state


def finish(state: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Read the character again after the load and compare: (changes, notes). Never raises.

    Takes no avatar: the handle from before the load is never used after LoadFile (CC5 may have rebuilt the
    character); the character is found again by its ID.
    """
    notes: list[str] = []
    try:
        notes = [str(n) for n in (state.get("notes") or [])]
        before = state.get("before")
        if not state.get("enabled") or before is None:
            return _stub(state), notes
        t0 = _now()
        found = _find_avatar(state.get("avatar_id"))
        if found is None:
            return _stub(state, (_now() - t0) * 1000.0), notes + [NOT_FOUND_AFTER]
        after = snapshot(found, t0 + TIME_LIMIT_SECONDS, prefer=list(before["values"]))
        facts, truncated = diff(before, after)
        unread = list(dict.fromkeys(list(before["unread"]) + list(after["unread"])))
        worn, morphs, materials, skipped = _counts(before, after)
        changes = {
            "complete": not unread,
            "target": state.get("target"),
            "target_is_first": bool(state.get("target_is_first")),
            "elapsed_ms": int(round(float(state.get("before_ms") or 0.0) + (_now() - t0) * 1000.0)),
            "compared": {"worn": worn, "morphs": morphs, "materials": materials},
            "skipped": skipped,
            "truncated": truncated,
            "facts": facts,
        }
        if unread:
            return changes, notes + [NOT_COMPARED.format(", ".join(unread))]
        return changes, notes
    except Exception as e:
        return _stub(state), notes + [FAILED_AFTER.format(e)]
