"""
Scene selection: select scene items by name, read the selection, clear it.

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
    found: list[Any] = []
    seen: set[Any] = set()

    def add(obj: Any) -> None:
        try:
            key = obj.GetID()
        except Exception:
            key = id(obj)
        if key not in seen:
            seen.add(key)
            found.append(obj)

    try:
        avatars = list(RLPy.RScene.GetAvatars())
    except Exception as e:
        print(f"[CC5 MCP Bridge] selection: GetAvatars failed: {e}")
        avatars = []
    for avatar in avatars:
        add(avatar)
        for getter in (avatar.GetClothes, avatar.GetHairs, lambda: avatar.GetAccessories(True)):
            try:
                for item in getter():
                    add(item)
            except Exception as e:
                print(f"[CC5 MCP Bridge] selection: avatar item getter failed: {e}")
    for const in _SCENE_TYPES:
        if not hasattr(RLPy, const):
            continue
        try:
            for obj in RLPy.RScene.FindObjects(getattr(RLPy, const)):
                add(obj)
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


ACTIONS: dict[str, Any] = {
    "select_objects": lambda p: select_objects(p["names"], p.get("add", False)),
    "get_selection": lambda p: get_selection(),
    "clear_selection": lambda p: clear_selection(),
}
POST_ROUTES: dict[str, str] = {
    "/scene/select": "select_objects",
    "/scene/selection": "get_selection",
    "/scene/selection/clear": "clear_selection",
}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "select_objects": ["names"],
}
