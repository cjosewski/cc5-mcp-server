"""Blender leg of the CC5 -> Blender -> Unity end-to-end check (run by scripts/e2e/run_e2e.py).

blender -b --factory-startup --python-exit-code 1 --python blender_check.py -- --fbx IN.fbx --out OUT.fbx --report R.json

Imports the CC5 Blender-preset FBX, reports mesh objects, triangles, armatures and bones, materials, image
textures (and whether each file is on disk), and shape keys; then exports every object to OUT.fbx
(path_mode COPY, textures not embedded) and reports that file. The report is JSON; "ok" is false if the
import or the export failed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="blender_check.py")
    p.add_argument("--fbx", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--report", required=True)
    return p.parse_args(argv)


def image_info(img: bpy.types.Image) -> dict:
    path = bpy.path.abspath(img.filepath, library=img.library) if img.filepath else ""
    path = os.path.normpath(path) if path else ""
    packed = img.packed_file is not None
    return {"name": img.name, "path": path, "packed": packed,
            "resolved": packed or (bool(path) and os.path.isfile(path))}


def material_images(mat: bpy.types.Material) -> list[str]:
    if not mat.node_tree:
        return []
    return sorted({n.image.name for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image})


def describe_scene() -> dict:
    meshes = []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        me = obj.data
        me.calc_loop_triangles()
        keys = me.shape_keys.key_blocks if me.shape_keys else []
        meshes.append({"name": obj.name, "triangles": len(me.loop_triangles), "polygons": len(me.polygons),
                       # The first key block is the Basis, not a shape.
                       "shape_keys": max(len(keys) - 1, 0),
                       "materials": [s.material.name for s in obj.material_slots if s.material]})
    armatures = [{"name": o.name, "bones": len(o.data.bones)} for o in bpy.data.objects if o.type == "ARMATURE"]
    materials = [{"name": m.name, "images": material_images(m)} for m in bpy.data.materials if m.users]
    images = [image_info(i) for i in bpy.data.images if i.source in {"FILE", "SEQUENCE", "TILED"}]
    return {
        "mesh_objects": len(meshes),
        "triangles": sum(m["triangles"] for m in meshes),
        "shape_keys": sum(m["shape_keys"] for m in meshes),
        "meshes": meshes,
        "armatures": armatures,
        "bones": sum(a["bones"] for a in armatures),
        "materials": materials,
        "images": images,
        "images_resolved": sum(1 for i in images if i["resolved"]),
    }


def main() -> None:
    args = parse_args()
    report: dict = {"blender_version": bpy.app.version_string, "fbx": args.fbx, "ok": False}
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        t0 = time.monotonic()
        bpy.ops.import_scene.fbx(filepath=args.fbx)
        report["import_seconds"] = round(time.monotonic() - t0, 1)
        report.update(describe_scene())
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        t0 = time.monotonic()
        bpy.ops.export_scene.fbx(filepath=args.out, use_selection=False, path_mode="COPY", embed_textures=False)
        report["export_seconds"] = round(time.monotonic() - t0, 1)
        out_dir = os.path.dirname(os.path.abspath(args.out))
        report["export"] = {"path": args.out, "exists": os.path.isfile(args.out),
                            "bytes": os.path.getsize(args.out) if os.path.isfile(args.out) else 0,
                            "files_in_folder": sorted(os.listdir(out_dir))}
        report["ok"] = report["export"]["exists"] and report["mesh_objects"] > 0
    except Exception as e:  # reported, then re-raised so --python-exit-code fails the run
        report["error"] = f"{type(e).__name__}: {e}"
        raise
    finally:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1)
    if not report["ok"]:
        sys.exit(1)


main()
