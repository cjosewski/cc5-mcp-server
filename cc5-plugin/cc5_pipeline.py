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


# LIVE-VERIFY (Task 18 prints the real extensions under browse_content('pose'/'motion')): .ccpose/.ccmotion
# are guesses for CC5-native content; keep in sync with POSE_EXTENSIONS in src/tools/pipeline.ts.
POSE_EXTENSIONS = {".rlmotion", ".imotion", ".rlpose", ".ipose", ".imotionplus", ".ccpose", ".ccmotion"}


def _check_existing(path: str, allowed: set[str]) -> str | None:
    error = check_path(path)
    if error:
        return error
    if os.path.splitext(path)[1].lower() not in allowed:
        return f"Unsupported file type. Allowed: {', '.join(sorted(allowed))}"
    if not os.path.isfile(path):
        return f"File not found: {path}"
    return None


def _raise_on_error(status: Any, what: str) -> None:
    """RLPy file calls return an RStatus instead of raising; turn an error status into an exception."""
    is_error = getattr(status, "IsError", None)
    if callable(is_error) and is_error() is True:
        raise RuntimeError(f"{what} reported an error status")


def apply_pose(file_path: str) -> dict[str, Any]:
    """Apply a pose/motion file to the avatar (LIVE-VERIFY: LoadFile on selection, then LoadMotion)."""
    error = _check_existing(file_path, POSE_EXTENSIONS)
    if error:
        return {"success": False, "error": error}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    RLPy.RGlobal.BeginAction("Apply Pose")
    try:
        RLPy.RScene.SelectObject(avatar)
        try:
            _raise_on_error(RLPy.RFileIO.LoadFile(file_path), "LoadFile")
            method = "LoadFile"
        except Exception:
            _raise_on_error(RLPy.RFileIO.LoadMotion(file_path, RLPy.RTime(0), avatar), "LoadMotion")
            method = "LoadMotion"
        RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Transform)
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True, "method": method}


def save_character(output_path: str) -> dict[str, Any]:
    """Save the avatar as a .ccAvatar so batch runs can reload a clean base."""
    error = check_path(output_path)
    if error:
        return {"success": False, "error": error}
    if os.path.splitext(output_path)[1].lower() != ".ccavatar":
        return {"success": False, "error": "output_path must end with .ccAvatar"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    try:
        setting = RLPy.RSaveFileSetting()
        setting.SetSaveType(RLPy.ESaveFileType_Character)
        _raise_on_error(RLPy.RFileIO.SaveFile(avatar, setting, output_path), "SaveFile")
    except Exception as e:
        return {"success": False, "error": str(e)}
    if not os.path.isfile(output_path):
        return {"success": False, "error": f"CC5 did not write {output_path}"}
    return {"success": True, "path": output_path}


def try_signatures(attempts: list[tuple[str, Any]]) -> tuple[str | None, str | None]:
    """Run each (label, fn) until one doesn't raise. For RLPy calls documented only as *args."""
    errors: list[str] = []
    for label, fn in attempts:
        try:
            fn()
            return label, None
        except Exception as e:
            errors.append(f"{label}: {e}")
    return None, "; ".join(errors)


def export_obj(output_path: str, y_up: bool = True) -> dict[str, Any]:
    """Export the avatar as OBJ for sculpting (LIVE-VERIFY: ExportObjFile is documented as *args)."""
    error = check_path(output_path)
    if error:
        return {"success": False, "error": error}
    if os.path.splitext(output_path)[1].lower() != ".obj":
        return {"success": False, "error": "output_path must end with .obj"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    # EExport3DFileOption is a bitmask: the part bits pick what is written and ResetToBindPose
    # keeps the rest shape that replace_mesh_from_obj needs (same topology, bind pose).
    option = 0
    for name in ("EExport3DFileOption_FullBodyPart", "EExport3DFileOption_AllClothes",
                 "EExport3DFileOption_ResetToBindPose", "EExport3DFileOption_ExportMaterial"):
        option |= getattr(RLPy, name, 0)
    if y_up:
        option |= RLPy.EExport3DFileOption_AxisYUp
    label, err = try_signatures([
        ("(avatar, path, option)", lambda: RLPy.RFileIO.ExportObjFile(avatar, output_path, option)),
        ("(avatar, path)", lambda: RLPy.RFileIO.ExportObjFile(avatar, output_path)),
    ])
    if not label:
        return {"success": False, "error": f"ExportObjFile failed: {err}"}
    return {"success": True, "path": output_path, "signature": label}


def _opt_int(p: dict, key: str) -> int | None:
    return int(p[key]) if p.get(key) is not None else None


ACTIONS: dict[str, Any] = {
    "export_for_unity": lambda p: export_for_unity(
        p["unity_dir"], p["character_name"], _opt_int(p, "sub_d_level"),
        _opt_int(p, "texture_size"), bool(p.get("include_current_pose", False))),
    "get_mesh_stats": lambda p: get_mesh_stats(),
    "apply_pose": lambda p: apply_pose(p["file_path"]),
    "save_character": lambda p: save_character(p["output_path"]),
    "export_obj": lambda p: export_obj(p["output_path"], bool(p.get("y_up", True))),
}
POST_ROUTES: dict[str, str] = {
    "/pipeline/mesh_stats": "get_mesh_stats",
    "/pipeline/pose": "apply_pose",
    "/pipeline/save_character": "save_character",
    "/pipeline/export_obj": "export_obj",
}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "export_for_unity": ["unity_dir", "character_name"],
    "apply_pose": ["file_path"],
    "save_character": ["output_path"],
    "export_obj": ["output_path"],
}
