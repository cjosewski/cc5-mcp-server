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

While CC5 shows a modal dialog, the 16 ms QTimer fires inside that dialog's nested event loop, so a command would run under the dialog: under the "Unsaved project data found" crash-recovery prompt that means before the user has decided whether the unsaved scene comes back, inside an event loop RLPy calls are not made for (CC5 crashes during FBX exports were traced to sessions that most likely had that prompt open). `process_command_queue` therefore leaves the next command queued while `_describe_modal()` reports a dialog, and after `MODAL_WAIT_SECONDS` (5 s) fails it with the dialog's title and text. The guard only runs while no MCP command runs, so no MCP command waits on that dialog: the error says it is probably the user's own or CC5's and to ask the user (`_modal_dialog_error`); a progress window reads "CC5 is busy" and a dialog whose text could not be read goes to the user too (C2 review). The actions in `MODAL_SAFE_ACTIONS` (the silent head-export steps, the export/mixer status reads and `exec_python`) still run. Who answers the recovery prompt is set when CC5 starts (Chad, 2026-10-05, flight 01 F-52: "Having Claude run this autonomously is part of the problem"): with `CC5_RECOVERY_ANSWER=cancel` (or `ok`) the dialog lane clicks that button as soon as the prompt appears (`_auto_answer_recovery`, only during the first `RECOVERY_WATCH_SECONDS`, only a prompt whose text was read), records it, and `get_cc5_dialog` reports it. `scripts/cc5-restart.ps1` (the launcher Claude uses) sets `cancel` by default (`-RecoveryAnswer ask|ok|cancel`). Unset, or any other value, is `ask`: the user answers it in CC5, as for a CC5 started by hand.

Every message that shows a dialog's text (the queue guard, the waiting error, `job_status`, `get_cc5_dialog`, `check_cc5_connection`) comes from `_describe_modal`, which replaces licence serials and keys in the title and the labels with `(serial)` (`_redact_secrets`; live, SkinGen's About box showed the licence serial). A serial in a label of its own is caught too (P-4): the label after one that is only a serial or licence label is replaced whole, and the joined text is redacted once more. A readable window with no buttons that is not a progress window (that About box) is no question: the queue guard names it by its title, else its first line, and says to close it in CC5, since no MCP tool can (F-85, Batch D; a server.py change, so it needs the reinstall and a CC5 restart; live check pending).

### Dialogs a command opens (dialog lane)

CC5 often asks before doing what a command asked: a plain confirmation, or a choice (live: a second `.ccEye` load asked "The target object layer already exists ... Replace / Material Only / Cancel"). The command then waits inside that dialog's nested event loop. On each nested timer tick `_note_command_dialog` records the dialog (title, label text, buttons) in `_command_dialogs`; after `DIALOG_REPORT_SECONDS` (1 s) the waiting HTTP call returns 409 `{state: "waiting_for_dialog", job_id, dialog}` and the command's result goes to `_jobs` (read it with `job_status`). `get_dialog`/`answer_dialog` (`DIALOG_ACTIONS`) run on a separate `dialog_queue`, even while a command runs: they touch only Qt widgets, never RLPy. The lane and the dialog watch run on **their own 50 ms QTimer** (`main._dialog_timer` → `server.process_dialog_lane`): Qt never re-fires a timer while its own callback is still running, so the 16 ms command timer is silent while a command it started waits in a dialog (live: with one timer, neither the report nor `get_cc5_dialog` ran). A job waiting on a dialog reports it through `/jobs/status` (`dialog`, `dialog_message`), so recipe steps and job tools stop and show the question instead of "still running". So does a job queued behind it (`blocked_by`: it has not started, and runs after the answer; C2b review: a recipe's later steps each waited 120 s and then said "still running"). A command's own progress window (a `QProgressDialog`, or a dialog whose only button is Cancel) is not treated as a question: `get_dialog` marks it `progress: true` (the tools then say "CC5 is busy"), and `answer_dialog` refuses to click its Cancel, because that aborts the running command (flight 01 F-56: an export's progress window was reported as a question). The bridge writes failed requests only (`BridgeHandler.log_message`) to `%LOCALAPPDATA%\CC5_MCP_Bridge\requests.log` (beside the token file; `requests.log.1` past 1 MB), never to stdout (F-57, F-63: prints from HTTP threads reached CC5's console and a running exec_python's output).

`answer_dialog` fails closed: it refuses the recovery prompt wherever its words sit (title or any label), except with the one button `CC5_RECOVERY_ANSWER` names, refuses a dialog whose text could not be read, and leaves plugin-driven dialogs (`_PLUGIN_DRIVEN_TITLES`, e.g. "Create Mixer Assets" during `create_actor_mixer`'s dry run) to their own tool. Its optional `expect` (words from the question) refuses a dialog that does not contain them, so an answer cannot land on the next dialog. The button is clicked directly, in the same call that found it (`_click_now`). Live (CC5 5.13, PySide2 5.15.0a1), two deferred clicks (`QTimer.singleShot(0, <python callable>)`, then a kept-alive single-shot `QTimer`, both behind `shiboken2.isValid`) were reported as made but never reached CC5's `QMessageBox`; a direct `click()` from a timer callback answered it at once. If a click opens another dialog, the dialog lane waits in that one until it is answered in CC5.

Answering rule (Chad, 2026-10-05): Claude answers a plain confirmation of exactly what the user asked for and says so; for a real choice it shows the question and buttons with a recommendation and lets the user pick. A question nobody has answered stops a recipe or batch, and Claude runs nothing else until it is answered (D1); Replace / Material Only has no standing answer: the user picks the first one in a build, and Claude answers later identical ones in that build (one character, or one batch call) with that choice and says so (D3). The rules the server sends at session start are in `src/prompts/content-rules.ts`.

Recipes and batches stop on questions (Chad, 2026-10-06). D1: a CC5 question nobody has answered stops `apply_character_recipe` and `batch_generate_patients`; nothing more is sent to CC5, and the report gives the question and the `continue_after` call. A question that may still be open stops them too (RB-1): `awaitJob` hands back the question the job's last poll reported when its wait runs out (`STILL_ASKING_NOTE` in src/jobs.ts: it may be a newer window), and `layerDialogHandler` stops when a carried answer's click failed and the dialog check (`checkDialog`) could not be made, instead of waiting blind. A step whose command waits in the question finishes after the answer (`continue_after` waits for its job); a step that could not run behind a dialog runs again on continuation. Where a run stopped lives in `src/build-session.ts`, in the MCP process: a restart forgets it, and the continuation is refused. D3: the first Replace / Material Only in a build goes to the user; their button, passed as `layer_answer` with `continue_after`, answers the identical question (`LAYER_EXPECT`) for the rest of that build only (one character in `create_character`, one batch call in `batch_generate_patients`; `layer_answer` itself covers one recipe call and its continuations, or the rest of one batch). A Cancel is not carried (`layer_answer` takes only Replace and Material Only): after a Cancel the run goes on with `continue_after` and no `layer_answer`, and the next identical question goes to the user again (RB-6; `CANCEL_NOT_CARRIED` in src/prompts/content-rules.ts). A recipe, a batch and `check_fit` do not start while CC5 shows a dialog or a progress window (`openDialog`: a 3 s check on the dialog lane; a failed check counts as none), and a continuation is refused the same way, except for the question its own stopped job waits in. A direct call queued behind a command that waits in a dialog never starts: after the bridge's 30 s it gets 504 `{state: "cancelled"}` "Timed out before CC5 started the command" (`dialogStopFromError`). With a window open at that moment it is a stop (the step never ran, the stop names the window, and `continue_after` runs it again; a recipe's base step as a whole); with none open it is an ordinary failure. Use `apply_character_recipe` for body and face; presets, hair and clothing go in one at a time with `load_asset`, each shown with captures and an undo offer (TS-9: `PRESET_RULE` and the `create_character` prompt ask for that, and in one recipe an undo of an early load would first take back the later steps).

### Hot reload (apply code changes immediately)

```
Edit cc5_api.py, cc5_changes.py or an extension module (cc5_pipeline.py, cc5_skin.py, cc5_builder.py,
cc5_scene.py: server.EXTENSION_MODULES) in the repo
  → copy it to the installed plugin: re-run install-plugin.ps1 (Administrator PowerShell; it copies every
    cc5-plugin/*.py, new modules included), or copy each changed or new .py into
    C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge\
    (CC5 runs that copy, not the repo; without this step /reload succeeds and changes nothing)
  → curl -H "X-CC5-Token: $(cat "$LOCALAPPDATA/CC5_MCP_Bridge/token")" http://127.0.0.1:5101/reload
    (or Claude runs it automatically; CC5 must have been started with CC5_DEV_MODE=1)
  → importlib.reload(cc5_api) and the extension modules runs; re-importing cc5_api drops cc5_changes (a helper
    load_asset imports, not an extension module) from sys.modules, so the next load imports it again
  → _auto_patch_server() updates ACTION_MAP / POST_ROUTES / GET_ROUTES
  → the new code takes effect immediately (no CC5 restart needed)
```

**Limitation:** changes to server.py (adding routes, changing validation, etc.) require re-running install-plugin.ps1 and restarting CC5.
Changes to cc5_api.py, cc5_changes.py and the extension modules take effect on reload, once the installed copy is updated.

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

**Mesh-only exports of a posed character (F-82, Batch D; live check pending).** `apply_pose` sets the character's motion clip, the project length and the end time to 0, and a mesh-only export (`export_motion` false, as `export_for_unity` without `include_current_pose`) then wrote a zero-length "Default" take that Unity warns about. `_one_frame_timeline_for_export` sets a timeline shorter than one frame (project length and end time) to one frame around both `ExportFbxFile` calls (the `RExportFbxSetting` path and the flags fallback) and restores it afterwards, with a note; a read or setter that fails becomes a WARNING note and the export still runs. A timeline it cannot set back gets a note starting with `TIMELINE_NOT_RESTORED_PREFIX` ("WARNING: CC5 timeline not restored: ", in cc5_api.py and src/tools/unity.ts; X-2): that FBX is right, so `export_for_unity`, `export_textures`, `job_status` and a batch never count it as an export setting CC5 did not apply, and show a line of their own instead: `TIMELINE_USABLE_LINE` ("The FBX is usable; ...") when nothing else went wrong, else `TIMELINE_LEFT_LINE` (a failed `export_for_unity` lists the note itself); a batch names the variants once. A timeline it could not lengthen says to re-export. An export with motion is left alone.

**An FBX export clears CC5's undo history (F-86, Batch D; live check pending).** Live, after an FBX export `undo` could not take back any earlier change and still reported success. A successful `export_fbx` result carries `undo_history_cleared: true`, and so does a failure once CC5's undo history may be gone: the F-82 guard changed the timeline (its setters clear it), or `ExportFbxFile` was called, whether it then raised or returned an error status (the cautious choice: a false warning costs a `save_character`, a missed one the user's work). `export_for_unity` and `export_textures` pass it on through `_check_export`, also when their export ran and a later check failed. `export_fbx`, `export_for_unity` and `export_textures` end their reply with `UNDO_HISTORY_CLEARED` (src/tools/unity.ts) after an export that ran; a failed `export_fbx` reaches the tool as HTTP 400 with only its error text, so the plugin's `export_fbx` action appends the same sentence there (`cc5_api.with_undo_history_sentence`; never inside `export_fbx` itself, or `export_for_unity` and `export_textures` would print it twice). A batch says it once, and the `undo` tool's description says so. Save first (`save_character`) to keep a way back.

### OBJ round trip (F-83, Batch D; live check pending)

CC5 reads an OBJ as the mesh in the character's current pose, and no OBJ export writes that pose. `export_obj` writes CC5's T-pose (arms horizontal; no `ResetToBindPose`) and says so in a note; with `y_up` false it writes a Z-up OBJ, and its note (`OBJ_Z_UP_NOTE`, not a WARNING: the axis was asked for) says that OBJ cannot come back. `replace_mesh_from_obj` (cc5_pipeline.py) reads only Y-up OBJs: its reference export is Y-up and `ReplaceMesh` has no axis option (P-9; the tool descriptions say so with `OBJ_Y_UP` in src/tools/pipeline.ts). In this order, and every refusal leaves the scene unchanged: the OBJ group named like the mesh (else its only group; `read_obj_groups` gives a group the vertices its faces use, so Blender's name-first layout and CC5's vertices-first layout read the same, P-2); the motion clips: a pose (a clip of at most one frame) is removed later, an animation refused (`_clips_to_remove`, `ANIMATION_REFUSED`; Chad's decision DEC-9 of 2026-10-06, kept in step with `REPLACE_MESH_ANIMATION_RULE` in src/tools/pipeline.ts); a T-pose reference export: the OBJ needs the mesh's vertex count, and at most 5% of its vertices may be more than 10 cm away. Past that, an OBJ that matches the reference turned Z-up (both signs are tried, `_z_up_match`) is refused as a Z-up OBJ, any other as another pose (an older `export_obj`'s bind-pose OBJ), axis or vertex order. Then one undo step deletes the pose clips, replaces the mesh and redraws; a T-pose export afterwards must have moved when the OBJ differs from the mesh by more than 0.01 cm (else "CC5 did not apply <file> to <mesh>": `ReplaceMesh` reported OK without applying it, P-3), and must match the OBJ within 0.5 cm; otherwise one undo takes the replace back and the call fails. The character then stands in the T-pose: `apply_pose` puts a pose back.

### Skin bake (F-84, Batch D; live check pending)

CC5 has no bake API. `bake_skin_textures` runs as a job and triggers an enabled CC5 command whose text or objectName names a skin bake, applying the skin or the skin editor (Bake before Apply before Skin Editor), never one that names about, manual, tutorial, help, online, remove or delete. CC5 5.13 has none (SkinGen's menu holds About, Online Manual, Video Tutorial and Remove SkinGen Data; the old keywords opened the About box), so it opens nothing and returns the manual steps and the skin-related commands it looked at.

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

Note: fallback 3 copies the CC5 window's area of the screen (the whole primary screen when CC5 has no main window), so the CC5 window must be in the foreground. It runs in the plugin (`_capture_window_screenshot`). Until the C2b review it never wrote a file: its path was passed after `-Command`, where PowerShell does not bind it; the path now travels in `CC5_CAP_OUT`. Live (C2 check, called directly): it wrote a 2575x1407 PNG of the window area; not yet reached through capture_viewport's own fallback chain. It starts PowerShell with `CREATE_NO_WINDOW` (F-64, Batch D), so no console window shows in the capture (live check pending).

### Change report (F-34)

Every character-content `load_asset` (`_CHARACTER_CONTENT_EXTENSIONS`), and so every preset or clothing step of a recipe or batch variant, is compared before and after; a base or scene-content load (.ccAvatar, .iProp, .ccCam) is not. `cc5_changes.py` reads the target character just before and just after `LoadFile`, in the same main-thread command. It only reads: no undo step of its own, no render, camera or selection call. It compares the worn items by group, the shaping morphs, the subdivision level and, per material on every mesh the character lists (`GetMeshNames(True)`, worn items' meshes included): presence, shader, diffuse colour, opacity, whether the Diffuse Blend channel holds an image, and the shader parameters (padding skipped). It never reads glossiness, specular or texture weights, which are stale until CC5 renders (F-65). Each read has 2.5 s; materials not read both times are reported as not compared, and at most 300 facts are returned. `src/change-report.ts` turns the facts into lines: CHECK is what changed besides what the load was for (an item removed or added in another group, a skin colour or pallor reset by a load that is not a skin preset, an overlay gone, lower opacity, a material gone, a shaping morph, the subdivision level, or a clothing, accessory or hair load that changed nothing); Applied is what it was for; NOT CHECKED is what it cannot see (the fit: check_fit; hidden hair or brows: captures), parts not compared and WARNING notes. In a recipe, a preset's skin-colour or pallor CHECK line that a later `skin_rgb` or `skin_condition` step sets again becomes a NOTE ("set again by ... later in this recipe"), only when the load went to the first character, which those steps change (`changes.target_is_first`; X-1: a load on another character keeps its CHECK lines and its step names that character). A batch variant left with CHECK lines is FAIL "exported, but check with the user" and keeps its FBX (Chad's DEC-4, option a, 2026-10-06). `CC5_CHANGE_CHECK=0` (or false, no, off) in CC5's environment switches the comparison off, and every load then says so; it is only for a person debugging: Claude and cc5-restart.ps1 never set it. An older plugin gives "the installed CC5 plugin predates the change report". Pictures judged by code are pending (F-34-phase2).

### Fit check (F-44)

`check_fit` (src/tools/fit.ts) frames the character and captures each view (default face, left, right, back, front; front is sent as `home`) at 1280x720 into `%TEMP%\cc5_fit\check_<time>`, keeping the newest 20 checks, and returns every image with its view, path and a reading rubric. It detects nothing by itself and never says a fit is clean. A capture that is not 1280x720 is the window-screenshot fallback, so the check stops INCOMPLETE there, as at any view it cannot frame or capture, and sends nothing more. Identical consecutive images are flagged. It is refused while a recipe or batch runs or a dialog is open. Each capture undoes its own step, and the camera stays on the last view. Fit corrections are pending (F-44-phase2).

### Skin overlays and skin conditions in Unity (F-75)

An FBX carries neither a Diffuse Blend overlay nor the skin shader's pallor offsets. `export_for_unity` exports a character that has them only with the user's `injuries` choice (`bake`, `separate` or `omit`; no default), and every reply lists what the FBX does not carry. It names each overlay's image from the bridge's own record (`cc5_pipeline.BLEND_SOURCES`, written by `load_texture` and `apply_skin_overlay`); `cc5_api.undo` and `redo` mark every record stale (`mark_blend_sources_stale`, P-1), and a stale record, or one at 0% while CC5 reads more, never overrides CC5's read and its image is neither shipped nor baked (a WARNING line asks to apply it again).
README.md, "Skin overlays and skin conditions in Unity", has the choices, the sidecar fields, the batch rules and the calibration status.

## Directory structure

```
cc5-mcp-server/
├── src/                        # MCP Server (TypeScript)
│   ├── index.ts                # Entry point: server instructions, tool/resource/prompt registration, stdio
│   ├── cc5-bridge.ts           # HTTP client for the CC5 bridge (token header, timeouts, error classes)
│   ├── types.ts                # Bridge result types
│   ├── util.ts                 # Shared helpers (bridgeCall, error results, WARNING notes, progress)
│   ├── auth.ts                 # Bridge token: CC5_BRIDGE_TOKEN or the token file
│   ├── jobs.ts                 # Bridge jobs: start, poll, CC5 questions while waiting
│   ├── recipe.ts               # Character recipe: schema, D2 step order, stops on CC5 questions
│   ├── build-session.ts        # Where a recipe or batch stopped (continue_after) and the layer answer (D1, D3)
│   ├── change-report.ts        # A load's before/after facts as CHECK / Applied / NOT CHECKED lines (F-34)
│   ├── scene-lock.ts           # One recipe, batch or fit check at a time
│   ├── image-info.ts           # Image sizes from file headers (Quest budget, check_fit captures)
│   ├── tools/                  # MCP tool definitions (24 files, 89 tools)
│   ├── prompts/
│   │   ├── create-character.ts # create_character prompt: stage by stage (I-06)
│   │   └── content-rules.ts    # Chad's protocol rules: the server instructions and tool description texts
│   └── resources/
│       └── morphs.ts           # Morph catalog and avatar state resources
├── cc5-plugin/                 # CC5 Python plugin
│   ├── main.py                 # Plugin entry point (initialize_plugin / uninitialize_plugin, the QTimers)
│   ├── server.py               # HTTP bridge: routes, command queue, dialog lane, jobs, request log
│   ├── cc5_api.py              # RLPy API wrapper (core actions + _auto_patch_server)
│   ├── cc5_changes.py          # Before/after load comparison (F-34); imported by cc5_api, not an extension module
│   ├── cc5_pipeline.py         # Extension: Unity export, mesh stats, poses, save, OBJ/GoZ/FBX round trips, textures
│   ├── cc5_skin.py             # Extension: skin overlays, skin conditions, wrinkles, injuries in a Unity export
│   ├── cc5_builder.py          # Extension: facial profiles, Headshot (switched off)
│   ├── cc5_scene.py            # Extension: selection, delete, move and scale
│   ├── config.json             # Plugin settings
│   └── config.xml              # Plugin settings (XML)
├── tests/                      # vitest suites; tests/py: Python plugin tests with fake RLPy
├── scripts/                    # cc5-restart.ps1, live_smoke_test.py, e2e/run_e2e.py
├── docs/                       # rlpy-api-reference.md, testing/flight-01-findings.md
├── start_bridge.py             # For manual startup (normally unnecessary — auto-start works)
├── install-plugin.ps1          # Plugin installer (administrator; copies every cc5-plugin/*.py)
├── claude-mcp-config.json      # MCP config for Claude Code
└── CLAUDE.md                   # This file
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

## Available MCP tools

The server registers 89 tools from 24 files in src/tools; the tables below list the main ones (README.md lists more, including the Exonicus tools).

### Scene management
| Tool | Description |
|--------|------|
| check_cc5_connection | Check the CC5 connection; also reports an open dialog (other commands do not run until it is answered: behind a dialog an MCP command is waiting on, a direct command waits the bridge's 30 s and is cancelled while a job stays queued, says so in `job_status` and runs after the answer; behind any other dialog the queue guard fails them after 5 s; a dialog no MCP command waits on may be the user's own, so the user is asked first), a progress window (CC5 busy), and a recovery prompt the plugin answered at startup. The dialog check waits at most 3 s; a refused check (e.g. a wrong token) shows CC5's error instead of "busy" |
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
| reset_morphs | Reset all morphs to zero. WARNING: also zeroes a template's identity morphs (CC4 Kevin's `cc4 kevin_body` / `cc4 kevin_head`), changing its face and body (F-11); prefer undo |
| apply_body_preset | Body preset (athletic/muscular/slim/heavy/average) |

### Content management (clothes, hair, accessories)
| Tool | Description |
|--------|------|
| list_clothes | List the clothes on the avatar by name and ID, "No clothes are applied.", or "No avatar in the scene." when the scene has no character (F-61; CC5's numeric type is not a garment kind and is not shown) |
| list_hair | List the hairstyles on the avatar; "No hair is applied.", or "No avatar in the scene." (F-61) |
| list_accessories | List the accessories on the avatar; "No accessories are applied.", or "No avatar in the scene." (F-61) |
| remove_scene_item | Remove clothes/hair/accessories by name |
| browse_content | Browse the CC5 content folders: cloth_upper (Shirts + Coats), cloth_lower (Pants + Skirts), cloth (Full-Body), underwear, gloves, cloth_other (socks, outfit sets), shoes, accessory_head (Accessory/Head), accessory_body (Torso + Arm + Leg), accessory_other, hair, eye, plus pose/motion/expression/props/light/camera/character, makeup, skingen and image libraries. A category may read several CC5 folders; `wrinkle_mask` lists the image files on disk when CC5's content listing returns none (CC5 5.13 lists none of its 14 PNGs). The user's own content from CC5's Custom tab (`Reallusion Custom`, read from disk; `Shared Custom` and `Shared Templates` when they hold content) is listed first, then CC5's templates (F-72). Finding nothing is not an error: the reply suggests search_content and the Reallusion store (I-02); the plugin's "No content folder resolved" is answered the same way, never as a file found |

### Camera, lights, expressions
| Tool | Description |
|--------|------|
| get_camera_info | Get camera position and focal length |
| set_camera_focal_length | Set the camera focal length |
| frame_camera | Move the camera to a preset viewpoint (face/front/home/all, etc.). CC5 frames the selected object, so the character (`target`, else the selected one, else the first) is selected for the move and the selection is put back; CC5's Home keeps the current direction, so `home` turns to Front first (F-45) |
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
| get_cc5_dialog | Show the open CC5 dialog (title, question, buttons) and the job waiting on it, or that CC5 is busy with a progress window, and any recovery prompt the plugin answered at startup. A recipe or batch stopped on the question goes on with `continue_after` after the answer |
| answer_cc5_dialog | Click a dialog button by label (refuses "Unsaved project data found" unless `CC5_RECOVERY_ANSWER` names that button, and a progress window's Cancel); then `job_status` for the waiting command. After a recipe or batch stopped on the question, go on with the `continue_after` call its report gives; for Replace / Material Only pass the user's button as `layer_answer` (after a Cancel, go on without it: a Cancel is not carried) |

### Assets and export
| Tool | Description |
|--------|------|
| load_asset | Load an asset (.iAvatar, .ccAvatar, .ccm, .rlHair, etc.). Character content (.ccEye, .ccCloth, .ccShoes, ...) is applied to `target`, else the selected character, else the first. Runs as a bridge job: a CC5 question (e.g. Replace / Material Only) comes back with the job id. Every character-content load is compared before and after (CHECK and NOT CHECKED lines; see "Change report"); `CC5_CHANGE_CHECK=0` in CC5's environment switches that off |
| export_fbx | FBX export (reproduces CC5's "Export FBX" dialog). See "export_fbx details" above; a successful export's reply ends with a line saying CC5 cleared its undo history (F-86), and so does the error of an export that failed once CC5 had been asked to write the FBX or had set the timeline to one frame for it |
| export_for_unity | FBX export with CC5's Unity preset into `<unity_dir>/<character_name>/`; unity_dir must be inside the Assets folder of an existing Unity project (ProjectSettings\ProjectVersion.txt beside Assets, F-76). Runs as a job and waits up to `wait_seconds` (default 120 s) before it returns a job id. `injuries` bake / separate / omit, no default (see "Skin overlays and skin conditions in Unity"); `remove_tearline_occlusion` |
| set_subdivision_level | HD subdivision level |
| capture_viewport | Viewport screenshot (returns the image to the LLM). CC5 records a capture as one undo step (`RenderImage`, a render-size change, or both together), so the capture undoes exactly that step right away; otherwise `undo` after a capture reversed the capture, not the change (F-53). Never more than one: a miscount must not undo the user's work. A render over 10 MB (e.g. 8K) is not sent back: the tool returns its path and the plugin's warning (F-58: a desktop screenshot used to overwrite it) |
| check_fit | Frames the character from several views (default face, left, right, back, front), captures each at 1280x720 and returns every image with a reading rubric; detects nothing by itself and never reports a fit as clean; refused while a recipe or batch runs or a CC5 dialog is open (see "Fit check") |

### ActorMIXER PRO
| Tool | Description |
|--------|------|
| create_actor_mixer | Drives the native "Create Mixer Assets" dialog to generate a .ccMixerPreset. `confirm_create` is the safety gate (false = dry run that fills in the fields and then cancels / true = clicks Create). Requires the ActorMIXER PRO plugin |

### Editing
| Tool | Description |
|--------|------|
| undo | Undo the last operation. An FBX export (export_fbx, export_for_unity, export_textures, a batch) clears CC5's undo history: nothing done before it can be undone, and undo still reports success (F-86) |
| redo | Re-apply an undone operation. Refused when a capture taken after the undo holds CC5's redo slot (the capture replaced CC5's redo history; F-55) |

## Development notes

- Build: `npm run build`
- Tests: `npm test` (vitest, 1,186 tests) / `npm run test:coverage`, and `npm run test:py` (Python plugin tests with a fake RLPy, 609 tests)
- MCP server instructions: SERVER_INSTRUCTIONS (src/prompts/content-rules.ts) is sent at initialize (src/index.ts); Claude Code shows it at session start and cuts it at about 2,000 characters, so keep it short; the same rule constants feed the tool descriptions.
- A new tool file is registered in src/index.ts, and the counts in README.md and CLAUDE.md are updated (tests/index-wiring.test.ts checks them).
- Bridge authentication: every route except `/health` requires the `X-CC5-Token` header. The token is generated at `%LOCALAPPDATA%\CC5_MCP_Bridge\token` the first time the plugin starts (can be overridden with the environment variable `CC5_BRIDGE_TOKEN`). The MCP server sends it automatically
- Hot reload: `curl -H "X-CC5-Token: $(cat "$LOCALAPPDATA/CC5_MCP_Bridge/token")" http://127.0.0.1:5101/reload` (re-imports the installed cc5_api.py, cc5_changes.py and extension modules; requires `CC5_DEV_MODE=1`, returns 403 when disabled)
- API discovery: `curl -H "X-CC5-Token: $(cat "$LOCALAPPDATA/CC5_MCP_Bridge/token")" http://127.0.0.1:5101/api`
- CC5 restart: ask the user to save and close CC5 (never kill it), then `scripts/cc5-restart.ps1` (see "Full CC5 restart procedure") → the bridge starts automatically

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
| CC5_CHANGE_CHECK | (empty = on) | 0/false/no/off switch off the before/after load comparison (F-34). Read by the plugin, so set it in CC5's environment before launch. Only for a person debugging: Claude and scripts/cc5-restart.ps1 never set it, and while it is set every load says the comparison is off |
