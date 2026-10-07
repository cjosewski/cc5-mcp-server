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

F-90: CC5 also reports a material's diffuse colour as it was when it last rendered, so the read before a load missed a
colour the bridge had set since then, and the load was blamed for it. load_asset therefore passes the bridge's record
of the colours and opacities it wrote since CC5 last rendered (cc5_api._writes_since_render): for a recorded material
the value written stands for the value before the load (diff), and finish() takes out of the record what CC5 reads
fresh after the load. A recorded field CC5 still reads as before it was written, after the load too, is named in a
NOT CHECKED note (review #1); the bridge then no longer knows what CC5 holds there, so the field leaves the record too
and the character joins the bridge's set of characters whose colour reads may be late
(cc5_api._colours_late_since_undo, batch F review #3). On a character in that set (one that was in the scene at an
undo or redo since CC5 last rendered, review #20, or one an earlier load added) the colour and opacity differences on
fields without a record are named in a NOT CHECKED note too, instead of being reported as changes. That record and
that set, both kept by the bridge, are the only things this module changes.

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
# Review #1: a field the bridge wrote that CC5 reads after the load as it read it before (A == B != the value written):
# either CC5 has not refreshed the read, or the load set it back to that value. Which one is not known, so the field
# also leaves the bridge's record and the character is marked as one whose colour reads may be late (batch F review #3,
# _settle).
NOT_REFRESHED = ("WARNING: CC5 still reports the {fields} from before the bridge set {it} on {materials}, so whether "
                 "this load changed {it} was not checked: capture, then compare")
# Review #20: after an undo or redo CC5's reads may still give the colours of its last render (cc5_api). Batch F review
# #14: that is inferred, not seen. CC5 reported a colour late after the bridge set it (F-90, live); after an undo or a
# redo nobody has checked, so the note says "may" and what was seen.
COLOURS_LATE = ("WARNING: CC5 may report material colours late after an undo, a redo or a load that left a colour "
                "unsettled (seen for a colour set without an undo, F-90; not checked live after an undo), so "
                "whether this load changed the {fields} on {materials} was not checked: capture, then compare")
# The fields those two notes are about, with the word each note uses for them.
_LATE_FIELDS = (("diffuse", "colour"), ("opacity", "opacity"))
# How many materials a note names before it counts the rest.
MAX_NAMED_MATERIALS = 12


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

def diff(a: dict[str, Any], b: dict[str, Any], written: Any = None,
         colours_late: bool = False) -> tuple[list[dict[str, Any]], bool, dict[str, list[tuple[str, str, str]]]]:
    """(facts, truncated, held): what differs between the read before (a) and after (b) the load.

    `written` holds what the bridge wrote to the character since CC5 last rendered (F-90), {(mesh, material): {field:
    value}}, as CC5 reports it after a render. CC5 may still report the value from before that write, so for such a
    field the value written is the value before the load. No fact is reported when the read after the load is the
    value written (CC5 caught up, and the load left it alone) or still the read from before; the latter goes to
    held["not_refreshed"] (review #1: CC5 has not refreshed it, or the load set it back, which the reads cannot tell
    apart). With `colours_late` (the character is in cc5_api._colours_late_since_undo: it was in the scene at an undo or
    redo since CC5 last rendered, review #20, or an earlier load left a recorded field it could not settle, batch F
    review #3), a diffuse colour or opacity without a record that differs goes to held["late"] instead of being a fact.
    Every other field is compared as read. Each held entry is (mesh, material, field).

    Facts come in the order worn, morph, material, subdivision, at most MAX_FACTS of them.
    """
    written = written if isinstance(written, dict) else {}
    late_fields = {field for field, _word in _LATE_FIELDS}
    held: dict[str, list[tuple[str, str, str]]] = {"not_refreshed": [], "late": []}
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
            recorded = written.get(key) or {}
            for field, before_v in values_a.items():
                if field not in values_b:
                    continue
                after_v = values_b[field]
                if field in recorded:
                    if after_v == recorded[field]:
                        continue
                    if after_v == before_v:
                        held["not_refreshed"].append((mesh, material, field))
                        continue
                    before_v = recorded[field]  # the value written: what CC5 held before the load
                elif after_v == before_v:
                    continue
                elif colours_late and field in late_fields:
                    held["late"].append((mesh, material, field))
                    continue
                fact: dict[str, Any] = {"kind": "material", "mesh": mesh, "material": material}
                if isinstance(field, tuple):
                    fact["field"], fact["name"] = "param", field[1]
                else:
                    fact["field"] = field
                fact["before"], fact["after"] = before_v, after_v
                facts.append(fact)

    if "subdivision" in a and "subdivision" in b and a["subdivision"] != b["subdivision"]:
        facts.append({"kind": "subdivision", "before": a["subdivision"], "after": b["subdivision"]})
    return facts[:MAX_FACTS], len(facts) > MAX_FACTS, held


def _held_note(template: str, entries: list[tuple[str, str, str]]) -> list[str]:
    """One note (NOT_REFRESHED or COLOURS_LATE) on the held (mesh, material, field) entries, naming the fields and the
    materials (the first MAX_NAMED_MATERIALS, then how many more); [] for none."""
    if not entries:
        return []
    fields = {field for _mesh, _material, field in entries}
    # colour before opacity; any other recorded field by its own name
    words = [word for field, word in _LATE_FIELDS if field in fields]
    words += sorted(str(field) for field in fields if field not in dict(_LATE_FIELDS))
    materials = list(dict.fromkeys(material for _mesh, material, _field in entries))
    named = ", ".join(materials[:MAX_NAMED_MATERIALS])
    more = len(materials) - MAX_NAMED_MATERIALS
    if more > 0:
        named = f"{named} and {more} more"
    return [template.format(fields=" and ".join(words), it="them" if len(words) > 1 else "it", materials=named)]


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


def _written_by_bridge(record: dict[Any, Any], avatar_id: str) -> dict[tuple[str, str], dict[str, Any]]:
    """This character's entries of the bridge's record (F-90), keyed (mesh, material) as the reads are, and copied: the
    comparison uses the record as it was before the load. Never raises; a record it cannot read counts as empty."""
    written: dict[tuple[str, str], dict[str, Any]] = {}
    try:
        for key, fields in list(record.items()):
            if isinstance(key, tuple) and len(key) == 3 and str(key[0]) == avatar_id and isinstance(fields, dict):
                written[(str(key[1]), str(key[2]))] = dict(fields)
    except Exception:
        return {}
    return written


def _mark_late(state: dict[str, Any]) -> None:
    """Add the character to the bridge's set of characters whose colour reads may be late (batch F review #3): the set
    begin() was handed (cc5_api._colours_late_since_undo), which a capture whose RenderImage wrote the file empties.
    The bridge's later colour reads of the character, and the next load's comparison, then take CC5's reads as
    possibly late. Never raises; without a set nothing is marked."""
    try:
        late, avatar_id = state.get("late_ids"), state.get("avatar_id")
        if isinstance(late, set) and avatar_id is not None:
            late.add(str(avatar_id))
    except Exception:
        pass


def _settle(state: dict[str, Any], before: dict[str, Any], after: dict[str, Any]) -> None:
    """Take out of the bridge's record (F-90) what CC5 reads fresh after the load, and what the bridge no longer knows.
    Never raises.

    A field goes when the read after the load is the value written (CC5 caught up), differs from the read before (CC5
    refreshed it, and the load changed it: the record no longer says what CC5 holds), or is still the read from before.
    In that last case (A == B != the value written, NOT_REFRESHED) CC5 has not refreshed the read or the load set the
    field back, and the reads cannot tell which; kept, the record would answer get_diffuse_color and the export's tint
    read with a colour the material may no longer have, so the field goes and the character is marked (_mark_late,
    batch F review #3). A material goes when the character no longer lists it. A field not read both times stays.
    """
    try:
        record, avatar_id = state.get("record"), state.get("avatar_id")
        if not isinstance(record, dict):
            return
        listed = None if after["keys"] is None else set(after["keys"])
        for key, fields in (state.get("written") or {}).items():
            entry = record.get((avatar_id,) + key)
            if not isinstance(entry, dict):
                continue
            if listed is not None and key not in listed and key[0] not in after["unlisted"]:
                record.pop((avatar_id,) + key, None)
                continue
            values_a, values_b = before["values"].get(key) or {}, after["values"].get(key) or {}
            for field, value in fields.items():
                if field not in values_b:
                    continue
                if values_b[field] == value:
                    entry.pop(field, None)  # CC5 caught up
                elif field in values_a:
                    if values_b[field] == values_a[field]:
                        _mark_late(state)  # batch F review #3: what CC5 holds there is not known any more
                    entry.pop(field, None)
            if not entry:
                record.pop((avatar_id,) + key, None)
    except Exception:
        pass


def _is_late(colours_late: Any, avatar_id: str) -> bool:
    """Whether the character `avatar_id` is among the ids in `colours_late` (cc5_api._colours_late_since_undo, review
    #20). Never raises: anything that is no collection of ids counts as none."""
    try:
        return avatar_id in {str(i) for i in colours_late}
    except Exception:
        return False


def begin(avatar: Any, target_name: Any, record: Any = None, colours_late: Any = ()) -> dict[str, Any]:
    """Read the target character just before the load. Never raises.

    `record` is the bridge's record of what it wrote since CC5 last rendered (cc5_api._writes_since_render, F-90):
    {(character id, mesh, material): {field: value}}. The comparison uses this character's entries, and finish() takes
    out of the record what CC5 reads fresh after the load. `colours_late` holds the ids of the characters whose colour
    reads may be late (cc5_api._colours_late_since_undo): those an undo or redo found in the scene since CC5 last
    rendered (review #20), and those an earlier load could not settle a recorded field on (batch F review #3). When
    this character is one of them, CC5's reads before the load may give the colours of its last render. A character
    loaded after the undo is not, and is compared as read. When `colours_late` is a set, finish() adds this character
    to it in turn when the load leaves a recorded field it cannot settle (_settle).

    Returns the state finish() needs: {enabled, avatar_id, target, target_is_first, before, before_ms, notes, record,
    written, colours_late, late_ids}, where colours_late says whether this character is one of them and late_ids is
    that set itself (None when `colours_late` is no set).
    """
    state: dict[str, Any] = {"enabled": False, "avatar_id": None, "target": None, "target_is_first": False,
                             "before": None, "before_ms": 0.0, "notes": [], "record": None, "written": {},
                             "colours_late": False, "late_ids": None}
    try:
        state["target"] = None if target_name is None else str(target_name)
        state["enabled"] = enabled()
        if not state["enabled"]:
            state["notes"] = [SWITCHED_OFF]
            return state  # no RLPy read at all
        t0 = _now()
        try:
            state["avatar_id"] = str(avatar.GetID())
            state["colours_late"] = _is_late(colours_late, state["avatar_id"])
            if isinstance(colours_late, set):
                state["late_ids"] = colours_late  # finish() may add this character to it (_settle, _mark_late)
            if isinstance(record, dict):
                state["record"], state["written"] = record, _written_by_bridge(record, state["avatar_id"])
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
    character); the character is found again by its ID. Then takes out of the bridge's record what CC5 reads fresh
    after the load and what the bridge no longer knows, and marks the character when CC5 still reads a recorded field
    as before (F-90, batch F review #3: _settle). The fields diff() held back are named in NOT_REFRESHED and
    COLOURS_LATE notes.
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
        facts, truncated, held = diff(before, after, state.get("written"), bool(state.get("colours_late")))
        _settle(state, before, after)
        notes += _held_note(NOT_REFRESHED, held["not_refreshed"]) + _held_note(COLOURS_LATE, held["late"])
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
