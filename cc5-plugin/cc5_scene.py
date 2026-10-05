"""
Scene selection: select scene items by name, read the selection, clear it. Also delete scene objects and
move or scale them.

CC5 applies much of its content (eye, skin, cloth presets dragged from the Content Manager) to the selected
character, so scripts need to set the selection the way a user clicks in the viewport or Scene Manager.
Selection is not an edit: these calls add nothing to CC5's undo history.
"""

from __future__ import annotations

from typing import Any

import RLPy

import cc5_api

MAX_SELECT_NAMES = 100

# Scene object types searched by name, besides avatars and the items an avatar wears.
_SCENE_TYPES = ("EObjectType_Prop", "EObjectType_SpotLight", "EObjectType_PointLight",
                "EObjectType_DirectionalLight", "EObjectType_Camera")

_TYPE_LABELS = {
    "EObjectType_Avatar": "Avatar", "EObjectType_Prop": "Prop", "EObjectType_SpotLight": "SpotLight",
    "EObjectType_PointLight": "PointLight", "EObjectType_DirectionalLight": "DirectionalLight",
    "EObjectType_Camera": "Camera", "EObjectType_Cloth": "Cloth", "EObjectType_Hair": "Hair",
    "EObjectType_Accessory": "Accessory",
}


def _type_label(obj: Any) -> str:
    try:
        value = obj.GetType()
    except Exception:
        return "Unknown"
    for const, label in _TYPE_LABELS.items():
        if hasattr(RLPy, const) and getattr(RLPy, const) == value:
            return label
    return f"Other (type {value})"


def _scene_candidates() -> list[Any]:
    """Every object selection can target: avatars, what they wear, props, lights and cameras (no duplicates)."""
    return [obj for obj, _group in _grouped_candidates()]


# Where an object was found decides what delete_object / set_object_transform may do with it (an allow-list by
# origin, not by GetType(): a type CC5 does not report, or reports as something unknown, is refused, never let
# through). Light and camera FindObjects types map to these groups.
_GROUP_OF_TYPE = {"EObjectType_Prop": "prop", "EObjectType_SpotLight": "light", "EObjectType_PointLight": "light",
                  "EObjectType_DirectionalLight": "light", "EObjectType_Camera": "camera"}


def _grouped_candidates() -> list[tuple[Any, str]]:
    """(object, group) for avatars ("avatar"), what they wear ("worn"), props, lights and cameras; no duplicates."""
    found: list[tuple[Any, str]] = []
    seen: set[Any] = set()

    def add(obj: Any, group: str) -> None:
        try:
            key = obj.GetID()
        except Exception:
            key = id(obj)
        if key not in seen:
            seen.add(key)
            found.append((obj, group))

    try:
        avatars = list(RLPy.RScene.GetAvatars())
    except Exception as e:
        print(f"[CC5 MCP Bridge] selection: GetAvatars failed: {e}")
        avatars = []
    for avatar in avatars:
        add(avatar, "avatar")
        for getter in (avatar.GetClothes, avatar.GetHairs, lambda: avatar.GetAccessories(True)):
            try:
                for item in getter():
                    add(item, "worn")
            except Exception as e:
                print(f"[CC5 MCP Bridge] selection: avatar item getter failed: {e}")
    for const in _SCENE_TYPES:
        if not hasattr(RLPy, const):
            continue
        try:
            for obj in RLPy.RScene.FindObjects(getattr(RLPy, const)):
                add(obj, _GROUP_OF_TYPE.get(const, "other"))
        except Exception as e:
            print(f"[CC5 MCP Bridge] selection: FindObjects({const}) failed: {e}")
    return found


def _describe(objs: Any) -> list[dict[str, Any]]:
    out = []
    for obj in objs:
        try:
            out.append({"name": obj.GetName(), "id": obj.GetID(), "type": _type_label(obj)})
        except Exception as e:
            print(f"[CC5 MCP Bridge] selection: describe failed: {e}")
    return out


def _selected() -> list[Any]:
    return list(RLPy.RScene.GetSelectedObjects() or [])


def _apply_selection(objs: list[Any]) -> None:
    RLPy.RScene.ClearSelectObjects()
    if not objs:
        return
    if len(objs) == 1:
        RLPy.RScene.SelectObject(objs[0])
    else:
        RLPy.RScene.SelectObjects(objs)


def select_objects(names: Any, add: bool = False) -> dict[str, Any]:
    """Select scene items by name. All names must resolve to exactly one item, or nothing changes."""
    if not isinstance(names, list) or not names:
        return {"success": False, "error": "names must be a non-empty list of item names"}
    if len(names) > MAX_SELECT_NAMES:
        return {"success": False, "error": f"Too many names ({len(names)}, max {MAX_SELECT_NAMES})"}
    for name in names:
        if not isinstance(name, str) or not name or len(name) > cc5_api.MAX_ITEM_NAME_LENGTH:
            return {"success": False, "error": f"Invalid item name: {name!r}"}
    if not isinstance(add, bool):
        return {"success": False, "error": "add must be true or false"}

    try:
        candidates = _scene_candidates()
        targets: list[Any] = []
        missing: list[str] = []
        ambiguous: list[str] = []
        for name in dict.fromkeys(names):
            matches = [o for o in candidates if o.GetName() == name]
            if not matches:
                missing.append(name)
            elif len(matches) > 1:
                ambiguous.append(f"{name} ({len(matches)} items)")
            else:
                targets.append(matches[0])
        if missing:
            return {"success": False, "error": f"Object not found: {', '.join(missing)}"}
        if ambiguous:
            return {"success": False, "error": f"Name matches more than one item: {', '.join(ambiguous)}"}

        previous = _selected()
        wanted = (previous if add else []) + targets
        unique: list[Any] = []
        ids: set[Any] = set()
        for obj in wanted:
            if obj.GetID() not in ids:
                ids.add(obj.GetID())
                unique.append(obj)
    except Exception as e:
        return {"success": False, "error": str(e)}

    try:
        _apply_selection(unique)
        # CC5 reports nothing back from SelectObject(s); read the selection to prove it took.
        now = _selected()
        now_ids = {o.GetID() for o in now}
        not_selected = [o.GetName() for o in targets if o.GetID() not in now_ids]
        if not not_selected:
            return {"success": True, "selected": _describe(now)}
        error = f"CC5 did not select: {', '.join(not_selected)}"
    except Exception as e:
        error = str(e)
    _restore(previous)
    return {"success": False, "error": error, "selected": _describe(_selected_or_empty())}


def _restore(previous: list[Any]) -> None:
    """Best effort: put back the selection a failed select_objects started from."""
    try:
        _apply_selection(previous)
    except Exception as e:
        print(f"[CC5 MCP Bridge] selection: restoring the previous selection failed: {e}")


def _selected_or_empty() -> list[Any]:
    try:
        return _selected()
    except Exception:
        return []


def get_selection() -> dict[str, Any]:
    try:
        return {"success": True, "selected": _describe(_selected())}
    except Exception as e:
        return {"success": False, "error": str(e)}


def clear_selection() -> dict[str, Any]:
    try:
        RLPy.RScene.ClearSelectObjects()
        left = _selected()
        if left:
            return {"success": False, "error": "CC5 kept items selected after clearing",
                    "selected": _describe(left)}
        return {"success": True, "selected": []}
    except Exception as e:
        return {"success": False, "error": str(e)}


# --- Delete and place scene objects (flight 01, F-48 / F-49) ---
# Live CC5 5.13: RScene.RemoveObject inside BeginAction/EndAction is one undo step (a deleted prop came back with
# one undo), and so is GetControl("Transform").SetValue (a prop moved 150 cm and scaled 1.5 went back with one undo).

MAX_TRANSFORM_CM = 100000.0
MIN_SCALE, MAX_SCALE = 0.001, 1000.0


def _resolve_one(name: Any, candidates: list[tuple[Any, str]]) -> tuple[Any, str, str]:
    """(object, group, "") for a name that matches exactly one scene item, else (None, "", error)."""
    if not isinstance(name, str) or not name or len(name) > cc5_api.MAX_ITEM_NAME_LENGTH:
        return None, "", f"Invalid item name: {name!r}"
    matches = [(o, g) for o, g in candidates if o.GetName() == name]
    if not matches:
        return None, "", f"Object not found: {name}"
    if len(matches) > 1:
        return None, "", f"Name matches more than one item: {name} ({len(matches)} items)"
    return matches[0][0], matches[0][1], ""


_DELETABLE = {"prop", "light", "worn"}


def delete_object(names: Any) -> dict[str, Any]:
    """Delete props, lights and worn items by name, as one undo step. Characters and the camera are refused."""
    if not isinstance(names, list) or not names:
        return {"success": False, "error": "names must be a non-empty list of item names"}
    if len(names) > MAX_SELECT_NAMES:
        return {"success": False, "error": f"Too many names ({len(names)}, max {MAX_SELECT_NAMES})"}
    try:
        candidates = _grouped_candidates()
        targets: list[Any] = []
        for name in dict.fromkeys(names):
            obj, group, error = _resolve_one(name, candidates)
            if error:
                return {"success": False, "error": error}
            if group == "avatar":
                return {"success": False, "error": f"{name} is a character: use delete_avatar to delete characters"}
            if group == "camera":
                return {"success": False,
                        "error": f"{name} is the camera: CC5 cannot make another, so it is not deleted"}
            if group not in _DELETABLE:
                return {"success": False, "error": f"{name} is not a prop, light or worn item, so it is not deleted"}
            targets.append(obj)
    except Exception as e:
        return {"success": False, "error": str(e)}

    deleted = _describe(targets)
    removed: list[str] = []
    RLPy.RGlobal.BeginAction("Delete Object")
    try:
        for obj, info in zip(targets, deleted):
            # A parent's removal can take its children with it: never hand CC5 a handle that is gone.
            if info["id"] not in {o.GetID() for o, _g in _grouped_candidates()}:
                removed.append(info["name"])
                continue
            RLPy.RScene.RemoveObject(obj)
            removed.append(info["name"])
    except Exception as e:
        done = f" Already deleted: {', '.join(removed)}." if removed else ""
        return {"success": False, "error": f"CC5 could not delete: {e}.{done}"}
    finally:
        RLPy.RGlobal.EndAction()
    # RemoveObject reports nothing useful back: read the scene to prove the items are gone.
    try:
        left_ids = {o.GetID() for o in _scene_candidates()}
    except Exception as e:
        return {"success": False, "error": f"Deleted, but the scene could not be read back: {e}"}
    still_there = [d["name"] for d in deleted if d["id"] in left_ids]
    if still_there:
        return {"success": False, "error": f"CC5 did not delete: {', '.join(still_there)}",
                "deleted": [d for d in deleted if d["id"] not in left_ids]}
    return {"success": True, "deleted": deleted}


def _vector(value: Any, what: str) -> tuple[list[float] | None, str]:
    if not isinstance(value, (list, tuple)) or len(value) != 3 or any(isinstance(v, bool) for v in value):
        return None, f"{what} must be a list of 3 numbers"
    try:
        out = [float(v) for v in value]
    except (TypeError, ValueError):
        return None, f"{what} must be a list of 3 numbers"
    if any(v != v or abs(v) == float("inf") for v in out):
        return None, f"{what} must be finite numbers"
    return out, ""


def _read_transform(control: Any) -> Any:
    tr = RLPy.RTransform()
    control.GetValue(RLPy.RGlobal.GetTime(), tr)
    return tr


def _transform_dict(tr: Any) -> dict[str, list[float]]:
    t, s = tr.T(), tr.S()
    return {"position": [round(float(t.x), 2), round(float(t.y), 2), round(float(t.z), 2)],
            "scale": [round(float(s.x), 4), round(float(s.y), 4), round(float(s.z), 4)]}


_PLACEABLE = {"prop", "light", "avatar"}


def _transform_control(name: Any) -> tuple[Any, Any, str]:
    obj, group, error = _resolve_one(name, _grouped_candidates())
    if error:
        return None, None, error
    if group == "camera":
        return None, None, f"{name} is the camera: use frame_camera to change the view"
    if group == "worn":
        return None, None, (f"{name} is worn by a character and moves with it: "
                            "only props, lights and characters can be placed")
    if group not in _PLACEABLE:
        return None, None, f"{name} is not a prop, light or character, so it cannot be placed"
    control = obj.GetControl("Transform") if hasattr(obj, "GetControl") else None
    if control is None:
        return None, None, f"{name} has no transform CC5 lets a script change"
    return obj, control, ""


def get_object_transform(name: Any) -> dict[str, Any]:
    """Position (cm) and scale of a prop, light or character."""
    try:
        obj, control, error = _transform_control(name)
        if error:
            return {"success": False, "error": error}
        return {"success": True, "name": obj.GetName(), **_transform_dict(_read_transform(control))}
    except Exception as e:
        return {"success": False, "error": str(e)}


def set_object_transform(name: Any, position: Any = None, scale: Any = None) -> dict[str, Any]:
    """Move (position, cm) and/or scale a prop, light or character, keeping its rotation. One undo step."""
    if position is None and scale is None:
        return {"success": False, "error": "Give position, scale or both"}
    pos, error = _vector(position, "position") if position is not None else (None, "")
    if error:
        return {"success": False, "error": error}
    if pos and any(abs(v) > MAX_TRANSFORM_CM for v in pos):
        return {"success": False, "error": f"position must be within +/-{MAX_TRANSFORM_CM:g} cm"}
    if isinstance(scale, (int, float)) and not isinstance(scale, bool):
        scale = [scale, scale, scale]
    scl, error = _vector(scale, "scale") if scale is not None else (None, "")
    if error:
        return {"success": False, "error": error}
    if scl and any(not MIN_SCALE <= v <= MAX_SCALE for v in scl):
        return {"success": False, "error": f"scale must be between {MIN_SCALE:g} and {MAX_SCALE:g}"}
    try:
        obj, control, error = _transform_control(name)
        if error:
            return {"success": False, "error": error}
        current = _read_transform(control)
        before = _transform_dict(current)
        t, s = current.T(), current.S()
        new_pos = RLPy.RVector3(*pos) if pos else RLPy.RVector3(t.x, t.y, t.z)
        new_scale = RLPy.RVector3(*scl) if scl else RLPy.RVector3(s.x, s.y, s.z)
        RLPy.RGlobal.BeginAction("Set Object Transform")
        try:
            control.SetValue(RLPy.RGlobal.GetTime(), RLPy.RTransform(new_scale, current.R(), new_pos))
            RLPy.RGlobal.ObjectModified(obj, RLPy.EObjectModifiedType_Transform)
        finally:
            RLPy.RGlobal.EndAction()
        after = _transform_dict(_read_transform(control))
        wanted = {"position": [round(v, 2) for v in pos] if pos else before["position"],
                  "scale": [round(v, 4) for v in scl] if scl else before["scale"]}
        off = [k for k in ("position", "scale") if any(abs(a - b) > 0.01 for a, b in zip(after[k], wanted[k]))]
        if off:
            return {"success": False, "error": f"CC5 did not apply the {' and '.join(off)}",
                    "before": before, "after": after}
        return {"success": True, "name": obj.GetName(), "before": before, "after": after}
    except Exception as e:
        return {"success": False, "error": str(e)}


ACTIONS: dict[str, Any] = {
    "select_objects": lambda p: select_objects(p["names"], p.get("add", False)),
    "get_selection": lambda p: get_selection(),
    "clear_selection": lambda p: clear_selection(),
    "delete_object": lambda p: delete_object(p["names"]),
    "get_object_transform": lambda p: get_object_transform(p["name"]),
    "set_object_transform": lambda p: set_object_transform(p["name"], p.get("position"), p.get("scale")),
}
POST_ROUTES: dict[str, str] = {
    "/scene/select": "select_objects",
    "/scene/selection": "get_selection",
    "/scene/selection/clear": "clear_selection",
    "/scene/delete": "delete_object",
    "/scene/transform": "get_object_transform",
    "/scene/transform/set": "set_object_transform",
}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "select_objects": ["names"],
    "delete_object": ["names"],
    "get_object_transform": ["name"],
    "set_object_transform": ["name"],
}
