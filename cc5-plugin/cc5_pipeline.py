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
    """Apply a pose/motion file to the avatar: LoadFile aimed at the avatar, then LoadMotion as the fallback."""
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
            # Live signature: LoadFile(path, bRecordStep=True, spObject=0, kTime=-1, eOption=_None).
            # Pass the avatar so the pose lands on it whatever else is selected.
            _raise_on_error(RLPy.RFileIO.LoadFile(file_path, True, avatar), "LoadFile")
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


# How SWIG says no overload matches the arguments ("Wrong number or type of arguments"); older SWIG
# builds raise NotImplementedError. Only these mean the call never ran.
SIGNATURE_MISMATCH = (TypeError, NotImplementedError)


def try_signatures(attempts: list[tuple[str, Any]]) -> tuple[str | None, str | None]:
    """Run each (label, fn) in order, for RLPy calls documented only as *args. Returns (label, None)
    for the form that worked, or (None, errors).

    Moves on to the next form only when SWIG rejected the arguments. Any other exception, including
    the RuntimeError _raise_on_error makes from an error RStatus, means CC5 ran the call and it failed:
    retrying a weaker form would repeat the operation or quietly drop its options, so it stops there.
    """
    errors: list[str] = []
    for label, fn in attempts:
        try:
            fn()
            return label, None
        except SIGNATURE_MISMATCH as e:
            errors.append(f"{label}: {e}")
        except Exception as e:
            errors.append(f"{label}: {e}")
            break
    return None, "; ".join(errors)


def _fallback_notes(label: str | None, attempts: list[tuple[str, Any]], consequence: str) -> list[str]:
    """A WARNING note when CC5 rejected the preferred call form and a weaker one was used."""
    if label is None or label == attempts[0][0]:
        return []
    return [f"WARNING: CC5 rejected {attempts[0][0]} and {label} was used instead, so {consequence}"]


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
    attempts: list[tuple[str, Any]] = [
        ("(avatar, path, option)",
         lambda: _raise_on_error(RLPy.RFileIO.ExportObjFile(avatar, output_path, option), "ExportObjFile")),
        ("(avatar, path)",
         lambda: _raise_on_error(RLPy.RFileIO.ExportObjFile(avatar, output_path), "ExportObjFile")),
    ]
    label, err = try_signatures(attempts)
    if not label:
        return {"success": False, "error": f"ExportObjFile failed: {err}"}
    notes = _fallback_notes(label, attempts, "the OBJ options (bind pose, Y-up axis, body and clothing parts) "
                                             "were NOT applied")
    if not os.path.isfile(output_path):
        return {"success": False, "error": f"CC5 did not write {output_path}", "signature": label, "notes": notes}
    return {"success": True, "path": output_path, "signature": label, "notes": notes}


GOZ_POSES = {"current": "EExportGoZPose_Current", "tpose": "EExportGoZPose_TPose", "apose": "EExportGoZPose_APose"}


def _set_goz_pose(option: Any, pose_enum: Any) -> bool:
    """Put the pose on an RExportGoZMeshOption; True when it took. Live CC5 exposes it as the attribute
    ePose (dir(): bDoScale, bIsCreate, ePose, strPoseFilePath); a setter method is only the fallback."""
    if pose_enum is None:
        return False
    if hasattr(option, "ePose"):
        option.ePose = pose_enum
        return option.ePose == pose_enum
    setter = next((s for s in ("SetPose", "SetExportPose", "SetGoZPose") if hasattr(option, s)), None)
    if setter is None:
        return False
    getattr(option, setter)(pose_enum)
    return True


def export_goz(output_dir: str, pose: str = "tpose") -> dict[str, Any]:
    """Write GoZ files for ZBrush. Live signature:
    ExportGoZFile(ObjectVector kObjects, std::wstring strFolderPath, RExportGoZMeshOption kSetting) -> RStatus."""
    error = check_path(output_dir)
    if error:
        return {"success": False, "error": error}
    if not isinstance(pose, str) or pose not in GOZ_POSES:
        return {"success": False, "error": f"pose must be one of: {', '.join(GOZ_POSES)}"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    os.makedirs(output_dir, exist_ok=True)
    started = time.time() - 2  # mtime slack; report only files this export wrote
    option = RLPy.RExportGoZMeshOption()
    pose_applied = _set_goz_pose(option, getattr(RLPy, GOZ_POSES[pose], None)) or pose == "current"
    attempts: list[tuple[str, Any]] = []
    if hasattr(RLPy, "ObjectVector"):
        def export_with_object_vector() -> None:
            objects = RLPy.ObjectVector()
            objects.append(avatar)
            _raise_on_error(RLPy.RFileIO.ExportGoZFile(objects, output_dir, option), "ExportGoZFile")
        attempts.append(("(ObjectVector[avatar], folder, option)", export_with_object_vector))
    attempts += [
        ("([avatar], folder, option)",
         lambda: _raise_on_error(RLPy.RFileIO.ExportGoZFile([avatar], output_dir, option), "ExportGoZFile")),
        ("([avatar], folder, [option])",
         lambda: _raise_on_error(RLPy.RFileIO.ExportGoZFile([avatar], output_dir, [option]), "ExportGoZFile")),
    ]
    label, err = try_signatures(attempts)
    if not label:
        return {"success": False, "error": f"ExportGoZFile failed: {err}"}
    notes = [] if pose_applied else [
        f"WARNING: pose '{pose}' NOT applied (RExportGoZMeshOption has no ePose attribute or pose setter); "
        "files use the current pose"]
    return {"success": True, "folder": output_dir, "files": list_files(output_dir, since=started), "signature": label,
            "pose_applied": pose_applied, "notes": notes}


FBX_KINDS = {"prop": "EImportFbxOption_Prop", "character": "EImportFbxOption_StandardHumanCharacter", "clothing": None}


def import_fbx(file_path: str, kind: str) -> dict[str, Any]:
    """Import an FBX from Blender/Maya/etc. as a prop, a character, or clothing for the current avatar.
    Live signatures: LoadFbxFile(path, EImportFbxOption, ...); LoadClotheFromFbx(avatar, path, WStringVector)."""
    if not isinstance(kind, str) or kind not in FBX_KINDS:
        return {"success": False, "error": f"kind must be one of: {', '.join(FBX_KINDS)}"}
    error = _check_existing(file_path, {".fbx"})
    if error:
        return {"success": False, "error": error}
    avatar = None
    if kind == "clothing":
        avatar = cc5_api.get_first_avatar()
        if not avatar:
            return {"success": False, "error": "No avatar in scene to dress"}
    notes: list[str] = []
    failed_meshes: list[str] = []
    attempts: list[tuple[str, Any]] = []
    RLPy.RGlobal.BeginAction("Import FBX")
    try:
        if kind == "clothing":
            # The third argument is an out-param: CC5 fills it with the meshes it could not import.
            failed_vector = RLPy.WStringVector() if hasattr(RLPy, "WStringVector") else None
            failed_list: list[Any] = []

            def load_clothes(failed_out: Any) -> None:
                _raise_on_error(RLPy.RFileIO.LoadClotheFromFbx(avatar, file_path, failed_out), "LoadClotheFromFbx")

            if failed_vector is not None:
                attempts.append(("LoadClotheFromFbx(avatar, path, WStringVector)", lambda: load_clothes(failed_vector)))
            attempts.append(("LoadClotheFromFbx(avatar, path, list)", lambda: load_clothes(failed_list)))
            label, err = try_signatures(attempts)
            if label:
                RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Attribute)
                filled = failed_vector if label.endswith("WStringVector)") else failed_list
                failed_meshes = [str(name) for name in filled]
                if failed_meshes:
                    notes.append(f"WARNING: {len(failed_meshes)} clothing mesh(es) did not import: "
                                 f"{', '.join(failed_meshes)}")
        else:
            option = getattr(RLPy, FBX_KINDS[kind], None)
            if option is None:
                notes.append(f"WARNING: RLPy.{FBX_KINDS[kind]} not found, so CC5's default import option was used")
            else:
                attempts.append(("LoadFbxFile(path, option)",
                                 lambda: _raise_on_error(RLPy.RFileIO.LoadFbxFile(file_path, option), "LoadFbxFile")))
            attempts.append(("LoadFbxFile(path)",
                             lambda: _raise_on_error(RLPy.RFileIO.LoadFbxFile(file_path), "LoadFbxFile")))
            label, err = try_signatures(attempts)
            notes += _fallback_notes(label, attempts,
                                     f"CC5's default import option was used instead of {FBX_KINDS[kind]}")
    finally:
        RLPy.RGlobal.EndAction()
    if not label:
        return {"success": False, "error": f"FBX import failed: {err}"}
    cc5_api._invalidate_caches()
    result: dict[str, Any] = {"success": True, "signature": label, "notes": notes}
    if kind == "clothing":
        result["failed_meshes"] = failed_meshes
    return result


def list_meshes() -> dict[str, Any]:
    """Mesh names of the current avatar (the names replace_mesh_from_obj accepts)."""
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    return {"success": True, "meshes": list(avatar.GetMeshNames(True) or [])}


def replace_mesh_from_obj(mesh_name: str, obj_path: str) -> dict[str, Any]:
    """Swap one avatar mesh for an edited OBJ with the same topology (sculpt round-trip)."""
    if not isinstance(mesh_name, str) or not mesh_name:
        return {"success": False, "error": "mesh_name is required"}
    error = _check_existing(obj_path, {".obj"})
    if error:
        return {"success": False, "error": error}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    names = list(avatar.GetMeshNames(True) or [])
    if mesh_name not in names:
        return {"success": False, "error": f"Unknown mesh '{mesh_name}'. Meshes: {', '.join(names)}"}
    RLPy.RGlobal.BeginAction("Replace Mesh")
    try:
        _raise_on_error(avatar.ReplaceMesh(mesh_name, obj_path, False, False), "ReplaceMesh")
        RLPy.RGlobal.ObjectModified(avatar, RLPy.EObjectModifiedType_Attribute)
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True, "mesh": mesh_name}


# Keep in sync with TEXTURE_CHANNELS and IMAGE_EXTENSIONS in src/tools/pipeline.ts.
TEXTURE_CHANNELS = {
    "diffuse": "EMaterialTextureChannel_Diffuse",
    "normal": "EMaterialTextureChannel_Normal",
    "roughness": "EMaterialTextureChannel_Roughness",
    "metallic": "EMaterialTextureChannel_Metallic",
    "ao": "EMaterialTextureChannel_AmbientOcclusion",
    "opacity": "EMaterialTextureChannel_Opacity",
    "displacement": "EMaterialTextureChannel_Displacement",
    "specular": "EMaterialTextureChannel_Specular",
    "glow": "EMaterialTextureChannel_Glow",
    "bump": "EMaterialTextureChannel_Bump",
    "diffuse_blend": "EMaterialTextureChannel_DiffuseBlend",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff"}


def resolve_material(avatar, mesh_name: str, material_name: str) -> tuple[Any, str | None]:
    """Return (material component, error). Errors list the valid names."""
    meshes = list(avatar.GetMeshNames(True) or [])
    if mesh_name not in meshes:
        return None, f"Unknown mesh '{mesh_name}'. Meshes: {', '.join(meshes)}"
    mat_comp = avatar.GetMaterialComponent()
    mats = list(mat_comp.GetMaterialNames(mesh_name) or [])
    if material_name not in mats:
        return None, f"Unknown material '{material_name}' on {mesh_name}. Materials: {', '.join(mats)}"
    return mat_comp, None


def load_texture(mesh_name: str, material_name: str, channel: str, image_path: str) -> dict[str, Any]:
    """Load an image into one texture channel of one material."""
    if not isinstance(channel, str) or channel not in TEXTURE_CHANNELS:
        return {"success": False, "error": f"channel must be one of: {', '.join(TEXTURE_CHANNELS)}"}
    error = _check_existing(image_path, IMAGE_EXTENSIONS)
    if error:
        return {"success": False, "error": error}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    mat_comp, error = resolve_material(avatar, mesh_name, material_name)
    if error:
        return {"success": False, "error": error}
    RLPy.RGlobal.BeginAction("Load Texture")
    try:
        _raise_on_error(mat_comp.LoadImageToTexture(
            mesh_name, material_name, getattr(RLPy, TEXTURE_CHANNELS[channel]), image_path), "LoadImageToTexture")
        RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        RLPy.RGlobal.EndAction()
    return {"success": True}


def load_substance_textures(folder: str) -> dict[str, Any]:
    """Apply a Substance Painter texture export folder to the avatar (CC's own Substance import)."""
    error = check_path(folder)
    if error:
        return {"success": False, "error": error}
    if not os.path.isdir(folder):
        return {"success": False, "error": f"Folder not found: {folder}"}
    avatar = cc5_api.get_first_avatar()
    if not avatar:
        return {"success": False, "error": "No avatar in scene"}
    RLPy.RGlobal.BeginAction("Load Substance Textures")
    try:
        label, err = try_signatures([
            ("(avatar, folder)",
             lambda: _raise_on_error(RLPy.RFileIO.LoadSubstancePainterTextures(avatar, folder),
                                     "LoadSubstancePainterTextures")),
        ])
        if label:
            RLPy.RGlobal.ObjectModified(avatar, cc5_api._EOMTYPE_MATERIAL)
    finally:
        RLPy.RGlobal.EndAction()
    if not label:
        return {"success": False, "error": f"Substance import failed: {err}"}
    return {"success": True, "signature": label}


def export_textures(output_dir: str, character_name: str) -> dict[str, Any]:
    """Export FBX + PBR textures as image files: the starting set for Substance Painter."""
    error = check_path(output_dir)
    if error:
        return {"success": False, "error": error}
    if not SAFE_NAME.match(character_name or ""):
        return {"success": False, "error": "Character name must be 1-64 letters, digits, '_' or '-'"}
    if not cc5_api.get_first_avatar():
        return {"success": False, "error": "No avatar in scene"}
    folder = os.path.join(output_dir, character_name)
    os.makedirs(folder, exist_ok=True)
    fbx = os.path.join(folder, character_name + ".fbx")
    started = time.time() - 2  # mtime slack; report only files this export wrote
    result = cc5_api.export_fbx(fbx, 0, target_tool="", embed_textures=False, export_motion=False,
                                convert_image_format=True)
    if not result.get("success"):
        return result
    return {"success": True, "folder": folder, "files": list_files(folder, since=started)}


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
    "export_goz": lambda p: export_goz(p["output_dir"], p.get("pose", "tpose")),
    "import_fbx": lambda p: import_fbx(p["file_path"], p["kind"]),
    "list_meshes": lambda p: list_meshes(),
    "replace_mesh_from_obj": lambda p: replace_mesh_from_obj(p["mesh_name"], p["obj_path"]),
    "load_texture": lambda p: load_texture(p["mesh_name"], p["material_name"], p["channel"], p["image_path"]),
    "load_substance_textures": lambda p: load_substance_textures(p["folder"]),
    "export_textures": lambda p: export_textures(p["output_dir"], p["character_name"]),
}
POST_ROUTES: dict[str, str] = {
    "/pipeline/mesh_stats": "get_mesh_stats",
    "/pipeline/pose": "apply_pose",
    "/pipeline/save_character": "save_character",
    "/pipeline/export_obj": "export_obj",
    "/pipeline/meshes": "list_meshes",
    "/pipeline/replace_mesh": "replace_mesh_from_obj",
    "/pipeline/load_texture": "load_texture",
    "/pipeline/substance_import": "load_substance_textures",
}
REQUIRED_PARAMS: dict[str, list[str]] = {
    "export_for_unity": ["unity_dir", "character_name"],
    "apply_pose": ["file_path"],
    "save_character": ["output_path"],
    "export_obj": ["output_path"],
    "export_goz": ["output_dir"],  # job-only: no POST route
    "import_fbx": ["file_path", "kind"],  # job-only: no POST route
    "replace_mesh_from_obj": ["mesh_name", "obj_path"],
    "load_texture": ["mesh_name", "material_name", "channel", "image_path"],
    "load_substance_textures": ["folder"],
    "export_textures": ["output_dir", "character_name"],  # job-only: no POST route
}
