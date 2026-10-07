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
import re
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


# F-63: the request log goes to requests.log next to the token, never to stdout. Past REQUEST_LOG_MAX_BYTES it moves
# to requests.log.1 (replacing the older one), so the log stays under about twice that size.
REQUEST_LOG_MAX_BYTES = 1_000_000
_request_log_lock = threading.Lock()


def _request_log_path() -> str:
    return os.path.join(os.path.dirname(_token_path()), "requests.log")


def _write_request_log(line: str) -> None:
    """Append one timestamped line to requests.log. Never raises and never prints (it runs on HTTP threads)."""
    try:
        with _request_log_lock:
            path = _request_log_path()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            try:
                if os.path.getsize(path) > REQUEST_LOG_MAX_BYTES:
                    os.replace(path, path + ".1")
            except OSError:
                pass  # no log yet (or the old one could not be moved: keep appending)
            with open(path, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
    except Exception:
        pass


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
    "frame_camera":          lambda p: cc5_api.frame_camera(p.get("view", "face"), p.get("target")),
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

# Who answers the crash-recovery prompt (Chad, 2026-10-05, flight 01 F-52: "Having Claude run this autonomously is
# part of the problem"). CC5_RECOVERY_ANSWER=cancel|ok makes the dialog lane answer it as soon as it appears; the
# launcher Claude uses (scripts/cc5-restart.ps1) sets cancel. Unset or anything else = "ask": the user answers it in
# CC5, as before (a CC5 started by hand).
_RECOVERY_BUTTONS = {"cancel": "Cancel", "ok": "OK"}


def _recovery_policy() -> str:
    value = os.environ.get("CC5_RECOVERY_ANSWER", "").strip().lower()
    return value if value in _RECOVERY_BUTTONS else "ask"


RECOVERY_ANSWER = _recovery_policy()
# The prompt only appears while CC5 starts: stop looking for it after this long.
RECOVERY_WATCH_SECONDS = 600.0
_recovery_watch_started = time.monotonic()
# What the lane answered: [{time, button, text}] (newest last, at most 10).
_recovery_answers: list[dict[str, Any]] = []


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


# F-85 (live CC5 5.13): SkinGen's About box ("CCSkinGen") shows the licence serial in a label ("S/N : <serial>"), and
# every message that repeats a dialog's text put it into the agent's conversation and the MCP server's log. The value
# after a serial or licence label (optional ':' or '#') is replaced; with no ':' or '#' only a following word that holds
# a digit counts as the value, so a sentence such as "Your license has expired" stays readable. The value may sit on
# the next line (P-4: a dialog's text is its labels joined by newlines, and a form shows the label and the value in
# two labels).
_SECRET_LABEL_WORDS = (r"(S/N|SN|Serial\s+Number|Serial\s+No\.?|Serial|Licen[cs]e\s+Key|Licen[cs]e|Product\s+Key"
                       r"|Activation\s+Code|Registration\s+Code)")
_SECRET_LABEL = re.compile(
    r"(?<![A-Za-z0-9])"
    + _SECRET_LABEL_WORDS +
    r"(?![A-Za-z0-9])"
    r"(?:(\s*[:#]\s*)([^\n]*\S)|(\s+)((?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]*))",
    re.IGNORECASE)
# A line that is only a serial or licence label (optional ':' or '#'): the dialog part after it is its value,
# whatever it holds (P-4).
_SECRET_LABEL_LINE = re.compile(_SECRET_LABEL_WORDS + r"\s*[:#]?", re.IGNORECASE)
# A key on its own: three or more groups of 4-6 letters or digits joined by '-' (e.g. ABCDE-12345-FGHIJ-67890).
_SECRET_TOKEN = re.compile(r"\b[A-Za-z0-9]{4,6}(?:-[A-Za-z0-9]{4,6}){2,}\b")
SECRET_PLACEHOLDER = "(serial)"


def _redact_secrets(text: str) -> str:
    """`text` with licence serials and keys replaced by "(serial)" (F-85). Text without one comes back unchanged."""
    def label(m: re.Match) -> str:
        separator = m.group(2) if m.group(2) is not None else m.group(4)
        return f"{m.group(1)}{separator}{SECRET_PLACEHOLDER}"

    return _SECRET_TOKEN.sub(SECRET_PLACEHOLDER, _SECRET_LABEL.sub(label, text or ""))


def _dialog_text(parts: list[Any]) -> str:
    """A dialog's text: its parts (its visible QLabels, or a QMessageBox's text and informative text) joined by
    newlines, with licence serials redacted (F-85).

    Each part is redacted on its own and the joined text once more (P-4): a form shows the label and the value in two
    labels ("Serial Number:", then the key), and a QMessageBox can end its text with the label and hold the value in
    its informative text. The part after one whose last line is only a serial or licence label is replaced whole,
    also a value without a digit. Over-redacting a line of a dialog is the safe direction.
    """
    cleaned = [p for p in (_redact_secrets(_plain(x)) for x in parts) if p]
    label_only = [bool(_SECRET_LABEL_LINE.fullmatch((p.splitlines() or [""])[-1].strip())) for p in cleaned]
    for i in range(1, len(cleaned)):
        if label_only[i - 1]:
            cleaned[i] = SECRET_PLACEHOLDER
    return _redact_secrets("\n".join(cleaned))


def _describe_modal() -> dict[str, Any] | None:
    """{title, text, buttons, text_read, progress, buttons_unreadable} of the modal dialog CC5 is showing, or None.
    Main thread only.

    CC5's own dialogs (e.g. "The target object layer already exists ... Replace / Material Only / Cancel")
    are not QMessageBoxes: their question sits in QLabels, so every visible label is read. Licence serials in the
    title and the labels are redacted here (F-85), the one source of every message that shows a dialog's text: the
    queue guard, the waiting error, job_status, get_cc5_dialog and check_cc5_connection.
    """
    dialog = _modal_widget()
    if dialog is None:
        return None
    try:
        title = _redact_secrets(_plain(dialog.windowTitle()))
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
        text = _dialog_text(parts)
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
    buttons_unreadable = False
    if not buttons:
        # F-99 (live CC5 5.13): CC5's Export FBX dialog (IC::CFbxExportDialog) is one QQuickWidget whose buttons are
        # QML items; its only button widget is the title bar's unlabelled close button. So it is no window with no
        # buttons: the user answers or closes it in CC5, and no MCP tool can click it. QObject.inherits() goes by Qt
        # class name, so no QtQuick import is needed.
        try:
            from PySide2.QtCore import QObject  # type: ignore
            buttons_unreadable = any(child.inherits("QQuickWidget") or child.inherits("QWindowContainer")
                                     for child in dialog.findChildren(QObject))
        except Exception:
            pass
    return {"title": title, "text": text, "buttons": buttons, "text_read": text_read, "progress": progress,
            "buttons_unreadable": buttons_unreadable}


def _is_recovery_prompt(described: dict[str, Any]) -> bool:
    """CC5's crash-recovery question, wherever its words sit (title, any label, any line)."""
    return _RECOVERY_PROMPT.lower() in f"{described.get('title', '')}\n{described.get('text', '')}".lower()


def _is_question(described: dict[str, Any]) -> bool:
    """A dialog waiting for an answer, not a command's own progress window (whose only button is Cancel)."""
    if described.get("progress"):
        return False
    return [b.lower() for b in described.get("buttons") or []] != ["cancel"]


def _is_window_to_close(described: dict[str, Any]) -> bool:
    """A window no MCP tool can answer: no button the bridge can click (none at all, F-85, or QML ones, F-99), so the
    user closes (or answers) it in CC5.

    Not a progress window, nor one whose text could not be read, nor the crash-recovery prompt: that one stays a
    question even when its buttons could not be read, since closing it decides about the user's unsaved work.
    """
    if described.get("progress") or not described.get("text_read") or _is_recovery_prompt(described):
        return False
    return bool(described.get("buttons_unreadable")) or not described.get("buttons")


def _window_to_close_text(title: str, text: str, buttons_unreadable: bool = False) -> str:
    """How such a window is named, without the caller's next step (the queue guard's "then try again", the waiting
    error's job): CC5's untitled Welcome / What's New page (F-94), a window whose buttons are QML items (F-99), or a
    window with no buttons (F-85).

    Named by its title, else its first line, never by its whole text: SkinGen's About box holds the licence serial.
    """
    first_line = next((line.strip() for line in (text or "").splitlines() if line.strip()), "")
    name = title or first_line
    if not name:
        # Live CC5 5.13 can start with its full-screen Welcome / What's New page, an untitled modal window
        # (Qt class CRLWhatsNewWebEngineWidget, a name that means nothing to the user).
        return ("CC5's Welcome / What's New page (or another untitled CC5 window) is open - close it in "
                "Character Creator 5 (tick \"Don't show this again\" so it stays closed)")
    if len(name) > 120:
        name = name[:117] + "..."
    if buttons_unreadable:
        return (f'CC5 has a window open whose buttons this bridge cannot read: "{name}" - answer or close it in '
                "Character Creator 5 (no MCP tool can click its buttons)")
    return (f'CC5 has a window open with no buttons: "{name}" - close it in Character Creator 5 (no MCP tool can '
            "close it)")


def _dialog_view(described: dict[str, Any]) -> dict[str, Any]:
    """What the MCP server is told about a dialog (get_dialog, a 409, job_status).

    Its title, text and buttons; text_read, False when its labels could not be read (review #8: the tools then word it
    as the queue guard does); and buttons_unreadable, only when set (F-99).
    """
    view = {k: described[k] for k in ("title", "text", "buttons")}
    view["text_read"] = bool(described.get("text_read"))
    if described.get("buttons_unreadable"):
        view["buttons_unreadable"] = True
    return view


def _active_modal_dialog() -> tuple[str, str] | None:
    """(title, text) of the modal dialog CC5 is showing, or None."""
    described = _describe_modal()
    return (described["title"], described["text"]) if described else None


def _modal_dialog_error(title: str, text: str, described: dict[str, Any] | None = None) -> str:
    if described is None and not title and not text:
        # CC5's untitled Welcome / What's New page (F-94), for a caller that has no description. With one, that page
        # is named below as a window to close: only an untitled, textless window with no button the bridge can click
        # whose text was read, as formatDialog (src/tools/dialog.ts) and _waiting_dialog_error name it. An untitled
        # window with buttons stays a question, a progress window stays busy, and one whose text could not be read
        # (it may be the crash-recovery prompt) stays a question for the user.
        return f"{_window_to_close_text('', '')}, then try again."
    question = " ".join((text or title or "a dialog").split())
    if len(question) > 300:
        question = question[:297] + "..."
    where = f' (the "{title}" window)' if title and text else ""
    if described is not None and not _is_question(described):
        # A command's own progress window (an export's): not a question, and its Cancel aborts that command (F-56).
        return (f'CC5 is busy with "{title or question}" (the progress window of a command it is running) - try '
                "again when it closes. Do not cancel it unless the user asks; they cancel it in CC5.")
    if described is not None and _is_window_to_close(described):
        # F-85: a window with no buttons (live: SkinGen's About box, whose labels hold the licence serial) is no
        # question, and answer_cc5_dialog has nothing to click. F-99: nor can it click a QML dialog's buttons.
        unreadable = bool(described.get("buttons_unreadable"))
        return f"{_window_to_close_text(title, text, unreadable)}, then try again."
    if _is_recovery_prompt({"title": title, "text": text}):
        action = "answer it in CC5 (OK restores your last unsaved work, Cancel discards it)"
    elif described is not None and not described.get("text_read"):
        action = "its text could not be read, so ask the user to answer it in CC5"
    else:
        # The guard runs only while no MCP command is running, so no MCP command is waiting on this dialog: it is
        # the user's own or CC5's, and not a confirmation of something the user asked the agent to do.
        action = "no MCP command is waiting on it, so it is probably the user's own or CC5's: ask the user to answer or close it in CC5"
    return f'CC5 is waiting for an answer to "{question}"{where} - {action}, then try again.'


def _blocked_by_modal_dialog() -> tuple[bool, str | None]:
    """Whether the next queued command must wait for a modal dialog, and its error once the wait is over.

    (True, None): leave it queued, the next timer tick checks again. (False, error): run nothing, fail it.
    (False, None): run it.

    The wait counts from the first tick that saw the dialog (the head's modal_since). With no dialog open the stamp is
    dropped (batch F review #0): a capture or an OBJ replace the F-104 gate holds stays first in the queue after the
    dialog closed, and a later dialog gets its own MODAL_WAIT_SECONDS instead of failing it at once.
    """
    with command_queue.mutex:
        head = command_queue.queue[0] if command_queue.queue else None
    if head is None or head["action"] in MODAL_SAFE_ACTIONS:
        return False, None
    with _store_lock:
        if head["id"] in _cancelled:
            return False, None
    described = _describe_modal()
    if described is None:
        head.pop("modal_since", None)  # only the main thread touches a queued command's dict
        return False, None
    waiting_since = head.setdefault("modal_since", time.monotonic())
    if time.monotonic() - waiting_since < MODAL_WAIT_SECONDS:
        return True, None
    return False, _modal_dialog_error(described["title"], described["text"], described)


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
    """What the caller of a command that waits in `dialog` is told: the 409 and a waiting job's dialog_message.

    Every text names the job as job_status("<id>"), which src/build-session.ts jobIdFromWaitingText reads, and starts
    with a prefix its isBlockedByDialog knows.
    """
    if _is_window_to_close(dialog):
        # Review #7 / #19: a window with no buttons (F-84: bake_skin_textures opened SkinGen's About box) or a QML
        # dialog (F-99) has nothing answer_cc5_dialog can click. Worded as the queue guard words it, with the job
        # instead of "then try again".
        unreadable = bool(dialog.get("buttons_unreadable"))
        window = _window_to_close_text(dialog.get("title") or "", dialog.get("text") or "", unreadable)
        return (f'{window}. The command is still running as job {job_id}: read its result with '
                f'job_status("{job_id}") once it is closed.')
    question = " ".join((dialog.get("text") or dialog.get("title") or "a dialog").split())
    if len(question) > 400:
        question = question[:397] + "..."
    where = f' (the "{dialog["title"]}" window)' if dialog.get("title") and dialog.get("text") else ""
    buttons = ", ".join(dialog.get("buttons") or []) or "none found"
    if _is_recovery_prompt(dialog):
        allowed = _RECOVERY_BUTTONS.get(RECOVERY_ANSWER)
        how = (f'answer it with answer_cc5_dialog("{allowed}") (CC5_RECOVERY_ANSWER={RECOVERY_ANSWER})' if allowed
               else "the user must answer it in CC5")
    elif not dialog.get("text_read"):
        # answer_dialog refuses a dialog whose text could not be read (it may be the recovery prompt): as the guard.
        how = "its text could not be read, so ask the user to answer it in CC5"
    else:
        how = "answer it with answer_cc5_dialog (ask the user when it is a real choice)"
    return (f'CC5 is waiting for an answer to "{question}"{where}. Buttons: {buttons}. '
            f'The command is still running as job {job_id}: {how}, then check its result with job_status("{job_id}").')


def get_dialog(params: dict | None = None) -> dict[str, Any]:
    """The open CC5 dialog (title, text, buttons, text_read, progress; buttons_unreadable when set) and the command
    waiting on it, if any.
    """
    described = _describe_modal()
    with _store_lock:
        waiting = _running_id if _running_id in _command_dialogs else None
    view = _dialog_view(described) if described else None
    if view is not None:
        # A command's own progress window (an export's), not a question (live, F-56).
        view["progress"] = not _is_question(described)
    result: dict[str, Any] = {"success": True, "dialog": view, "waiting_job": waiting}
    with _store_lock:
        if _recovery_answers:
            result["recovery_answered"] = list(_recovery_answers)
    result["recovery_policy"] = RECOVERY_ANSWER
    return result


# Dialogs the plugin's own tools drive (create_actor_mixer's dry run keeps "Create Mixer Assets" open on purpose):
# clicking them from answer_cc5_dialog would bypass that tool's own safety gate.
_PLUGIN_DRIVEN_TITLES = ("create mixer assets",)


def _click_now(button: Any) -> None:
    """Click the button found a moment ago in this same call, on the main thread.

    Live (CC5 5.13, PySide2 5.15.0a1), two deferred clicks (QTimer.singleShot(0, callable), then a kept-alive
    single-shot QTimer, both behind shiboken2.isValid) were reported as made but never reached CC5's QMessageBox;
    a direct click() from a timer callback answered it at once. If a click opens another dialog, this call (and
    the dialog lane) waits in that dialog until it is answered in CC5; its caller is then told "still running".
    """
    button.click()


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
    if not described.get("text_read"):
        return {"success": False, "error": "The dialog's text could not be read, so it may be CC5's crash-recovery "
                                           "prompt: ask the user to answer it in CC5."}
    if _is_recovery_prompt(described):
        allowed = _RECOVERY_BUTTONS.get(RECOVERY_ANSWER)
        if allowed is None or button.replace("&", "").strip().lower() != allowed.lower():
            return {"success": False, "error": (
                '"Unsaved project data found" is the user\'s decision: answer it in CC5 '
                "(OK restores the last unsaved work, Cancel discards it)." if allowed is None else
                f'This CC5 was started with CC5_RECOVERY_ANSWER={RECOVERY_ANSWER}: the recovery prompt may only be '
                f'answered "{allowed}".')}
    if any(t in described["title"].lower() for t in _PLUGIN_DRIVEN_TITLES):
        return {"success": False, "error": f'"{described["title"]}" is driven by its own tool; use that tool, '
                                           "or ask the user to answer it in CC5."}
    if not _is_question(described):
        # A command's own progress window (an export's): its Cancel aborts that command (F-56).
        return {"success": False, "error": f'"{described["title"]}" is the progress window of a command CC5 is '
                                           "running, not a question. It closes by itself when the command ends; "
                                           "cancelling it aborts the command, so only the user should do that, in CC5."}
    if described.get("buttons_unreadable") and _is_window_to_close(described):
        # F-99: its buttons are QML items (live: CC5's Export FBX dialog), which the bridge can neither see nor click.
        return {"success": False, "error": f"{_window_to_close_text(described['title'], described['text'], True)}."}
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
    clicked = _plain(matches[0].text()).replace("&", "")
    _click_now(matches[0])
    with _store_lock:
        job = _jobs.get(_running_id) if _running_id is not None else None
        if job is not None:
            # F-98: the waiting job keeps what was clicked in it (live: after the user's Cancel in Replace / Material
            # Only, the recipe reported the step OK although CC5 applied nothing). /jobs/status returns it.
            job.setdefault("answers", []).append({"button": clicked, "title": described["title"]})
    return {"success": True, "clicked": clicked, "dialog": _dialog_view(described)}


def _auto_answer_recovery() -> None:
    """Answer CC5's crash-recovery prompt with the CC5_RECOVERY_ANSWER button, and record it. Main thread only.

    Only a prompt whose text was read and names "Unsaved project data found" is answered, only with the one
    configured button, and only while CC5 starts (RECOVERY_WATCH_SECONDS).
    """
    if RECOVERY_ANSWER not in _RECOVERY_BUTTONS:
        return
    if time.monotonic() - _recovery_watch_started > RECOVERY_WATCH_SECONDS:
        return
    dialog = _modal_widget()
    if dialog is None:
        return
    described = _describe_modal()
    if not described or not described.get("text_read") or not _is_recovery_prompt(described):
        return
    label = _RECOVERY_BUTTONS[RECOVERY_ANSWER].lower()
    try:
        matches = [b for b in _dialog_buttons(dialog) if _plain(b.text()).replace("&", "").strip().lower() == label]
    except Exception:
        return
    if len(matches) != 1:
        return
    try:
        _click_now(matches[0])
    except Exception as e:  # e.g. the button was deleted mid-tick: never stop the rest of the dialog lane
        print(f"[CC5 MCP Bridge] Answering the recovery prompt failed: {e}")
        return
    record = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "button": _RECOVERY_BUTTONS[RECOVERY_ANSWER],
              "text": described.get("text", "")}
    with _store_lock:
        _recovery_answers.append(record)
        del _recovery_answers[:-10]
    print(f'[CC5 MCP Bridge] Answered "{_RECOVERY_PROMPT}" with {record["button"]} (CC5_RECOVERY_ANSWER)')


def process_dialog_lane() -> None:
    """Serve the dialog lane and watch the running command for a dialog. Called by its own QTimer.

    It cannot ride on the command timer: Qt never fires a timer again while that timer's own callback is still
    running, and a command waiting in a dialog it opened is exactly that callback. Live (CC5 5.13), with one
    timer, a second .ccEye load sat in "Replace / Material Only" and neither the report nor get_cc5_dialog ran.
    """
    _auto_answer_recovery()
    _drain_dialog_queue()
    if _processing:
        _note_command_dialog()


# --- F-104: a capture or an OBJ replace waits until CC5 has settled after the previous command ---
#
# Live CC5 5.13 (2026-10-07): CC5 goes on loading a file's images after LoadFile returns (REventCallback
# OnImageAsyncLoadStart ... OnImageAsyncLoadAllDone). capture_viewport undoes one step after its render (F-53), and a
# render made in that window gets no step of its own, so the capture's undo took the load back: with a load job and a
# capture queued together, Box_001 was gone in 6 of 7 runs. replace_mesh_from_obj started right after load_texture
# misread the OBJ by 95.44 cm (F-101). A queue that held both until 0.3 s after the previous command ended and until
# CC5's image load was done kept the box 5 of 5 and the replace exact 2 of 2. No help: one command per timer tick,
# waiting until Qt's event loop went idle, BeginAction(name, bBlockRecordUndo=True) around RenderImage, and
# BeginAction/EndAction around it. Two ordinary loads queued together stay separate undo steps, so only these two
# actions wait.
SETTLE_ACTIONS = frozenset({"capture_viewport", "replace_mesh_from_obj"})
SETTLE_SECONDS = 0.3
# The longest an image load holds them, counted from CC5's last OnImageAsyncLoadStart: an AllDone that never comes must
# not hold them for good, and a held direct call (capture_viewport) still starts within _execute_sync's 30 s.
IMAGE_LOAD_WAIT_SECONDS = 20.0
_last_command_end: float | None = None  # time.monotonic() when the last command the queue ran ended
# Also read by name by cc5_api.capture_viewport (_images_still_loading, batch F review #2): a capture that runs while it
# is set leaves its own undo step alone.
_images_loading = False
_images_loading_since = 0.0
# The registered REventCallback and the id RegisterCallback gave it: kept here, so that Python never collects an object
# CC5 still calls.
_image_watch: Any = None
_image_watch_id: Any = None


def _note_image_load_start() -> None:
    """OnImageAsyncLoadStart: CC5 began loading images in the background. CC5 calls it, so it never raises."""
    global _images_loading, _images_loading_since
    try:
        _images_loading_since = time.monotonic()
        _images_loading = True
    except Exception:
        pass


def _note_image_load_done() -> None:
    """OnImageAsyncLoadAllDone: CC5 has loaded every image it was loading. CC5 calls it, so it never raises."""
    global _images_loading
    _images_loading = False


def start_image_watch() -> bool:
    """Watch CC5's background image loads for the F-104 gate (initialize_plugin, main thread). True when it is on.

    The REventCallback subclass is built here, not at import: RLPy exists only inside CC5, and the tests' fake RLPy
    cannot be a base class. A registration that fails prints one line and leaves the watch off; the queue then holds
    SETTLE_ACTIONS for SETTLE_SECONDS after the previous command only.
    """
    global _image_watch, _image_watch_id
    if _image_watch is not None:
        return True  # registered already: a second callback would only double every call
    try:
        import RLPy  # type: ignore

        class _ImageLoadWatch(RLPy.REventCallback):
            def __init__(self) -> None:
                RLPy.REventCallback.__init__(self)

            def OnImageAsyncLoadStart(self) -> None:
                try:
                    _note_image_load_start()
                except Exception:
                    pass

            def OnImageAsyncLoadAllDone(self) -> None:
                try:
                    _note_image_load_done()
                except Exception:
                    pass

        watch = _ImageLoadWatch()
        watch_id = RLPy.REventHandler.RegisterCallback(watch)
    except Exception as e:
        reason = " ".join(str(e).split())
        print(f"[CC5 MCP Bridge] CC5's image loads are not watched (F-104): {reason}")
        return False
    _image_watch, _image_watch_id = watch, watch_id
    return True


def stop_image_watch() -> None:
    """Unregister the image-load watch (uninitialize_plugin, before the server stops). Never raises.

    A watch CC5 would not unregister stays referenced here: CC5 may still call it.
    """
    global _image_watch, _image_watch_id, _images_loading
    if _image_watch is None:
        return
    try:
        import RLPy  # type: ignore
        RLPy.REventHandler.UnregisterCallback(_image_watch_id)
    except Exception as e:
        reason = " ".join(str(e).split())
        print(f"[CC5 MCP Bridge] Unregistering the image-load watch failed: {reason}")
        return
    _image_watch, _image_watch_id, _images_loading = None, None, False


def _settled(now: float) -> bool:
    """Whether a SETTLE_ACTIONS command may run at `now`: SETTLE_SECONDS after the previous command ended, and with no
    background image load that started less than IMAGE_LOAD_WAIT_SECONDS ago.
    """
    if _last_command_end is not None and now - _last_command_end < SETTLE_SECONDS:
        return False
    if _images_loading and now - _images_loading_since < IMAGE_LOAD_WAIT_SECONDS:
        return False
    return True


def _held_until_settled() -> bool:
    """Whether the next queued command is a SETTLE_ACTIONS command that must wait for CC5 to settle (F-104).

    It stays first in the queue, so the commands behind it keep their order. A cancelled one is not held: it never
    runs, and it must not keep the commands behind it waiting.
    """
    with command_queue.mutex:
        try:
            head = command_queue.queue[0]
        except IndexError:
            return False
    if head["action"] not in SETTLE_ACTIONS:
        return False
    with _store_lock:
        if head["id"] in _cancelled:
            return False
    return not _settled(time.monotonic())


def process_command_queue() -> None:
    """Drain the queue and execute RLPy calls on the main thread. Called by QTimer.

    While a modal dialog is open this timer fires inside the dialog's nested event loop, so a command
    would run under the dialog: under CC5's crash-recovery prompt, before the user has decided whether
    the unsaved scene comes back, and inside an event loop RLPy calls are not made for (Task 18 traced
    CC5 crashes during FBX exports to sessions that most likely had that prompt open). Commands then
    wait in the queue, and fail with the dialog's text after MODAL_WAIT_SECONDS.

    A capture or an OBJ replace (SETTLE_ACTIONS) also waits at the head of the queue until CC5 has settled after the
    previous command (F-104: _settled); it runs on a later tick, and the commands behind it keep their order.
    """
    global _processing, _running_id, _last_command_end
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
            # A command that fails with the dialog's text runs nothing in CC5, so it is not held.
            if modal_error is None and _held_until_settled():
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
            _last_command_end = time.monotonic()  # F-104: a capture or an OBJ replace waits SETTLE_SECONDS from here

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
                view = _dialog_view(dialog)
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
        if "answers" in out:
            out["answers"] = [dict(a) for a in out["answers"]]  # F-98: a copy, as answer_dialog may add one meanwhile
        now = time.monotonic()
        dialog = _command_dialogs.get(job_id)
        if dialog and out.get("status") == "running" and now - dialog["since"] >= DIALOG_REPORT_SECONDS:
            # A job (recipe step, batch load, export) waiting on a CC5 question: say so instead of just "running".
            view = _dialog_view(dialog)
            out.update({"dialog": view, "dialog_message": _waiting_dialog_error(view, job_id)})
        elif out.get("status") == "queued" and _running_id is not None and _running_id != job_id:
            # Queued behind a command that waits on a CC5 question: it cannot start before that answer, so say so
            # instead of "still running" (C2b review: a recipe's later steps waited 120 s each, then said "still
            # running"). It is not cancelled: it runs once the question is answered, or the window closed.
            blocking = _command_dialogs.get(_running_id)
            if blocking and now - blocking["since"] >= DIALOG_REPORT_SECONDS:
                view = _dialog_view(blocking)
                after = "once that window is closed" if _is_window_to_close(view) else "after that answer"
                out.update({"dialog": view, "blocked_by": _running_id, "dialog_message": (
                    f"Job {job_id} has not started: it is queued behind job {_running_id}. "
                    f"{_waiting_dialog_error(view, _running_id)} Job {job_id} runs {after}; read its "
                    f'result with job_status("{job_id}").')})
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
        # Log failed responses only. log_request passes (request line, status, size) and log_error passes
        # (status, message). The old test read args[0], the request line, so every request was printed from this
        # HTTP thread, into CC5's console or a running exec_python's captured output (live, F-57).
        status = ""
        if len(args) >= 2 and str(args[1]).isdigit():
            status = str(args[1])
        elif args and str(args[0]).isdigit():
            status = str(args[0])
        if status.startswith(("2", "3")):
            return
        # Written to requests.log, never printed: prints from HTTP threads reach CC5's console and a running
        # exec_python's redirected stdout (F-57, F-63).
        try:
            _write_request_log(format % args)
        except Exception:
            pass

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
