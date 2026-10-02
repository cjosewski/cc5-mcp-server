"""
Export / import pipeline helpers: Unity export, mesh stats, poses, DCC round-trips.

Every function returns {"success": bool, ...}. All run on CC5's main thread via
the server queue. Arguments are validated before any RLPy call.
"""

from __future__ import annotations

import os
import re
import time
import urllib.parse
from typing import Any

import RLPy

import cc5_api

SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")  # \Z, not $: $ also matches before a trailing newline
SUB_D_LEVELS = (0, 1, 2)  # same sets as the zod schema in src/tools/unity.ts
TEXTURE_SIZES = (512, 1024, 2048, 4096)


def check_path(path: str) -> str | None:
    """Reject empty, relative, NUL, '..', UNC/network and device paths. Returns an error message or None."""
    if not path or not isinstance(path, str):
        return "Path is required"
    decoded = urllib.parse.unquote(path)
    if "\x00" in path or "\x00" in decoded:
        return "Path contains null byte"
    if ".." in path or ".." in decoded:
        return "Path traversal ('..') is not allowed"
    if re.match(r"[\\/]{2}", path) or "?" in path:
        return "Network (UNC) and device paths are not allowed"
    if not os.path.isabs(path):
        return f"Path must be absolute: {path}"
    return None


def is_in_unity_assets(folder: str) -> bool:
    parts = os.path.normpath(folder).replace("/", "\\").split("\\")
    return any(p.lower() == "assets" for p in parts)


def list_files(folder: str, since: float | None = None, max_entries: int = 2000) -> list[dict[str, Any]]:
    """Files under folder, skipping ones modified before `since`. Stops after `max_entries`
    folders + files so a broad folder (e.g. C:\\) cannot stall CC5's main thread or bloat the job record."""
    out: list[dict[str, Any]] = []
    scanned = 0
    for dirpath, _dirs, files in os.walk(folder):
        scanned += 1
        for name in sorted(files):
            scanned += 1
            if scanned > max_entries:
                return out
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            if since is None or st.st_mtime >= since:
                out.append({"path": full, "bytes": st.st_size})
    return out


def export_for_unity(
    unity_dir: str,
    character_name: str,
    sub_d_level: int | None = None,
    texture_size: int | None = None,
    include_current_pose: bool = False,
) -> dict[str, Any]:
    """Export the current avatar with the Unity preset into <unity_dir>/<name>/<name>.fbx."""
    error = check_path(unity_dir)
    if error:
        return {"success": False, "error": error}
    if not is_in_unity_assets(unity_dir):
        return {"success": False, "error": f"Folder must be inside a Unity project's Assets folder: {unity_dir}"}
    if not SAFE_NAME.match(character_name or ""):
        return {"success": False, "error": "Character name must be 1-64 letters, digits, '_' or '-'"}
    if sub_d_level is not None and (isinstance(sub_d_level, bool) or sub_d_level not in SUB_D_LEVELS):
        return {"success": False, "error": "sub_d_level must be 0, 1 or 2"}
    if texture_size is not None and (isinstance(texture_size, bool) or texture_size not in TEXTURE_SIZES):
        return {"success": False, "error": "texture_size must be 512, 1024, 2048 or 4096"}
    if not cc5_api.get_first_avatar():
        return {"success": False, "error": "No avatar in scene"}
    folder = os.path.join(unity_dir, character_name)
    os.makedirs(folder, exist_ok=True)
    fbx = os.path.join(folder, character_name + ".fbx")
    started = time.time() - 2  # mtime slack; report only files this export wrote
    result = cc5_api.export_fbx(
        fbx, 0,
        target_tool="Unity",
        sub_d_level=sub_d_level,
        include_current_pose=include_current_pose,
        embed_textures=False,
        export_motion=False,
        texture_size=texture_size,
        convert_image_format=True,
    )
    if not result.get("success"):
        return result
    return {"success": True, "fbx": fbx, "folder": folder, "files": list_files(folder, since=started), "notes": result.get("notes", [])}


def _parts(avatar) -> list[tuple[str, Any]]:
    parts: list[tuple[str, Any]] = [("body", avatar)]
    parts += [("clothing", c) for c in (avatar.GetClothes() or [])]
    parts += [("hair", h) for h in (avatar.GetHairs() or [])]
    parts += [("accessory", a) for a in (avatar.GetAccessories(True) or [])]
    return parts


def get_mesh_stats() -> dict[str, Any]:
    """Vertex/face/material counts for the avatar and everything it wears."""
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    meshes: list[dict[str, Any]] = []
    seen: set[str] = set()
    parts = _parts(avatar)
    # Worn items first, body last: if avatar.GetMeshes(True) also returns worn-item meshes
    # (LIVE-VERIFY in Task 18), each mesh is still counted once, under its own kind.
    for kind, obj in parts[1:] + parts[:1]:
        mat_comp = obj.GetMaterialComponent() if hasattr(obj, "GetMaterialComponent") else None
        for mesh in obj.GetMeshes(True) or []:
            name = mesh.GetName()
            if name in seen:
                continue
            seen.add(name)
            try:
                mats = len(mat_comp.GetMaterialNames(name) or []) if mat_comp else 0
            except Exception:
                mats = 0
            meshes.append({
                "object": obj.GetName(), "kind": kind, "mesh": name,
                "vertices": int(mesh.GetVerticesCount()), "faces": int(mesh.GetFacesCount()),
                "materials": mats,
            })
    meshes.sort(key=lambda m: ("body", "clothing", "hair", "accessory").index(m["kind"]))
    totals = {k: sum(m[k] for m in meshes) for k in ("vertices", "faces", "materials")}
    return {"success": True, "meshes": meshes, "totals": totals}


def _opt_int(p: dict, key: str) -> int | None:
    return int(p[key]) if p.get(key) is not None else None


ACTIONS: dict[str, Any] = {
    "export_for_unity": lambda p: export_for_unity(
        p["unity_dir"], p["character_name"], _opt_int(p, "sub_d_level"),
        _opt_int(p, "texture_size"), bool(p.get("include_current_pose", False))),
    "get_mesh_stats": lambda p: get_mesh_stats(),
}
POST_ROUTES: dict[str, str] = {
    "/pipeline/mesh_stats": "get_mesh_stats",
}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "export_for_unity": ["unity_dir", "character_name"],
}
