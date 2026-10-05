"""
HTTP bridge server for CC5 MCP plugin.

Uses Python's built-in http.server — no external dependencies needed.
All RLPy calls are queued and executed on the main thread via QTimer.
"""

from __future__ import annotations

import hmac
import importlib
import json
import os
import queue
import secrets
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

import cc5_api

DEV_MODE = os.environ.get("CC5_DEV_MODE", "0").strip().lower() in ("1", "true", "yes")
TOKEN_HEADER = "X-CC5-Token"


def _token_path() -> str:
    base = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
    return os.path.join(base, "CC5_MCP_Bridge", "token")


def _load_or_create_token() -> str:
    env = os.environ.get("CC5_BRIDGE_TOKEN", "").strip()
    if env:
        return env
    path = _token_path()
    try:
        with open(path, encoding="utf-8") as f:
            existing = f.read().strip()
        if existing:
            return existing
    except OSError:
        pass
    token = secrets.token_urlsafe(32)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(token)
    return token


TOKEN = _load_or_create_token()
API_VERSION = "1.1.0"

# Thread-safe command queue: HTTP thread -> main thread
command_queue: queue.Queue = queue.Queue(maxsize=100)
_store_lock = threading.Lock()
response_store: dict[str, Any] = {}
response_events: dict[str, threading.Event] = {}

_command_counter = 0
_counter_lock = threading.Lock()
# Command and job ids carry a nonce that is new each time this module loads (each CC5 start): the
# counter restarts at 1, so without it a job id from before a restart could name a different job.
_BOOT_ID = secrets.token_hex(4)
_processing = False  # Re-entrance guard for process_command_queue
_cancelled: set[str] = set()
_running_id: str | None = None

MAX_REQUEST_BYTES = 1 * 1024 * 1024  # 1 MB

# Module-level reference for shutdown
_httpd: ThreadingHTTPServer | None = None


def _next_command_id() -> str:
    global _command_counter
    with _counter_lock:
        _command_counter += 1
        return f"cmd_{_BOOT_ID}_{_command_counter}"


# --- Required parameters per action (validated before queue dispatch) ---

REQUIRED_PARAMS: dict[str, list[str]] = {
    "answer_dialog":        ["button"],
    "search_morphs":        ["query"],
    "get_morph_value":      ["morph_id"],
    "set_morph_value":      ["morph_id", "value"],
    "set_multiple_morphs":  ["morphs"],
    "load_asset":           ["file_path"],
    "export_fbx":           ["output_path"],
    "set_subdivision_level": ["level"],
    "set_camera_focal_length": ["focal_length"],
    "set_light_color":      ["light_name", "r", "g", "b"],
    "get_light_info":       ["light_name"],
    "set_light_multiplier": ["light_name", "multiplier"],
    "set_light_active":     ["light_name", "active"],
    "set_light_shadow":     ["light_name"],
    "set_ambient":          ["r", "g", "b"],
    "set_expression":       ["expressions"],
    "get_diffuse_color":    ["mesh_name", "material_name"],
    "set_diffuse_color":    ["mesh_name", "material_name", "r", "g", "b"],
    "get_material_properties": ["mesh_name", "material_name"],
    "set_material_opacity":    ["mesh_name", "material_name", "opacity"],
    "set_material_glossiness": ["mesh_name", "material_name", "glossiness"],
    "set_material_specular":   ["mesh_name", "material_name", "specular"],
    "get_shader_parameters":   ["mesh_name", "material_name"],
    "set_shader_parameter":    ["mesh_name", "material_name", "parameter_name", "values"],
    # Tier 1: Content Management
    "remove_scene_item":    ["item_name"],
    # Tier 3: Convenience Color Shortcuts
    "set_eye_color":        ["r", "g", "b"],
    "set_hair_color":       ["r", "g", "b"],
    "set_lip_color":        ["r", "g", "b"],
    "set_skin_color":       ["r", "g", "b"],
    # Tier 4: Visibility
    "set_item_visible":     ["item_name", "visible"],
    "exec_python":          ["code"],
    # Mesh-to-MetaHuman pipeline helpers
    "export_head_metahuman":   ["output_dir", "character_name"],
    "silent_install_filter":   ["output_dir", "character_name"],
    # ActorMIXER PRO: Create Mixer Assets (safety gate)
    "create_actor_mixer":      ["confirm_create"],
}

# --- Dynamic dispatch tables (can be hot-patched at runtime) ---

ACTION_MAP: dict[str, Any] = {
    # Dialog lane (DIALOG_ACTIONS): pure Qt, served even while a command waits inside a dialog.
    "get_dialog":            lambda p: get_dialog(p),
    "answer_dialog":         lambda p: answer_dialog(p["button"], p.get("expect")),
    "get_avatars":           lambda p: cc5_api.get_avatars(),
    "get_avatar_info":       lambda p: cc5_api.get_avatar_info(),
    "get_morph_catalog":     lambda p: cc5_api.get_morph_catalog(),
    "search_morphs":         lambda p: cc5_api.search_morphs(p["query"], p.get("category", "")),
    "get_morph_value":       lambda p: cc5_api.get_morph_value(p["morph_id"]),
    "set_morph_value":       lambda p: cc5_api.set_morph_value(p["morph_id"], float(p["value"])),
    "set_multiple_morphs":   lambda p: cc5_api.set_multiple_morphs(p["morphs"]),
    "create_default_avatar": lambda p: cc5_api.create_default_avatar(),
    "delete_avatar":         lambda p: cc5_api.delete_avatar(p.get("name", "")),
    "load_asset":            lambda p: cc5_api.load_asset(p["file_path"], p.get("target")),
    "export_fbx":            lambda p: cc5_api.export_fbx(
        p["output_path"],
        int(p.get("options", 0)),
        target_tool=p.get("target_tool", ""),
        sub_d_level=(int(p["sub_d_level"]) if p.get("sub_d_level") is not None else None),
        include_current_pose=bool(p.get("include_current_pose", False)),
        delete_hidden_faces=bool(p.get("delete_hidden_faces", False)),
        use_smooth_mesh=bool(p.get("use_smooth_mesh", False)),
        remove_eyelash=bool(p.get("remove_eyelash", False)),
        remove_tearline_occlusion=bool(p.get("remove_tearline_occlusion", False)),
        embed_textures=bool(p.get("embed_textures", False)),
        export_motion=bool(p.get("export_motion", True)),
        fps=(int(p["fps"]) if p.get("fps") is not None else None),
        motion_range=p.get("motion_range"),
        convert_image_format=bool(p.get("convert_image_format", False)),
        texture_size=(int(p["texture_size"]) if p.get("texture_size") is not None else None),
    ),
    "capture_viewport":      lambda p: cc5_api.capture_viewport(p.get("output_path", ""), int(p.get("width", 1280)), int(p.get("height", 720))),
    "set_subdivision_level": lambda p: cc5_api.set_subdivision_level(int(p["level"])),
    "undo":                  lambda p: cc5_api.undo(),
    "redo":                  lambda p: cc5_api.redo(),
    "get_camera_info":       lambda p: cc5_api.get_camera_info(),
    "set_camera_focal_length": lambda p: cc5_api.set_camera_focal_length(float(p["focal_length"])),
    "frame_camera":          lambda p: cc5_api.frame_camera(p.get("view", "face")),
    "get_lights":            lambda p: cc5_api.get_lights(),
    "set_light_color":       lambda p: cc5_api.set_light_color(p["light_name"], float(p["r"]), float(p["g"]), float(p["b"])),
    "get_light_info":        lambda p: cc5_api.get_light_info(p["light_name"]),
    "set_light_multiplier":  lambda p: cc5_api.set_light_multiplier(p["light_name"], float(p["multiplier"])),
    "set_light_active":      lambda p: cc5_api.set_light_active(p["light_name"], bool(p["active"])),
    "set_light_shadow":      lambda p: cc5_api.set_light_shadow(
        p["light_name"],
        (bool(p["cast_shadow"]) if p.get("cast_shadow") is not None else None),
        (float(p["darken_strength"]) if p.get("darken_strength") is not None else None),
    ),
    "get_visual_settings":   lambda p: cc5_api.get_visual_settings(),
    "set_ambient":           lambda p: cc5_api.set_ambient(float(p["r"]), float(p["g"]), float(p["b"])),
    "set_ibl":               lambda p: cc5_api.set_ibl(p.get("image_path", ""), bool(p.get("enable", True))),
    "get_expression_info":   lambda p: cc5_api.get_expression_info(),
    "set_expression":        lambda p: cc5_api.set_expression(p["expressions"]),
    "reset_expression":      lambda p: cc5_api.reset_expression(),
    "reset_all_morphs":      lambda p: cc5_api.reset_all_morphs(p.get("avatar_name", "")),
    "get_material_info":     lambda p: cc5_api.get_material_info(p.get("avatar_name", "")),
    "get_diffuse_color":     lambda p: cc5_api.get_diffuse_color(p["mesh_name"], p["material_name"]),
    "set_diffuse_color":     lambda p: cc5_api.set_diffuse_color(p["mesh_name"], p["material_name"], float(p["r"]), float(p["g"]), float(p["b"])),
    "get_material_properties": lambda p: cc5_api.get_material_properties(p["mesh_name"], p["material_name"]),
    "set_material_opacity":  lambda p: cc5_api.set_material_opacity(p["mesh_name"], p["material_name"], float(p["opacity"])),
    "set_material_glossiness": lambda p: cc5_api.set_material_glossiness(p["mesh_name"], p["material_name"], float(p["glossiness"])),
    "set_material_specular": lambda p: cc5_api.set_material_specular(p["mesh_name"], p["material_name"], float(p["specular"])),
    "get_shader_parameters": lambda p: cc5_api.get_shader_parameters(p["mesh_name"], p["material_name"]),
    "set_shader_parameter": lambda p: cc5_api.set_shader_parameter(p["mesh_name"], p["material_name"], p["parameter_name"], list(p["values"])),
    # Tier 1: Content Management
    "list_clothes":          lambda p: cc5_api.list_clothes(),
    "list_hair":             lambda p: cc5_api.list_hair(),
    "list_accessories":      lambda p: cc5_api.list_accessories(),
    "remove_scene_item":     lambda p: cc5_api.remove_scene_item(p["item_name"]),
    "browse_content":        lambda p: cc5_api.browse_content(p.get("folder_type", "cloth_upper"), str(p.get("query") or "")),
    # Tier 3: Convenience Color Shortcuts
    "set_eye_color":         lambda p: cc5_api.set_eye_color(float(p["r"]), float(p["g"]), float(p["b"])),
    "set_hair_color":        lambda p: cc5_api.set_hair_color(float(p["r"]), float(p["g"]), float(p["b"])),
    "set_lip_color":         lambda p: cc5_api.set_lip_color(float(p["r"]), float(p["g"]), float(p["b"])),
    "set_skin_color":        lambda p: cc5_api.set_skin_color(float(p["r"]), float(p["g"]), float(p["b"])),
    # Tier 4: Visibility & Scene
    "set_item_visible":      lambda p: cc5_api.set_item_visible(p["item_name"], bool(p["visible"])),
    "get_scene_objects":     lambda p: cc5_api.get_scene_objects(),
    "exec_python":           lambda p: cc5_api.exec_python(p["code"]),
    # Mesh-to-MetaHuman pipeline helpers
    "bake_skin_textures":    lambda p: cc5_api.bake_skin_textures(int(p.get("resolution", 4096))),
    "export_head_metahuman": lambda p: cc5_api.export_head_metahuman(
        p["output_dir"], p["character_name"], p.get("gender", "Female"),
    ),
    "silent_install_filter": lambda p: cc5_api.silent_install_filter(
        p["output_dir"], p["character_name"],
    ),
    "silent_trigger_dialog": lambda p: cc5_api.silent_trigger_dialog(),
    "silent_configure_and_click": lambda p: cc5_api.silent_configure_and_click(
        p.get("gender", "Female"), int(p.get("max_texture_size", 4096)),
    ),
    "silent_finalize": lambda p: cc5_api.silent_finalize(),
    "get_export_status": lambda p: cc5_api.get_export_status(),
    # ActorMIXER PRO: Create Mixer Assets
    "create_actor_mixer": lambda p: cc5_api.create_actor_mixer(p),
    "get_mixer_status":   lambda p: cc5_api.get_mixer_status(),
}

# POST path -> action name
POST_ROUTES: dict[str, str] = {
    "/dialog":           "get_dialog",
    "/dialog/answer":    "answer_dialog",
    "/morphs/search":    "search_morphs",
    "/morph/get":        "get_morph_value",
    "/morph/set":        "set_morph_value",
    "/morphs/set":       "set_multiple_morphs",
    "/morphs/reset":     "reset_all_morphs",
    "/avatar/create":    "create_default_avatar",
    "/avatar/delete":    "delete_avatar",
    "/asset/load":       "load_asset",
    "/export/fbx":       "export_fbx",
    "/viewport/capture": "capture_viewport",
    "/subdivision":      "set_subdivision_level",
    "/undo":             "undo",
    "/redo":             "redo",
    "/camera/focal":     "set_camera_focal_length",
    "/camera/frame":     "frame_camera",
    "/light/color":      "set_light_color",
    "/light/info":       "get_light_info",
    "/light/multiplier": "set_light_multiplier",
    "/light/active":     "set_light_active",
    "/light/shadow":     "set_light_shadow",
    "/visual/ambient":   "set_ambient",
    "/visual/ibl":       "set_ibl",
    "/expression/set":   "set_expression",
    "/expression/reset": "reset_expression",
    "/material/info":    "get_material_info",
    "/material/color/get": "get_diffuse_color",
    "/material/color/set": "set_diffuse_color",
    "/material/properties": "get_material_properties",
    "/material/opacity":    "set_material_opacity",
    "/material/glossiness": "set_material_glossiness",
    "/material/specular":   "set_material_specular",
    "/material/shader/get": "get_shader_parameters",
    "/material/shader/set": "set_shader_parameter",
    # Tier 1: Content Management
    "/item/remove":      "remove_scene_item",
    "/content/browse":   "browse_content",
    # Tier 3: Convenience Color Shortcuts
    "/color/eye":        "set_eye_color",
    "/color/hair":       "set_hair_color",
    "/color/lip":        "set_lip_color",
    "/color/skin":       "set_skin_color",
    # Tier 4: Visibility
    "/item/visible":     "set_item_visible",
    "/exec/python":      "exec_python",
    # Mesh-to-MetaHuman pipeline helpers
    "/skin/bake":        "bake_skin_textures",
    "/export/head_mh":   "export_head_metahuman",
    "/export/head_mh/silent/install_filter":  "silent_install_filter",
    "/export/head_mh/silent/trigger_dialog":  "silent_trigger_dialog",
    "/export/head_mh/silent/configure_click": "silent_configure_and_click",
    "/export/head_mh/silent/finalize":        "silent_finalize",
    # ActorMIXER PRO: Create Mixer Assets
    "/actor_mixer/create":                    "create_actor_mixer",
}

# GET path -> action name (None = handle inline)
GET_ROUTES: dict[str, str | None] = {
    "/health":         None,
    "/reload":         None,
    "/api":            None,
    "/avatars":        "get_avatars",
    "/avatar/info":    "get_avatar_info",
    "/morphs/catalog": "get_morph_catalog",
    "/camera/info":    "get_camera_info",
    "/lights":         "get_lights",
    "/visual/settings": "get_visual_settings",
    "/expressions":    "get_expression_info",
    "/material/info":  "get_material_info",
    # Tier 1: Content Management
    "/clothes":        "list_clothes",
    "/hair":           "list_hair",
    "/accessories":    "list_accessories",
    # Tier 4: Scene
    "/scene/objects":  "get_scene_objects",
    # Silent export polling
    "/export/head_mh/status": "get_export_status",
    # ActorMIXER PRO: Create Mixer Assets polling
    "/actor_mixer/status": "get_mixer_status",
}

# Feature modules whose ACTIONS / POST_ROUTES / REQUIRED_PARAMS are merged into the
# dispatch tables above by load_extensions().
EXTENSION_MODULES: list[str] = ["cc5_pipeline", "cc5_skin", "cc5_builder", "cc5_scene"]


def load_extensions(reload: bool = False) -> list[str]:
    """Import (or reload) feature modules and merge their dispatch tables."""
    loaded: list[str] = []
    for name in EXTENSION_MODULES:
        mod = sys.modules.get(name)
        mod = importlib.reload(mod) if (reload and mod is not None) else importlib.import_module(name)
        ACTION_MAP.update(mod.ACTIONS)
        POST_ROUTES.update(mod.POST_ROUTES)
        REQUIRED_PARAMS.update(mod.REQUIRED_PARAMS)
        loaded.append(name)
    return loaded


# --- Modal dialogs: never run a command inside a dialog's nested event loop ---

# How long a queued command waits for an open modal dialog (CC5's crash-recovery prompt, a file dialog)
# to close before it fails with the dialog's text.
MODAL_WAIT_SECONDS = 5.0
# Actions built to run while their own dialog is open, plus exec_python (dev-mode debugging).
MODAL_SAFE_ACTIONS = {"silent_configure_and_click", "silent_finalize", "get_export_status",
                      "get_mixer_status", "exec_python"}
_RECOVERY_PROMPT = "Unsaved project data found"


def _modal_widget() -> Any:
    """The modal dialog CC5 is showing, or None (also when PySide2 or a QApplication is unavailable). Main thread only."""
    try:
        from PySide2.QtWidgets import QApplication, QDialog  # type: ignore
    except Exception:
        return None
    try:
        if QApplication.instance() is None:
            return None
        dialog = QApplication.activeModalWidget()
        if dialog is None:
            dialog = next((w for w in QApplication.topLevelWidgets()
                           if isinstance(w, QDialog) and w.isVisible() and w.isModal()), None)
        return dialog
    except Exception:
        return None


def _plain(text: Any) -> str:
    """Qt label text without rich-text tags, entities or mnemonic ampersands, whitespace collapsed."""
    import html
    import re
    s = re.sub(r"<br\s*/?>|</p>", "\n", str(text or ""), flags=re.I)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    return "\n".join(" ".join(line.split()) for line in s.splitlines() if line.strip())


def _dialog_buttons(dialog: Any) -> list[Any]:
    from PySide2.QtWidgets import QPushButton  # type: ignore
    return [b for b in dialog.findChildren(QPushButton)
            if b.isVisible() and b.isEnabled() and _plain(b.text()).replace("&", "")]


def _describe_modal() -> dict[str, Any] | None:
    """{title, text, buttons} of the modal dialog CC5 is showing, or None. Main thread only.

    CC5's own dialogs (e.g. "The target object layer already exists ... Replace / Material Only / Cancel")
    are not QMessageBoxes: their question sits in QLabels, so every visible label is read.
    """
    dialog = _modal_widget()
    if dialog is None:
        return None
    try:
        title = _plain(dialog.windowTitle())
    except Exception:
        return None  # e.g. the dialog was deleted while being read
    text, buttons, text_read, progress = "", [], False, False
    try:  # each part separately: a dialog whose text or buttons cannot be read is still reported
        from PySide2.QtWidgets import QMessageBox  # type: ignore
        if isinstance(dialog, QMessageBox):
            info = dialog.informativeText() if hasattr(dialog, "informativeText") else ""
            parts = [dialog.text(), info]
        else:
            from PySide2.QtWidgets import QLabel  # type: ignore
            parts = [lbl.text() for lbl in dialog.findChildren(QLabel) if lbl.isVisible()]
        text = "\n".join(p for p in (_plain(x) for x in parts) if p)
        text_read = True
    except Exception:
        pass
    try:
        buttons = [_plain(b.text()).replace("&", "") for b in _dialog_buttons(dialog)]
    except Exception:
        pass
    try:
        from PySide2.QtWidgets import QProgressDialog  # type: ignore
        progress = isinstance(dialog, QProgressDialog)
    except Exception:
        pass
    return {"title": title, "text": text, "buttons": buttons, "text_read": text_read, "progress": progress}


def _is_recovery_prompt(described: dict[str, Any]) -> bool:
    """CC5's crash-recovery question, wherever its words sit (title, any label, any line)."""
    return _RECOVERY_PROMPT.lower() in f"{described.get('title', '')}\n{described.get('text', '')}".lower()


def _is_question(described: dict[str, Any]) -> bool:
    """A dialog waiting for an answer, not a command's own progress window (whose only button is Cancel)."""
    if described.get("progress"):
        return False
    return [b.lower() for b in described.get("buttons") or []] != ["cancel"]


def _active_modal_dialog() -> tuple[str, str] | None:
    """(title, text) of the modal dialog CC5 is showing, or None."""
    described = _describe_modal()
    return (described["title"], described["text"]) if described else None


def _modal_dialog_error(title: str, text: str) -> str:
    if not title and not text:
        # Live CC5 5.13 can start with its full-screen Welcome / What's New page, an untitled modal window
        # (Qt class CRLWhatsNewWebEngineWidget, a name that means nothing to the user).
        return ("CC5's Welcome / What's New page (or another untitled CC5 window) is open - close it in "
                "Character Creator 5 (tick \"Don't show this again\" so it stays closed), then try again.")
    question = " ".join((text or title or "a dialog").split())
    if len(question) > 300:
        question = question[:297] + "..."
    where = f' (the "{title}" window)' if title and text else ""
    if _is_recovery_prompt({"title": title, "text": text}):
        action = "answer it in CC5 (OK restores your last unsaved work, Cancel discards it)"
    else:
        action = "answer or close it in CC5"
    return f'CC5 is waiting for an answer to "{question}"{where} - {action}, then try again.'


def _blocked_by_modal_dialog() -> tuple[bool, str | None]:
    """Whether the next queued command must wait for a modal dialog, and its error once the wait is over.

    (True, None): leave it queued, the next timer tick checks again. (False, error): run nothing, fail it.
    (False, None): run it.
    """
    with command_queue.mutex:
        head = command_queue.queue[0] if command_queue.queue else None
    if head is None or head["action"] in MODAL_SAFE_ACTIONS:
        return False, None
    with _store_lock:
        if head["id"] in _cancelled:
            return False, None
    dialog = _active_modal_dialog()
    if dialog is None:
        return False, None
    waiting_since = head.setdefault("modal_since", time.monotonic())
    if time.monotonic() - waiting_since < MODAL_WAIT_SECONDS:
        return True, None
    return False, _modal_dialog_error(*dialog)


# --- Dialogs a command is waiting on: report them, read them, answer them ---
#
# CC5 often asks before doing what a command asked (live: a .ccEye load on a character that already had an eye
# preset asked "The target object layer already exists ... Replace / Material Only / Cancel"). The command then
# sits inside that dialog's nested event loop, so the queue cannot run anything else. The dialog lane below is
# drained on every timer tick, even while a command runs: its actions touch only Qt widgets (never RLPy).

# Actions served by the dialog lane: pure Qt, safe inside a dialog's nested event loop.
DIALOG_ACTIONS = {"get_dialog", "answer_dialog"}
dialog_queue: queue.Queue = queue.Queue(maxsize=20)
# How long a running command's dialog stays open before its caller is told about it.
DIALOG_REPORT_SECONDS = 1.0
# Running command id -> the dialog it is waiting on: {title, text, buttons, since}. Written on the main thread.
_command_dialogs: dict[str, dict[str, Any]] = {}
# Sync commands whose caller was answered "waiting for a dialog": their result goes to _jobs instead.
_detached: set[str] = set()
# Dialog-lane commands being run right now (the lane's equivalent of _running_id).
_dialog_running: set[str] = set()


def _note_command_dialog() -> None:
    """Called on a nested timer tick while a command runs: remember the dialog it is waiting on, if any."""
    running = _running_id
    if running is None:
        return
    described = _describe_modal()
    if described is not None and not _is_question(described):
        described = None  # the command's own progress window: it is working, not asking
    with _store_lock:
        if described is None:
            _command_dialogs.pop(running, None)
        else:
            since = _command_dialogs.get(running, {}).get("since", time.monotonic())
            _command_dialogs[running] = {**described, "since": since}


def _drain_dialog_queue() -> None:
    while True:
        try:
            cmd = dialog_queue.get_nowait()
        except queue.Empty:
            return
        cmd_id = cmd["id"]
        with _store_lock:
            if cmd_id in _cancelled:
                _cancelled.discard(cmd_id)
                dialog_queue.task_done()
                continue
            _dialog_running.add(cmd_id)  # from here a timed-out caller is told "running", never "cancelled"
        try:
            handler = ACTION_MAP.get(cmd["action"])
            result = handler(cmd["params"]) if handler else {"success": False, "error": f"Unknown action: {cmd['action']}"}
        except Exception as e:
            print(f"[CC5 MCP Bridge] Dialog action '{cmd['action']}' failed: {traceback.format_exc()}")
            result = {"success": False, "error": str(e)}
        with _store_lock:
            _dialog_running.discard(cmd_id)
            event = response_events.pop(cmd_id, None)
            if event:
                response_store[cmd_id] = result
                event.set()
        dialog_queue.task_done()


def _waiting_dialog_error(dialog: dict[str, Any], job_id: str) -> str:
    question = " ".join((dialog.get("text") or dialog.get("title") or "a dialog").split())
    if len(question) > 400:
        question = question[:397] + "..."
    where = f' (the "{dialog["title"]}" window)' if dialog.get("title") and dialog.get("text") else ""
    buttons = ", ".join(dialog.get("buttons") or []) or "none found"
    if _is_recovery_prompt(dialog):
        how = "the user must answer it in CC5"
    else:
        how = "answer it with answer_cc5_dialog (ask the user when it is a real choice)"
    return (f'CC5 is waiting for an answer to "{question}"{where}. Buttons: {buttons}. '
            f'The command is still running as job {job_id}: {how}, then check its result with job_status("{job_id}").')


def get_dialog(params: dict | None = None) -> dict[str, Any]:
    """The open CC5 dialog (title, text, buttons) and the command waiting on it, if any."""
    described = _describe_modal()
    with _store_lock:
        waiting = _running_id if _running_id in _command_dialogs else None
    view = {k: described[k] for k in ("title", "text", "buttons")} if described else None
    return {"success": True, "dialog": view, "waiting_job": waiting}


# Dialogs the plugin's own tools drive (create_actor_mixer's dry run keeps "Create Mixer Assets" open on purpose):
# clicking them from answer_cc5_dialog would bypass that tool's own safety gate.
_PLUGIN_DRIVEN_TITLES = ("create mixer assets",)


def _click_later(button: Any) -> None:
    """Click from the event loop, not from inside this call: a click can start more work or open another dialog.
    Skipped if the button is gone by then (the user answered first and CC5 deleted the dialog)."""
    from PySide2.QtCore import QTimer  # type: ignore
    try:
        from shiboken2 import isValid  # type: ignore
    except Exception:
        isValid = lambda obj: True  # noqa: E731 - outside CC5 (unit tests)
    QTimer.singleShot(0, lambda: button.click() if isValid(button) else None)


def answer_dialog(button: Any, expect: Any = None) -> dict[str, Any]:
    """Click one of the open dialog's buttons by its label (case and '&' ignored).

    `expect`: words from the question the caller is answering; refused when the open dialog does not contain
    them, so an answer meant for one dialog never clicks the next one.
    """
    if not isinstance(button, str) or not button.strip() or len(button) > 100:
        return {"success": False, "error": "button must be the label of one of the dialog's buttons"}
    if expect is not None and (not isinstance(expect, str) or not expect.strip() or len(expect) > 500):
        return {"success": False, "error": "expect must be words from the dialog's question"}
    dialog = _modal_widget()
    described = _describe_modal()
    if dialog is None or described is None:
        return {"success": False, "error": "No CC5 dialog is open"}
    # Fail closed: a dialog whose words could not be read might be the crash-recovery prompt.
    if _is_recovery_prompt(described) or not described.get("text_read"):
        return {"success": False, "error": (
            '"Unsaved project data found" is the user\'s decision: answer it in CC5 '
            "(OK restores the last unsaved work, Cancel discards it)." if described.get("text_read") else
            "The dialog's text could not be read, so it may be CC5's crash-recovery prompt: "
            "ask the user to answer it in CC5.")}
    if any(t in described["title"].lower() for t in _PLUGIN_DRIVEN_TITLES):
        return {"success": False, "error": f'"{described["title"]}" is driven by its own tool; use that tool, '
                                           "or ask the user to answer it in CC5."}
    if expect is not None:
        seen = " ".join(f"{described['title']} {described['text']}".split()).lower()
        if " ".join(expect.split()).lower() not in seen:
            return {"success": False, "error": (
                f'The open dialog is not the one expected (it asks: "{described["text"] or described["title"]}"). '
                "Read it with get_cc5_dialog and answer again.")}
    wanted = button.replace("&", "").strip().lower()
    matches = [b for b in _dialog_buttons(dialog) if _plain(b.text()).replace("&", "").strip().lower() == wanted]
    if len(matches) != 1:
        found = ", ".join(described["buttons"]) or "none"
        return {"success": False, "error": f'No single button "{button}" in the dialog. Buttons: {found}'}
    _click_later(matches[0])
    view = {k: described[k] for k in ("title", "text", "buttons")}
    return {"success": True, "clicked": _plain(matches[0].text()).replace("&", ""), "dialog": view}


def process_command_queue() -> None:
    """Drain the queue and execute RLPy calls on the main thread. Called by QTimer.

    While a modal dialog is open this timer fires inside the dialog's nested event loop, so a command
    would run under the dialog: under CC5's crash-recovery prompt, before the user has decided whether
    the unsaved scene comes back, and inside an event loop RLPy calls are not made for (Task 18 traced
    CC5 crashes during FBX exports to sessions that most likely had that prompt open). Commands then
    wait in the queue, and fail with the dialog's text after MODAL_WAIT_SECONDS.
    """
    global _processing, _running_id
    _drain_dialog_queue()
    if _processing:
        # A nested tick: the running command is inside a dialog's event loop (or pumping events).
        _note_command_dialog()
        return
    _processing = True
    try:
        while not command_queue.empty():
            wait, modal_error = _blocked_by_modal_dialog()
            if wait:
                break
            try:
                cmd = command_queue.get_nowait()
            except queue.Empty:
                break

            cmd_id = cmd["id"]
            action = cmd["action"]
            params = cmd["params"]

            with _store_lock:
                if cmd_id in _cancelled:
                    # Its caller already got a 504 "cancelled": never run it late.
                    _cancelled.discard(cmd_id)
                    command_queue.task_done()
                    continue
                _running_id = cmd_id
                if cmd.get("job"):
                    _jobs[cmd_id]["status"] = "running"

            try:
                handler = ACTION_MAP.get(action)
                if modal_error:
                    result = {"success": False, "error": modal_error}
                elif handler:
                    result = handler(params)
                else:
                    result = {"success": False, "error": f"Unknown action: {action}"}
            except Exception as e:
                print(f"[CC5 MCP Bridge] Action '{action}' failed: {traceback.format_exc()}")
                result = {"success": False, "error": str(e)}

            with _store_lock:
                _running_id = None
                _command_dialogs.pop(cmd_id, None)
                if cmd_id in _detached:
                    _detached.discard(cmd_id)
                    response_events.pop(cmd_id, None)
                    failed = isinstance(result, dict) and result.get("success") is False
                    _jobs[cmd_id].update({"status": "failed" if failed else "done", "result": result})
                elif cmd.get("job"):
                    failed = isinstance(result, dict) and result.get("success") is False
                    _jobs[cmd_id].update({"status": "failed" if failed else "done", "result": result})
                else:
                    event = response_events.pop(cmd_id, None)
                    if event:
                        response_store[cmd_id] = result
                        event.set()

            command_queue.task_done()
    finally:
        _processing = False


def _validate_params(action: str, params: dict) -> str | None:
    """Validate required parameters. Returns error message or None."""
    required = REQUIRED_PARAMS.get(action)
    if not required:
        return None
    missing = [f for f in required if f not in params]
    if missing:
        return f"Missing required field(s): {', '.join(missing)}"
    return None


def _execute_sync(action: str, params: dict, timeout: float = 30.0) -> tuple[int, Any]:
    """Queue a command, wait for main-thread execution, return (http_status, result)."""
    # Validate required params before queueing (returns 400, not 500)
    error = _validate_params(action, params)
    if error:
        return 400, {"error": error}

    cmd_id = _next_command_id()
    event = threading.Event()
    lane = dialog_queue if action in DIALOG_ACTIONS else command_queue

    with _store_lock:
        response_events[cmd_id] = event

    try:
        lane.put_nowait({"id": cmd_id, "action": action, "params": params})
    except queue.Full:
        with _store_lock:
            response_events.pop(cmd_id, None)
        return 503, {"error": "server busy, command queue full"}

    deadline = time.monotonic() + timeout
    finished = False
    while True:
        if event.wait(timeout=max(0.0, min(0.25, deadline - time.monotonic()))):
            finished = True
            break
        with _store_lock:
            dialog = _command_dialogs.get(cmd_id)
            if (dialog and cmd_id not in response_store
                    and time.monotonic() - dialog["since"] >= DIALOG_REPORT_SECONDS):
                # The command opened a dialog and waits on an answer: tell the caller now, and keep the
                # command's eventual result as a job they can read after answering.
                response_events.pop(cmd_id, None)
                _detached.add(cmd_id)
                _jobs[cmd_id] = {"job_id": cmd_id, "action": action, "status": "running"}
                view = {k: dialog[k] for k in ("title", "text", "buttons")}
                return 409, {"state": "waiting_for_dialog", "job_id": cmd_id, "dialog": view,
                             "error": _waiting_dialog_error(view, cmd_id)}
        if time.monotonic() >= deadline:
            break

    if not finished:
        with _store_lock:
            # A result stored right at the deadline means the command ran: fall through
            # to the normal result handling below instead of discarding it.
            if cmd_id not in response_store:
                response_events.pop(cmd_id, None)
                if _running_id == cmd_id or cmd_id in _dialog_running:
                    return 504, {"state": "running", "error": (
                        "CC5 is still working on this command. Check the scene before retrying; "
                        "the command may still complete.")}
                _cancelled.add(cmd_id)
                return 504, {"state": "cancelled", "error": "Timed out before CC5 started the command; it was cancelled and will not run."}

    with _store_lock:
        result = response_store.pop(cmd_id, None)
        response_events.pop(cmd_id, None)

    if isinstance(result, dict) and result.get("success") is False:
        return 400, result

    return 200, {"result": result}


# --- Jobs: long operations run on the queue while the caller polls /jobs/status ---

MAX_JOBS = 200
_jobs: dict[str, dict[str, Any]] = {}
JOB_FORBIDDEN = {"exec_python", "get_dialog", "answer_dialog"}


def _start_job(action: str, params: dict) -> tuple[int, Any]:
    if action in JOB_FORBIDDEN or action not in ACTION_MAP:
        return 400, {"error": f"Action cannot run as a job: {action}"}
    error = _validate_params(action, params)
    if error:
        return 400, {"error": error}
    cmd_id = _next_command_id()
    with _store_lock:
        if len(_jobs) >= MAX_JOBS:
            # Make room by dropping the oldest finished jobs (dicts keep insertion order).
            for old_id in [j for j, v in _jobs.items() if v["status"] in ("done", "failed")][: len(_jobs) - MAX_JOBS + 1]:
                _jobs.pop(old_id, None)
        _jobs[cmd_id] = {"job_id": cmd_id, "action": action, "status": "queued"}
    try:
        command_queue.put_nowait({"id": cmd_id, "action": action, "params": params, "job": True})
    except queue.Full:
        with _store_lock:
            _jobs.pop(cmd_id, None)
        return 503, {"error": "server busy, command queue full"}
    return 200, {"result": {"job_id": cmd_id}}


def _job_status(job_id: str) -> tuple[int, Any]:
    with _store_lock:
        job = _jobs.get(job_id)
        if not job:
            return 404, {"error": f"Unknown job: {job_id}"}
        out = dict(job)
        dialog = _command_dialogs.get(job_id)
        if dialog and out.get("status") == "running" and time.monotonic() - dialog["since"] >= DIALOG_REPORT_SECONDS:
            # A job (recipe step, batch load, export) waiting on a CC5 question: say so instead of just "running".
            view = {k: dialog[k] for k in ("title", "text", "buttons")}
            out.update({"dialog": view, "dialog_message": _waiting_dialog_error(view, job_id)})
        return 200, {"result": out}


def reload_modules() -> dict[str, Any]:
    """Hot-reload cc5_api and the extension modules so code changes take effect without server restart."""
    global cc5_api
    try:
        importlib.reload(cc5_api)
        cc5_api = sys.modules["cc5_api"]
        loaded = load_extensions(reload=True)
        return {"success": True, "message": f"cc5_api and {len(loaded)} extension(s) reloaded"}
    except Exception as e:
        print(f"[CC5 MCP Bridge] Reload failed: {traceback.format_exc()}")
        return {"success": False, "error": str(e)}


def _api_info() -> dict[str, Any]:
    """Return API discovery information."""
    return {
        "service": "cc5-mcp-bridge",
        "version": API_VERSION,
        "endpoints": {
            "GET": {p: a or "inline" for p, a in GET_ROUTES.items()},
            "POST": dict(POST_ROUTES),
        },
        "required_params": REQUIRED_PARAMS,
    }


class BridgeHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the CC5 bridge API."""

    def log_message(self, format: str, *args: Any) -> None:
        # Log non-2xx responses for debugging
        if args and not str(args[0]).startswith("2"):
            print(f"[CC5 MCP Bridge] {format % args}")

    def _send_json(self, status: int, data: Any) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError:
            raise ValueError(f"Invalid Content-Length: {raw_length!r}")
        if length <= 0:
            return {}
        if length > MAX_REQUEST_BYTES:
            raise ValueError(f"Request body too large: {length} bytes (max {MAX_REQUEST_BYTES})")
        try:
            data = self.rfile.read(min(length, MAX_REQUEST_BYTES))
            parsed = json.loads(data)
        except (json.JSONDecodeError, ValueError) as e:
            raise ValueError(f"Invalid JSON in request body: {e}") from e
        if not isinstance(parsed, dict):
            raise ValueError("Request body must be a JSON object")
        return parsed

    def _allowed_host(self) -> bool:
        port = self.server.server_address[1]
        host = (self.headers.get("Host") or "").strip().lower()
        return host in (f"127.0.0.1:{port}", f"localhost:{port}")

    def _check_request(self, require_json: bool) -> bool:
        """Guard every request. Fails closed: anything unexpected is rejected."""
        if not self._allowed_host():
            self._send_json(403, {"error": "Forbidden host"})
            return False
        # Compare bytes: compare_digest raises TypeError on non-ASCII str, and http.server
        # decodes headers as latin-1, so a stray high byte must yield 401, not a dropped socket.
        supplied = (self.headers.get(TOKEN_HEADER) or "").encode("utf-8", "surrogatepass")
        if not hmac.compare_digest(supplied, TOKEN.encode("utf-8", "surrogatepass")):
            self._send_json(401, {"error": "Missing or invalid bridge token"})
            return False
        if require_json:
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                self._send_json(415, {"error": "Content-Type must be application/json"})
                return False
        return True

    def do_GET(self) -> None:
        path = urlparse(self.path).path

        if path == "/health":
            self._send_json(200, {"result": {"status": "ok", "service": "cc5-mcp-bridge", "version": API_VERSION}})
            return

        if not self._check_request(require_json=False):
            return

        if path == "/api":
            if DEV_MODE:
                self._send_json(200, {"result": _api_info()})
            else:
                self._send_json(200, {"result": {"service": "cc5-mcp-bridge", "version": API_VERSION}})
            return

        if path == "/reload":
            if not DEV_MODE:
                self._send_json(403, {"error": "/reload disabled. Set CC5_DEV_MODE=1."})
                return
            result = reload_modules()
            self._send_json(200 if result.get("success") else 500, {"result": result})
            return

        action = GET_ROUTES.get(path)
        if action:
            status, data = _execute_sync(action, {})
            self._send_json(status, data)
        else:
            self._send_json(404, {"error": f"Not found: {path}"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path

        try:
            params = self._read_json()
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return

        if not self._check_request(require_json=True):
            return

        if path == "/jobs/start":
            job_params = params.get("params") or {}
            if not isinstance(job_params, dict):
                self._send_json(400, {"error": "params must be a JSON object"})
                return
            status, data = _start_job(str(params.get("action", "")), job_params)
            self._send_json(status, data)
            return
        if path == "/jobs/status":
            status, data = _job_status(str(params.get("job_id", "")))
            self._send_json(status, data)
            return

        action = POST_ROUTES.get(path)
        if action:
            if action == "exec_python" and not DEV_MODE and os.environ.get("CC5_ALLOW_EXEC", "").strip().lower() not in ("1", "true", "yes"):
                self._send_json(403, {"error": "/exec/python disabled. Set CC5_DEV_MODE=1 or CC5_ALLOW_EXEC=1."})
                return
            status, data = _execute_sync(action, params)
            self._send_json(status, data)
        else:
            self._send_json(404, {"error": f"Not found: {path}"})


class ReusableHTTPServer(ThreadingHTTPServer):
    # One thread per request, so /health answers while a command runs.
    # RLPy still runs only on CC5's main thread, via the command queue.
    allow_reuse_address = True
    daemon_threads = True


def start_server(port: int = 5101) -> threading.Thread:
    """Start the HTTP bridge server in a background daemon thread."""
    global _httpd
    load_extensions()  # before binding, so a failing extension import leaves no open socket
    httpd = ReusableHTTPServer(("127.0.0.1", port), BridgeHandler)
    _httpd = httpd

    def run() -> None:
        httpd.serve_forever()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def stop_server() -> None:
    """Shut down the HTTP server gracefully."""
    global _httpd
    if _httpd is not None:
        _httpd.shutdown()
        _httpd.server_close()
        _httpd = None
