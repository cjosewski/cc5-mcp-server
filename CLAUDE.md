# CC5 MCP Server — Project Context

## Overview
An MCP server that lets LLMs such as Claude operate Reallusion Character Creator 5 (CC5) through natural language.

## Architecture

```
LLM (Claude) <--stdio--> MCP Server (Node.js) <--HTTP:5101--> CC5 Plugin (Python) <--RLPy--> CC5
```

## How startup works (important)

### Auto-start flow (normal operation)

```
CC5 starts
  → auto-detects OpenPlugin/CC5_MCP_Bridge/main.py
  → checks rl_plugin_info (CC5 compatibility check)
  → calls initialize_plugin()
    → bridge_server.start_server(port=5101) starts the HTTP server
    → registers process_command_queue on a QTimer(16ms)
  → the bridge starts listening on http://127.0.0.1:5101
```

**Three conditions required for auto-start:**
1. An `initialize_plugin()` function in `main.py` (CC5 naming convention; `load_plugin` does not work)
2. An `rl_plugin_info = {"ap": "iClone", "ap_version": "8.0"}` dictionary in `main.py` (CC5 runs on the iClone 8 engine)
3. The plugin is installed in `OpenPlugin/CC5_MCP_Bridge/`

**Common problems and fixes:**
- `load_plugin` → CC5 ignores it. Always use `initialize_plugin`
- `PySide6` → CC5 uses PySide2. Fails silently with an import error
- Missing `from __future__ import annotations` → type-hint errors on Python 3.10
- Flask dependency → CC5's Python has no Flask. Use stdlib `http.server`

### Watchdog (auto-recovery)

A server health check is built into the QTimer callback:
```python
def _check_server_health():
    if _server_thread is not None and not _server_thread.is_alive():
        _server_thread = bridge_server.start_server(port=BRIDGE_PORT)
```
→ Even if the HTTP server thread crashes, it is automatically restarted on the next QTimer tick

### Modal dialogs (queue guard)

While CC5 shows a modal dialog, the 16 ms QTimer fires inside that dialog's nested event loop, so a command would run under the dialog: under the "Unsaved project data found" crash-recovery prompt that means before the user has decided whether the unsaved scene comes back, inside an event loop RLPy calls are not made for (CC5 crashes during FBX exports were traced to sessions that most likely had that prompt open). `process_command_queue` therefore leaves the next command queued while `_active_modal_dialog()` reports a dialog, and after `MODAL_WAIT_SECONDS` (5 s) fails it with the dialog's title and text. The actions in `MODAL_SAFE_ACTIONS` (the silent head-export steps, the export/mixer status reads and `exec_python`) still run. Who answers the recovery prompt is set when CC5 starts (Chad, 2026-10-05, flight 01 F-52: "Having Claude run this autonomously is part of the problem"): with `CC5_RECOVERY_ANSWER=cancel` (or `ok`) the dialog lane clicks that button as soon as the prompt appears (`_auto_answer_recovery`, only during the first `RECOVERY_WATCH_SECONDS`, only a prompt whose text was read), records it, and `get_cc5_dialog` reports it. `scripts/cc5-restart.ps1` (the launcher Claude uses) sets `cancel` by default (`-RecoveryAnswer ask|ok|cancel`). Unset, or any other value, is `ask`: the user answers it in CC5, as for a CC5 started by hand.

### Dialogs a command opens (dialog lane)

CC5 often asks before doing what a command asked: a plain confirmation, or a choice (live: a second `.ccEye` load asked "The target object layer already exists ... Replace / Material Only / Cancel"). The command then waits inside that dialog's nested event loop. On each nested timer tick `_note_command_dialog` records the dialog (title, label text, buttons) in `_command_dialogs`; after `DIALOG_REPORT_SECONDS` (1 s) the waiting HTTP call returns 409 `{state: "waiting_for_dialog", job_id, dialog}` and the command's result goes to `_jobs` (read it with `job_status`). `get_dialog`/`answer_dialog` (`DIALOG_ACTIONS`) run on a separate `dialog_queue`, even while a command runs: they touch only Qt widgets, never RLPy. The lane and the dialog watch run on **their own 50 ms QTimer** (`main._dialog_timer` → `server.process_dialog_lane`): Qt never re-fires a timer while its own callback is still running, so the 16 ms command timer is silent while a command it started waits in a dialog (live: with one timer, neither the report nor `get_cc5_dialog` ran). A job waiting on a dialog reports it through `/jobs/status` (`dialog`, `dialog_message`), so recipe steps and job tools stop and show the question instead of "still running". A command's own progress window (a `QProgressDialog`, or a dialog whose only button is Cancel) is not treated as a question.

`answer_dialog` fails closed: it refuses the recovery prompt wherever its words sit (title or any label), except with the one button `CC5_RECOVERY_ANSWER` names, refuses a dialog whose text could not be read, and leaves plugin-driven dialogs (`_PLUGIN_DRIVEN_TITLES`, e.g. "Create Mixer Assets" during `create_actor_mixer`'s dry run) to their own tool. Its optional `expect` (words from the question) refuses a dialog that does not contain them, so an answer cannot land on the next dialog. The button is clicked directly, in the same call that found it (`_click_now`). Live (CC5 5.13, PySide2 5.15.0a1), two deferred clicks (`QTimer.singleShot(0, <python callable>)`, then a kept-alive single-shot `QTimer`, both behind `shiboken2.isValid`) were reported as made but never reached CC5's `QMessageBox`; a direct `click()` from a timer callback answered it at once. If a click opens another dialog, the dialog lane waits in that one until it is answered in CC5.

Answering rule (Chad, 2026-10-05): Claude answers a plain confirmation of exactly what the user asked for and says so; for a real choice it shows the question and buttons with a recommendation and lets the user pick.

### Hot reload (apply code changes immediately)

```
Edit cc5_api.py (or an extension module: cc5_pipeline.py, cc5_skin.py, cc5_builder.py) in the repo
  → copy it to the installed plugin: re-run install-plugin.ps1 (Administrator PowerShell), or copy the
    changed .py into C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge\
    (CC5 runs that copy, not the repo; without this step /reload succeeds and changes nothing)
  → curl -H "X-CC5-Token: $(cat "$LOCALAPPDATA/CC5_MCP_Bridge/token")" http://127.0.0.1:5101/reload
    (or Claude runs it automatically; CC5 must have been started with CC5_DEV_MODE=1)
  → importlib.reload(cc5_api) and the extension modules runs
  → _auto_patch_server() updates ACTION_MAP / POST_ROUTES / GET_ROUTES
  → the new code takes effect immediately (no CC5 restart needed)
```

**Limitation:** changes to server.py (adding routes, changing validation, etc.) require re-running install-plugin.ps1 and restarting CC5.
Changes to cc5_api.py and the extension modules take effect on reload, once the installed copy is updated.

### Troubleshooting

| Symptom | Cause | Fix |
|------|------|------|
| The bridge does not come up after CC5 starts | Entry function is not named `initialize_plugin` / `rl_plugin_info` is missing | Check the function name and dictionary in main.py |
| Cannot connect to port 5101 | Plugin not installed | Run `install-plugin.ps1` with administrator privileges |
| `curl /reload` returns 404 | An old server.py is running | Restart CC5 so it loads the new server.py |
| `curl /reload` etc. return 401 | Missing `X-CC5-Token` header / token mismatch | Send the value of `%LOCALAPPDATA%\CC5_MCP_Bridge\token` in `X-CC5-Token` (required on every route except `/health`) |
| `/reload` or `/exec/python` returns 403 | Dev mode is disabled (the default) | Start CC5 with `CC5_DEV_MODE=1` (for `/exec/python` only, `CC5_ALLOW_EXEC=1` also works) |
| RLPy function not found | CC5 version differences | Check with `hasattr()` and fail gracefully |
| Morphs have no effect | No avatar in the scene | Create an avatar first with `create_avatar` |
| Material color does not change | Wrong mesh/material name | Confirm the correct names with `get_material_info` |
| Undo does not work | Not wrapped in `BeginAction/EndAction` | Always wrap modifying operations in BeginAction/EndAction |
| Capture is a blank image | No avatar in the scene | Create avatar → apply morphs → capture |
| RenderImage fails | Can happen after loading a .ccProject | Automatically falls back to a Windows screenshot |
| Welcome dialog gets in the way | Shown when CC5 starts | Tick "Don't show this again", or close it by hand |
| FBX export fails with a license error | The character contains iContent-licensed assets | Try Help→Activate Purchased Items. With the Content Store assets removed, default content can be exported. Upgrading costs 20% of the list price |
| Camera focal length does not change | The Preview Camera cannot be changed via the API | CC5 has no way to create a secondary or user camera, so `set_camera_focal_length` cannot succeed on CC5. To change the lens, load a `.ccCam` preset (`browse_content("camera")` + `load_asset`): it replaces the Preview Camera with the preset's lens and framing (a new camera ID, not a second camera). The API returns an explicit error rather than reporting false success |
| Color range | Input is 0.0-1.0; RLPy returns 0-255 | Normalized on the API side (unified to 0.0-1.0) |
| `set_subdivision_level` does not add HD detail / `max_level` returns 0 | Generating SubD (HD subdivision) data is the CC5-UI-only `Modify > Subdivide` operation. It cannot be generated from RLPy. If the avatar has no HD data generated yet, `max_level = 0` | This is by design, not a failure. To use HD, run `Modify > Subdivide` once in the CC5 UI to generate the HD data. Once it is generated, switching levels via the API works |
| SubD/HD or the plugin misbehaves on CC5 versions earlier than 5.07 | Builds before 5.07 sometimes need the SubD cache or plugin modules rebuilt | Update CC5 to 5.07 or later. If you cannot update, reopen the project and regenerate (rebuild) SubD before performing API operations |

### Notes on subdivision (SubD / HD)

`set_subdivision_level` is strictly a tool for "switching between HD subdivision levels that have already been generated".
**Generating** the HD data itself is only possible through the CC5 UI operation `Modify > Subdivide`; it cannot be triggered from RLPy/the API.
Therefore an avatar without generated HD data has `max_level = 0` (no HD data), and this is **a normal state, not an error**.
The same applies to `sub_d_level` in `export_fbx`: a level above the character's highest subdivision level (0 without HD data) is refused.

> **Note for versions earlier than 5.07:** On CC5 builds earlier than 5.07, the SubD cache / plugin modules sometimes need to be rebuilt. Update to 5.07 or later if possible.

### export_fbx details

`export_fbx` reproduces CC5's "Export FBX (InstaLOD)" dialog using `RLPy.RExportFbxSetting`.
All parameters are optional (only `output_path` is required), preserving full backward compatibility with the existing behavior.

| Parameter | Dialog item | Description |
|-----------|--------------|------|
| `output_path` | Output destination | A file name without a directory (e.g. `character.fbx`) resolves under `D:\CC5Export` (configurable via `CC5_EXPORT_DIR`). Absolute paths are used as-is. |
| `target_tool` | Target Tool Preset | `"UE5"`/`"Unreal"` applies the Unreal-oriented flags (Y-up, UE bone axis). |
| `export_motion` | FBX Options | `true` = "Mesh and Motion" (default), `false` = "Mesh" only. Uses `EnableExportMotion`. |
| `sub_d_level` | HD Character Subdivision Level | 0/1/2. Applied via `SetExportLevel` (does not modify the scene). A level above the character's highest one (`GetMaxSubdivMeshLevel`) is refused. `set_subdivision_level` is used only in the flags-only fallback. |
| `embed_textures` | Texture Settings: Embed Textures | Adds `EExportFbxOptions_EmbedTexture`. |
| `convert_image_format` | Texture Settings: Convert Image Format | Refused (`CONVERT_IMAGE_FORMAT_REFUSED`): on CC5 5.13 every scripted export with `EExportFbxOptions_ConvertTifToPNG` wrote an ASCII FBX with a `.json` sidecar and PBR-split textures, then crashed CC5 within a second. |
| `texture_size` | Texture Settings: Max Texture Size | `SetTextureSize` (0 = original size). |
| `fps` | Include Motion: Frame Rate | Maps to `RLPy.RFps.Fps{n}` (e.g. 30). Unsupported values are skipped with a note. |
| `motion_range` | Include Motion: Range | Passes `[start, end]` to `SetExportMotionRange`. When omitted, the default "All" is used. |

**Switched off (Chad's ruling, 2026-10-03): `headshot_from_photo` and `import_fbx` with kind `character`.** Both crashed CC5 5.13 in live testing. They now fail at once with a plain message (Python `HEADSHOT_DISABLED` in `cc5_builder.py` and `IMPORT_CHARACTER_DISABLED` in `cc5_pipeline.py`, kept in sync with the same constants in `src/recipe.ts` and `src/tools/pipeline.ts`) and never call CC5. The user does these steps by hand: the Headshot plugin inside Character Creator 5, and File > Import in Character Creator 5. A recipe's `headshot_photo` step fails the same way. Do not test them against CC5 again until a later CC5 version is to be re-tested.

**Live finding (Task 18, CC5 5.13): the first FBX export of a CC5 session crashes CC5 most of the time**, while every later export in that session works. Tested without effect: export settings, output folder and path length, RPyTimer instead of the QTimer drain, keeping the RExportFbxSetting alive, deselecting the avatar, a clean start without the recovery prompt. The README lists it, with the other CC5 5.13 findings, under Known issues.

**Recommended Unreal (UE5 Skeleton) call:** `target_tool="UE5"`, `export_motion=true`, `sub_d_level=0`, `embed_textures=true`, `fps=30` (omit `motion_range` = All). InstaLOD is always OFF.

The return value accurately reports only the values that were actually applied (`export_level`, `export_motion`, `fps`, `motion_range`, `texture_size`, `embed_textures`, etc.). In the fallback (used when `RExportFbxSetting` is unavailable or fails), CC5 exports through the flags overload `ExportFbxFile(obj, path, flags, flags2, flags3)` (CC5 5.13 has no 2-argument form): the option flags still apply, and the `RExportFbxSetting`-only options that could not be applied (motion, frame rate/range, texture size) are recorded as WARNINGs in `notes`. Live CC5 5.13 (Task 18 fix round) ran this overload, forced through `exec_python`, 3 of 3 times without a crash (default, Unity and Blender presets in a session whose first export had survived).

### Full CC5 restart procedure

Claude asks the user before restarting CC5. Killing CC5 (`taskkill //F`, `Stop-Process`) loses unsaved work,
so the user saves and closes CC5 themselves. Nothing sends keys or clicks to CC5.

```bash
# 1. The user saves their work and closes CC5. Check that it has gone:
tasklist 2>/dev/null | grep -q "CharacterCreator" && echo "CC5 is still running"

# 2. Launch CC5 (the plugin starts the bridge automatically)
"/c/Program Files/Reallusion/Character Creator 5/Bin64/CharacterCreator.exe" &

# 3. Wait for the bridge to start (usually 7-10 seconds)
for i in $(seq 1 60); do
  curl -s --connect-timeout 1 http://127.0.0.1:5101/health | grep -q "ok" && break
  sleep 2
done

# 4. The user answers CC5's startup dialogs in CC5 (until they do, the viewport does not render correctly):
#   a) "Unsaved project data found": OK restores the auto-saved changes, Cancel discards them
#      (started with CC5_RECOVERY_ANSWER=cancel, as cc5-restart.ps1 does by default, the plugin answers Cancel)
#      (README.md, Known issues)
#   b) Welcome screen: tick "Don't show this again", or close it by hand
```

`scripts/cc5-restart.ps1` runs steps 2-3 and prints the step 4 guidance. It stops if CC5 is still running;
`-Force` kills CC5 instead, and unsaved work is lost.

### Permanent fix for the dialogs
If you check "Don't show this again" on the CC5 welcome screen and click Close,
the welcome dialog will no longer be shown from then on.
Having the user do this once is the most reliable approach.

### How viewport capture works
`capture_viewport` works through a three-stage fallback:
1. **RLPy.RenderImage()** — fastest; normally this succeeds
2. **ForceViewportUpdate + retry** — when RenderImage fails on the first attempt
3. **Windows screenshot (PowerShell)** — when RenderImage does not work at all, e.g. after loading a .ccProject

Note: fallback 3 is a full-screen capture, so the CC5 window must be in the foreground.

## Directory structure

```
cc5-mcp-server/
├── src/                    # MCP Server (TypeScript)
│   ├── index.ts            # Entry point
│   ├── cc5-bridge.ts       # CC5 HTTP client
│   ├── types.ts            # Type definitions
│   ├── util.ts             # Shared utilities (bridgeCall)
│   ├── tools/              # MCP tool definitions (12 files)
│   │   ├── morph.ts        # Morph adjustment + search + reset
│   │   ├── scene.ts        # Scene management + capture
│   │   ├── asset.ts        # Asset loading / FBX export
│   │   ├── character.ts    # Body presets + appearance description
│   │   ├── content.ts      # Content management (clothes/hair/accessories)
│   │   ├── color.ts        # Convenience color setters (eyes/hair/lips)
│   │   ├── visibility.ts   # Show/hide + scene object list
│   │   ├── edit.ts         # Undo/Redo
│   │   ├── camera.ts       # Camera control
│   │   ├── light.ts        # Light control
│   │   ├── expression.ts   # Expression info
│   │   └── material.ts     # Material/color control
│   └── resources/
│       └── morphs.ts       # Morph catalog resource
├── cc5-plugin/             # CC5 Python plugin
│   ├── main.py             # Plugin entry point (initialize_plugin/uninitialize_plugin)
│   ├── server.py           # HTTP bridge server
│   ├── cc5_api.py          # RLPy API wrapper (all API functions + _auto_patch_server)
│   ├── config.json         # Plugin settings
│   └── config.xml          # Plugin settings (XML)
├── tests/                  # Tests (314 tests, 12 files)
├── start_bridge.py         # For manual startup (normally unnecessary — auto-start works)
├── install-plugin.ps1      # Plugin installer (requires administrator privileges)
├── claude-mcp-config.json  # MCP config for Claude Code
└── CLAUDE.md               # This file
```

## Key technical information

- **CC5 Python**: Python 3.10 + PySide2 (not PySide6!)
- **RLPy**: NOT thread-safe — must run on the main thread via QTimer
- **Bridge**: `http.server` (no Flask) on port 5101
- **QTimer**: 16ms interval (~60fps) — tuned for responsiveness
- **Plugin function names**: `initialize_plugin` / `uninitialize_plugin` (`load/unload` does not work)
- **Type-hint compatibility**: `from __future__ import annotations` is required
- **Morph value range**: [-1.0, 1.0] (negative values shrink the feature)
- **morph ID cache**: automatically invalidated when the avatar changes

## Setup steps

### 1. Build the MCP Server
```bash
npm install && npm run build
```

### 2. Install the CC5 plugin (administrator privileges)
```powershell
powershell -ExecutionPolicy Bypass -File install-plugin.ps1
```

### 3. Register the MCP server in Claude Code
```json
"cc5": {
  "command": "node",
  "args": ["<path-to-project>/build/index.js"],
  "env": { "CC5_BRIDGE_URL": "http://127.0.0.1:5101" }
}
```

### 4. Launch CC5 → the bridge starts automatically (no manual steps needed)

## Available MCP tools (56)

### Scene management
| Tool | Description |
|--------|------|
| check_cc5_connection | Check the CC5 connection |
| list_avatars | List avatars in the scene |
| get_avatar_info | Avatar details and morph values |
| create_avatar | Create a neutral CC3+ base body (untextured = mannequin; for a real face, browse_content("character")+load_asset is recommended) |
| delete_avatar | Delete avatars (by name or all; used to remove the mannequin → load a real character) |
| describe_character | Describe the character's appearance in natural language |
| get_scene_objects | List all objects in the scene (avatars, props, lights, cameras) |

### Morph operations
| Tool | Description |
|--------|------|
| search_morphs | Search the morph catalog by keyword |
| adjust_morph | Adjust a single morph slider [-1, 1] |
| adjust_multiple_morphs | Adjust multiple morphs at once (up to 500) |
| get_morph_value | Get a morph's current value |
| reset_morphs | Reset all morphs to zero |
| apply_body_preset | Body preset (athletic/muscular/slim/heavy/average) |

### Content management (clothes, hair, accessories)
| Tool | Description |
|--------|------|
| list_clothes | List the clothes on the avatar by name and ID, or "No clothes are applied." (CC5's numeric type is not a garment kind and is not shown) |
| list_hair | List the hairstyles on the avatar |
| list_accessories | List the accessories on the avatar |
| remove_scene_item | Remove clothes/hair/accessories by name |
| browse_content | Browse the CC5 content folders: cloth_upper (Shirts + Coats), cloth_lower (Pants + Skirts), cloth (Full-Body), underwear, gloves, cloth_other (socks, outfit sets), shoes, accessory_head (Accessory/Head), accessory_body (Torso + Arm + Leg), accessory_other, hair, eye, plus pose/motion/expression/props/light/camera/character, makeup, skingen and image libraries. A category may read several CC5 folders; `wrinkle_mask` falls back to its parent folder (the Wrinkle Mask subfolder does not exist on CC5 5.13) |

### Camera, lights, expressions
| Tool | Description |
|--------|------|
| get_camera_info | Get camera position and focal length |
| set_camera_focal_length | Set the camera focal length |
| frame_camera | Move the camera to a preset viewpoint (face/front/home/all, etc.). CC5 frames the selected object, so the character (`target`, else the selected one, else the first) is selected for the move and the selection is put back (F-45) |
| get_lights | List the lights in the scene (deduplicated) |
| get_light_info | Light details (color/intensity/on-off/shadow casting/shadow darkness/range) |
| set_light_color | Change a light's RGB color |
| set_light_multiplier | Set light intensity (multiplier) |
| set_light_active | Turn a light on/off (lighting adjustment) |
| set_light_shadow | Set shadow casting ON/OFF + shadow darkness (darken 0-1) |
| get_visual_settings | Get ambient lighting (ambient color + IBL enabled state) |
| set_ambient | Set the scene's ambient (fill) light color (0-1) |
| set_ibl | Enable/disable IBL/HDRI + load an HDRI image |
| get_expression_info | Get expression groups and slider names |
| set_expression | Set expression sliders by name (weight 0-1, multiple allowed) |
| reset_expression | Reset all expression sliders to 0 (neutral) |

### Materials and colors
| Tool | Description |
|--------|------|
| get_material_info | List mesh and material names |
| get_shader_parameters | Get Digital Human Shader parameters (skin roughness/SSS/MicroNormal, etc.) |
| set_shader_parameter | Set Digital Human Shader parameters (name + value list, with validation) |
| set_skin_shader | Set one skin shader parameter on all four Std_Skin_* materials at once (a single material leaves a seam). Skin shine = `Original Roughness Strength` (lower = shinier); set_material_glossiness/specular are legacy non-PBR weights |
| get_diffuse_color | Get the diffuse color |
| set_diffuse_color | Set the diffuse color (skin tone, etc.) |
| set_eye_color | Set the iris color: `Iris Color` + `Iris Inner Color` of the Digital Human Eye shader on Std_Cornea_R/L (one undo step); refused for eyes without that shader (load an eye preset) |
| set_hair_color | Set the hair color (convenience shortcut) |
| set_lip_color | Set the lip color (convenience shortcut) |

### Show/hide
| Tool | Description |
|--------|------|
| set_item_visible | Show or hide a scene item |

### Selection
| Tool | Description |
|--------|------|
| select_objects | Select scene items by name (characters, worn clothing/hair/accessories, props, lights, cameras); `add` keeps the current selection. An unknown or ambiguous name changes nothing. Not an undo step |
| get_selection | List what is selected in CC5 |
| clear_selection | Deselect everything |
| delete_object | Delete props, lights and worn items by name (one undo step); characters (use delete_avatar) and the camera are refused; unknown or ambiguous names delete nothing |
| get_object_transform | Position (cm) and scale of a prop, light or character |
| set_object_transform | Move (cm) and/or scale a prop, light or character, keeping its rotation; read back before/after (one undo step) |

CC5 applies character content (eye, skin, cloth presets) to the **selected** character: live, a `.ccEye` loaded with nothing selected reported success and did nothing. `load_asset` therefore aims character content (`_CHARACTER_CONTENT_EXTENSIONS` in `cc5_api.py`) at `target`, else the selected character, else the first, and selects it.

### CC5 dialogs
| Tool | Description |
|--------|------|
| get_cc5_dialog | Show the open CC5 dialog (title, question, buttons) and the job waiting on it, and any recovery prompt the plugin answered |
| answer_cc5_dialog | Click a dialog button by label (refuses "Unsaved project data found" unless `CC5_RECOVERY_ANSWER` names that button); then `job_status` for the waiting command |

### Assets and export
| Tool | Description |
|--------|------|
| load_asset | Load an asset (.iAvatar, .ccAvatar, .ccm, etc.). Character content (.ccEye, .ccCloth, .ccShoes, ...) is applied to `target`, else the selected character, else the first |
| export_fbx | FBX export (reproduces CC5's "Export FBX" dialog). See "export_fbx details" below.|
| set_subdivision_level | HD subdivision level |
| capture_viewport | Viewport screenshot (returns the image to the LLM). The render size is only set when it changes: CC5 records `SetRenderExportParameter` as an undo step, so setting it on every capture made `undo` after a capture reverse the capture (F-53) |

### ActorMIXER PRO
| Tool | Description |
|--------|------|
| create_actor_mixer | Drives the native "Create Mixer Assets" dialog to generate a .ccMixerPreset. `confirm_create` is the safety gate (false = dry run that fills in the fields and then cancels / true = clicks Create). Requires the ActorMIXER PRO plugin |

### Editing
| Tool | Description |
|--------|------|
| undo | Undo the last operation |
| redo | Re-apply an undone operation |

## Development notes

- Build: `npm run build`
- Tests: `npm test` (449 tests) / `npm run test:coverage`
- Bridge authentication: every route except `/health` requires the `X-CC5-Token` header. The token is generated at `%LOCALAPPDATA%\CC5_MCP_Bridge\token` the first time the plugin starts (can be overridden with the environment variable `CC5_BRIDGE_TOKEN`). The MCP server sends it automatically
- Hot reload: `curl -H "X-CC5-Token: $(cat "$LOCALAPPDATA/CC5_MCP_Bridge/token")" http://127.0.0.1:5101/reload` (applies cc5_api.py changes immediately; requires `CC5_DEV_MODE=1`, returns 403 when disabled)
- API discovery: `curl -H "X-CC5-Token: $(cat "$LOCALAPPDATA/CC5_MCP_Bridge/token")" http://127.0.0.1:5101/api`
- CC5 restart: `taskkill` → `CharacterCreator.exe &` → the bridge starts automatically

## Environment variables

| Variable | Default | Description |
|------|-----------|------|
| CC5_BRIDGE_URL | http://127.0.0.1:5101 | Bridge endpoint URL |
| CC5_BRIDGE_PORT | 5101 | Bridge port (for start_bridge.py) |
| CC5_BRIDGE_TOKEN | (empty = use the token file) | Bridge authentication token (`X-CC5-Token`). Must be set to the same value in both the plugin and the MCP server |
| CC5_DEV_MODE | 0 | Dev mode (1/true/yes enables /reload and /exec/python) |
| CC5_ALLOW_EXEC | (empty) | 1/true/yes enables /exec/python even when dev mode is disabled |
| CC5_RECOVERY_ANSWER | (empty = ask) | cancel/ok: the plugin answers CC5's "Unsaved project data found" prompt with that button at startup and records it (get_cc5_dialog). Set by scripts/cc5-restart.ps1 (default cancel) |
| CC5_REQUEST_TIMEOUT_MS | 35000 | Request timeout (ms) |
| CC5_ROOT | (auto-detected) | CC5 install path |
