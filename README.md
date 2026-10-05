# CC5 MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.29-green.svg)](https://github.com/modelcontextprotocol/sdk)

An MCP (Model Context Protocol) server that lets LLMs like Claude control **Reallusion Character Creator 5** through natural language. Adjust facial features, apply body presets, capture viewport screenshots, load assets, and export FBX files -- all via conversational commands.

## Architecture

```
┌─────────────┐     stdio      ┌──────────────────┐    HTTP :5101    ┌──────────────────┐     RLPy     ┌─────┐
│  LLM Client │ ◄────────────► │  MCP Server      │ ◄──────────────► │  CC5 Plugin      │ ◄──────────► │ CC5 │
│  (Claude)   │                │  (Node.js / TS)  │                  │  (Python / Qt)   │              │     │
└─────────────┘                └──────────────────┘                  └──────────────────┘              └─────┘
```

The MCP server communicates with Claude via **stdio** transport and forwards commands over **HTTP** to a Python plugin running inside CC5. The plugin executes all RLPy API calls on the main thread via a QTimer-driven command queue, ensuring thread safety.

## Features

### MCP Tools (84)

The MCP server provides 84 tools across 23 modules for controlling CC5. The tables below cover the core tools; the Exonicus additions are listed under [New tools](#new-tools):

#### Scene & Avatar Management
| Tool | Description |
|------|-------------|
| `check_cc5_connection` | Verify CC5 is running and the bridge plugin is active |
| `list_avatars` | List all avatars in the current scene |
| `list_scene_objects` | List all scene objects (avatars, props, lights, cameras) |
| `get_avatar_info` | Get avatar details including all non-zero morph values |
| `create_avatar` | Create a new CC3+ base avatar in the scene |
| `describe_character` | Natural language description of current character appearance |

#### Morph Controls
| Tool | Description |
|------|-------------|
| `search_morphs` | Search morph catalog by keyword |
| `adjust_morph` | Adjust a single morph slider (-1.0 to 1.0) |
| `adjust_multiple_morphs` | Batch-adjust multiple morph sliders at once |
| `get_morph_value` | Query the current value of a morph slider |
| `reset_morphs` | Reset all morphs to zero |
| `apply_body_preset` | Apply a body type preset (athletic, muscular, slim, heavy, average) |

#### Content & Assets
| Tool | Description |
|------|-------------|
| `list_clothes` | List clothing on the current avatar |
| `list_hair` | List hair on the current avatar |
| `list_accessories` | List accessories on the current avatar |
| `remove_scene_item` | Remove clothing, hair, or accessories by name |
| `browse_content` | Browse CC5 content folders (clothes, shoes, etc.) |
| `load_asset` | Load a CC5 asset file (.iAvatar, .ccm, .iClothes, etc.); character content (.ccEye, .ccCloth, ...) goes to `target`, else the selected character, else the first |
| `export_fbx` | Export the current avatar as an FBX file. Mirrors the CC5 "Export FBX" dialog: `target_tool` preset, `export_motion` ("Mesh and Motion"), `sub_d_level` (HD subdivision), `embed_textures`, `fps`, `motion_range`, `texture_size` (`convert_image_format` is refused: CC5 5.13 crashes right after a scripted export with it). A bare filename exports into `D:\CC5Export` (override via `CC5_EXPORT_DIR`). |
| `create_actor_mixer` | Generate ActorMIXER PRO mixer assets (.ccMixerPreset) from the open avatar. `confirm_create` gates a dry-run (false, CANCELs) vs real creation (true). Requires the ActorMIXER PRO plugin. |

#### Materials & Colors
| Tool | Description |
|------|-------------|
| `get_material_info` | Get mesh and material names |
| `get_diffuse_color` | Get diffuse color of a material |
| `set_diffuse_color` | Set diffuse color (RGB, 0.0-1.0) |
| `set_eye_color` | Set eye color (convenience shortcut) |
| `set_hair_color` | Set hair color (convenience shortcut) |
| `set_lip_color` | Set lip color (convenience shortcut) |

#### Visibility & Display
| Tool | Description |
|------|-------------|
| `set_item_visible` | Show or hide scene items |

#### Selection
| Tool | Description |
|------|-------------|
| `select_objects` | Select scene items by name (characters, worn items, props, lights, cameras); replace or add to the selection |
| `get_selection` | List what is selected in CC5 |
| `clear_selection` | Deselect everything |

#### CC5 dialogs
| Tool | Description |
|------|-------------|
| `get_cc5_dialog` | Show the dialog CC5 has open (title, question, buttons) and the job waiting on it |
| `answer_cc5_dialog` | Click a dialog button by its label; the "Unsaved project data found" prompt only with the button `CC5_RECOVERY_ANSWER` names |

When a command opens a CC5 dialog (a confirmation, or a choice such as "Replace / Material Only / Cancel"), the call fails within about a second with the question, the buttons and a job id. The command keeps running: answer the dialog with `answer_cc5_dialog`, then read the command's result with `job_status`.

#### Camera & Lighting
| Tool | Description |
|------|-------------|
| `get_camera_info` | Get camera position and focal length |
| `set_camera_focal_length` | Set camera focal length |
| `get_lights` | List all lights in the scene |
| `set_light_color` | Set light color (RGB) |

#### Expression & Animation
| Tool | Description |
|------|-------------|
| `get_expression_info` | Get available expression groups and sliders |

#### Rendering & Export
| Tool | Description |
|------|-------------|
| `capture_viewport` | Capture a screenshot of the CC5 3D viewport |
| `set_subdivision_level` | Set HD subdivision level (0 = base, 1 = medium, 2 = HD) |

#### Edit & History
| Tool | Description |
|------|-------------|
| `undo` | Undo the last operation |
| `redo` | Redo an undone operation |

#### Advanced Features
| Tool | Description |
|------|-------------|
| `exec_python` | Execute Python/RLPy code in CC5 (needs `CC5_DEV_MODE=1` or `CC5_ALLOW_EXEC=1` on the bridge) |
| `metahuman_export` | Export to MetaHuman (when available) |

### MCP Resources

| Resource URI | Description |
|-------------|-------------|
| `cc5://morphs/catalog` | Complete catalog of all morph sliders grouped by category |
| `cc5://avatar/current` | Current avatar state with all active morph values |

## New tools

Exonicus additions for building Trauma Simulator patients and moving them between CC5, Unity, Blender, ZBrush and Substance Painter.

| Tool | Description |
|------|-------------|
| `job_status` | Check a long-running operation (export, import, batch) started earlier; returns its result when finished |
| `export_for_unity` | Export the current character as FBX with CC5's Unity preset into `<unity_dir>/<character_name>/` inside a Unity project's `Assets` folder. With `include_current_pose`, the pose is a one-frame animation clip in the FBX, and Unity shows the imported model in that pose with a Generic or Humanoid rig; for a Humanoid rig, copy the avatar from an unposed export of the same character (Copy From Other Avatar) |
| `check_quest_budget` | Check the current character against the Quest 3 per-character budget (triangles, materials, and, given an export folder, texture size and estimated GPU memory); see [Budget defaults](#budget-defaults) |
| `apply_pose` | Apply a pose or motion file (`.rlMotion`, `.rlPose`, `.iMotion`, `.iPose`, `.iMotionPlus`, `.ccPose`, `.ccMotion`) to the current character |
| `save_character` | Save the current character as a `.ccAvatar` file (the clean base for batch generation) |
| `export_obj` | Export the current character as OBJ for sculpting in ZBrush or Blender |
| `export_goz` | Export the current character as GoZ files for ZBrush |
| `import_fbx` | Import an FBX from Blender, Maya or another tool as a prop, or as clothing fitted to the current character (a garment must be skinned to the character's armature). Kind `character` is switched off (it crashed CC5) and fails at once: import a whole character by hand with File > Import in Character Creator 5. CC5 may stop on its own Import Settings dialog; the import waits until it is answered in CC5 |
| `list_meshes` | List the current character's mesh names (for `replace_mesh_from_obj` and `load_texture`) |
| `replace_mesh_from_obj` | Replace one of the character's meshes with an edited OBJ of the same topology |
| `load_texture` | Load an image into one texture channel of one material |
| `load_substance_textures` | Apply a Substance Painter texture export folder to the current character |
| `export_textures` | Export the character as FBX plus its texture images (in their source formats), the starting point for texturing in Substance Painter |
| `apply_skin_overlay` | Blend an image laid out on the CC skin UVs over the skin (bruising, abrasions, dirt, dried blood) |
| `remove_skin_overlay` | Remove skin overlays added with `apply_skin_overlay` |
| `set_skin_condition` | Move the skin toward a clinical appearance: pale (lighter and less saturated, through the Digital Human skin shader), cyanotic, flushed, jaundiced (colour tints), or back to normal |
| `set_wrinkle_strength` | Set facial wrinkle detail strength (0 = smooth, 1 = full) |
| `search_content` | Search installed CC5 content (clothing, shoes, characters, poses, makeup, skin layers, textures) by file-name keywords |
| `headshot_from_photo` | Switched off (it crashed CC5): fails at once and does nothing in CC5. Make a head from a photo by hand with the Headshot plugin inside Character Creator 5 |
| `load_facial_profile` | Load a facial profile file (expression set) onto the character |
| `apply_character_recipe` | Build or modify a character in one call from a recipe; every step is reported and a failed step does not stop the rest |
| `batch_generate_patients` | Generate many patient variants from one saved base character; each is exported to Unity, budget-checked, and recorded in `patients_manifest.json` |

| Prompt | Description |
|--------|-------------|
| `create_character` | Step-by-step workflow that builds a patient from a text description, checks the Quest budget and exports it to Unity |

## Prerequisites

- **Node.js** 18+ and npm
- **Reallusion Character Creator 5** (CC5)
- **Windows** (CC5 is Windows-only)

## Quick Start

### 1. Build the MCP Server

```bash
git clone <repo-url> cc5-mcp-server
cd cc5-mcp-server
npm install
npm run build
```

### 2. Install the CC5 Plugin

Run in an **Administrator PowerShell**:

```powershell
powershell -ExecutionPolicy Bypass -File install-plugin.ps1
```

This copies every `cc5-plugin/*.py` module plus `config.json` and `config.xml` from the script's own folder into CC5's `OpenPlugin\CC5_MCP_Bridge` directory, replacing any older install. Re-run it after changing the plugin. It also prints where the bridge writes its access token (`%LOCALAPPDATA%\CC5_MCP_Bridge\token`); the MCP server reads that file automatically.

Without administrator rights the script changes nothing and exits with "Open PowerShell with Run as administrator and run this again". If a delete or copy fails, or a file is missing afterwards, it prints `Install FAILED` and exits with code 1; only a complete install prints the green `Plugin installed to: ...` line. If CC5 is installed somewhere other than `C:\Program Files\Reallusion\Character Creator 5`, set `CC5_ROOT` to its folder first.

### 3. Configure Claude Code

Add to your `~/.claude.json` under `mcpServers`:

```json
{
  "cc5": {
    "command": "node",
    "args": ["<path-to-project>/build/index.js"],
    "env": {
      "CC5_BRIDGE_URL": "http://127.0.0.1:5101"
    }
  }
}
```

Replace `<path-to-project>` with the absolute path to this repository.

### 4. Start the Bridge

**Option A: Automatic (recommended)** -- Launch CC5. The plugin loads automatically from `OpenPlugin/CC5_MCP_Bridge/`. Enable it in Plugin Manager if needed.

**Option B: Manual** -- In CC5, go to Script > Load Python and select `start_bridge.py`.

### 5. Verify Connection

Ask Claude: *"Check if CC5 is connected"* -- it will call `check_cc5_connection` and report the status.

## Usage Examples

### Create and customize a character

> "Create a new avatar and make them athletic with a slightly larger nose"

Claude will call:
1. `create_avatar` -- adds a base avatar
2. `apply_body_preset` with `preset: "athletic"`
3. `adjust_morph` with `morph_id: "Nose_Size"`, `value: 0.6`

### Describe and adjust

> "What does my character look like? Make the jaw wider."

Claude will call:
1. `describe_character` -- reads current morph state
2. `adjust_morph` with `morph_id: "Jaw_Width"`, `value: 0.7`

### Batch modifications

> "Give the character a rounder face with softer features"

Claude will call `adjust_multiple_morphs` with an array of morph adjustments for cheeks, jaw, chin, etc.

### Export for game engine

> "Export this character as FBX to my project folder"

Claude will call `export_fbx` with the specified output path.

The tool reproduces the CC5 "Export FBX (InstaLOD)" dialog. The recommended Unreal (UE5 Skeleton) call is:

```jsonc
{
  "output_path": "character.fbx",   // bare filename -> D:\CC5Export\character.fbx
  "target_tool": "UE5",             // Target Tool Preset: Unreal (UE5 Skeleton)
  "export_motion": true,            // FBX Options: Mesh and Motion
  "sub_d_level": 0,                  // HD Character Subdivision Level: SubD 0
  "embed_textures": true,           // Texture Settings: Embed Textures = ON
  "fps": 30                          // Include Motion: Frame Rate = 30 (Current Animation = All)
}
```

Passing a bare filename (no directory component) exports into `D:\CC5Export` by default — override the folder with the `CC5_EXPORT_DIR` environment variable. Absolute paths are used as-is. Omitting `motion_range` keeps the dialog default "All".

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CC5_BRIDGE_URL` | `http://127.0.0.1:5101` | Full URL of the CC5 bridge HTTP server |
| `CC5_BRIDGE_PORT` | `5101` | Port for the bridge server (set in `cc5-plugin/main.py`) |
| `CC5_DEV_MODE` | `0` | Plugin development only: `1` enables hot-reload (`/reload`), `exec_python` and full `/api` discovery. Read by the bridge plugin. |
| `CC5_ALLOW_EXEC` | *(unset)* | `1` enables `exec_python` (`/exec/python`) without dev mode. Read by the bridge plugin. |
| `CC5_BRIDGE_TOKEN` | *(unset)* | Overrides the token file `$LOCALAPPDATA/CC5_MCP_Bridge/token`. Read by both the plugin and the MCP server, so set it in both environments. |
| `CC5_REQUEST_TIMEOUT_MS` | `35000` | HTTP request timeout in milliseconds (MCP server side); keep it above the bridge's 30 s command timeout |
| `CC5_ROOT` | `C:\Program Files\Reallusion\Character Creator 5` | CC5 installation path (used for default avatar loading) |
| `CC5_EXPORT_DIR` | `D:\CC5Export` | Default output folder for `export_fbx` when given a bare filename (no directory). Read by the bridge plugin. |

## Long batches

`batch_generate_patients` runs one recipe, export and budget check per variant, so one call can take many minutes. Claude Code (v2.1.203 and later) ends a call to a stdio MCP server that sends nothing back for 30 minutes: its MCP idle timeout. When Claude Code asks for progress updates, the batch sends one after every recipe step and variant, and each one restarts that timer. To be safe with long batches, add a `timeout` in milliseconds to the server's entry in your MCP configuration. It is a hard limit per tool call and also the shortest idle time Claude Code will wait, so `7200000` allows a two-hour batch:

```json
{
  "cc5": {
    "command": "node",
    "args": ["<path-to-project>/build/index.js"],
    "timeout": 7200000
  }
}
```

Or raise the idle window for one session (milliseconds; `0` turns the check off). In PowerShell:

```powershell
$env:CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = "7200000"; claude
```

In Git Bash: `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=7200000 claude`. Leave `MCP_TOOL_TIMEOUT` unset: unset, it already allows about 28 hours, and it does not change the idle timeout.

Cancelling the call (Esc, or Claude Code giving up) stops the batch before its next CC5 command. Finished variants stay in place, and `patients_manifest.json` says which variants never started. One `batch_generate_patients` or `apply_character_recipe` runs at a time; another is refused until it finishes, because both edit the same scene.

Long operations run as bridge jobs: `export_for_unity`, `export_goz`, `import_fbx`, `export_textures`, `apply_pose`, `save_character`, `replace_mesh_from_obj` and `load_substance_textures`. If one is still running when the tool stops waiting, it returns a job id to poll with `job_status`; do not start the same operation again. If CC5 restarts, an old job id is reported as not found and its result is lost.

## Budget defaults

`check_quest_budget` (and the per-variant check in `batch_generate_patients`) compares a character against these Quest 3 per-character limits. The environment variables (set on the MCP server) change the defaults for both tools; `check_quest_budget` also takes per-call overrides (`max_faces`, `max_materials`, `max_texture_px`, `max_texture_gpu_mb`):

| Environment Variable | Default | Limit |
|---------------------|---------|-------|
| `CC5_BUDGET_MAX_FACES` | `65000` | Triangles across the character's meshes, counted the way Unity counts them. CC5's own face count is polygons (its characters are quads, about 2 triangles each), so the check counts each face's corners. `max_faces` is the same triangle limit. |
| `CC5_BUDGET_MAX_MATERIALS` | `20` | Material slots |
| `CC5_BUDGET_MAX_TEXTURE_PX` | `2048` | Longest texture edge, in pixels |
| `CC5_BUDGET_MAX_TEXTURE_GPU_MB` | `66` | Estimated texture GPU memory on Quest, in MiB (ASTC 6x6 plus mips, after clamping to the px limit). File size on disk is reported but not limited. |

The defaults match the heaviest shipping Trauma Sim patient, `Patient_FemaleWhite`, measured 2026-10-02: 64,783 triangles, 20 materials, 2048 px largest texture edge, and an estimated 65.1 MiB of texture GPU memory.

The scene stats count the base mesh. An FBX exported with `sub_d_level` 1 or 2 holds about 4 or 16 times as many triangles when the character has HD data, so pass the same `sub_d_level` to `check_quest_budget`: the triangle line is then reported as NOT CHECKED instead of passing (a base-mesh fail still fails).

## Known issues (CC5 5.13)

Found in live testing on CC5 5.13.2030.1. None of them can be fixed from the bridge:

- **The first FBX export after CC5 starts often crashes CC5.** In testing, CC5 closed on about three in four sessions' first FBX export (`export_fbx`, `export_for_unity`, `export_textures`, a batch), whatever the settings, folder or call route. Once one FBX export had worked, every later FBX export in that session worked (22 of 22). Save your scene before the first export: the export tools and the `create_character` prompt tell the agent to call `save_character` first. If CC5 crashes, start it again, answer its "Unsaved project data found" question (OK restores your unsaved work), and run the export again. Started through `scripts/cc5-restart.ps1`, CC5 gets `CC5_RECOVERY_ANSWER=cancel` and the plugin answers that question Cancel by itself (pass `-RecoveryAnswer ok` to restore instead, or `ask` to answer it yourself).
- **`headshot_from_photo` is switched off.** It crashed CC5 in both Headshot modes with the test photo. The tool, and a recipe's `headshot_photo` step, now fail at once with a message and never call CC5. Make the head by hand with the Headshot plugin inside Character Creator 5.
- **`import_fbx` with kind `character` is switched off.** A whole-character import stopped in CC5's "Create Asset(s)" dialog and crashed CC5. It now fails at once with a message and never calls CC5. Import a whole character by hand with File > Import in Character Creator 5. Kinds `prop` and `clothing` still work.
- **`import_fbx` can wait for CC5's own import dialog** ("Import Settings" for the frame rate): answer it in CC5 and the import finishes.
- **Convert Image Format is refused**: every scripted export with it crashed CC5. Exported textures keep their source formats.
- **`bake_skin_textures` opens SkinGen's About box.** While it is open, other commands wait and then fail with its title; close it in CC5.

## Development

### Build

```bash
npm run build        # Compile TypeScript
npm run dev          # Watch mode (recompiles on change)
```

### Test

```bash
npm test             # Run tests
npm run test:watch   # Watch mode
npm run test:coverage # With coverage report
```

### Hot-Reload the Python Plugin

The bridge supports hot-reloading `cc5_api.py` and the extension modules without restarting CC5. It is only available in dev mode: start CC5 with `CC5_DEV_MODE=1` in its environment.

CC5 runs the installed copy of the plugin in `C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge\`, not the files in this repo, and `/reload` re-imports that copy. So after editing a module, first re-run `install-plugin.ps1` from an Administrator PowerShell (or copy the changed `.py` into that folder), then reload:

```bash
curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/reload
```

After reloading, the server's dispatch table is automatically patched with the updated functions. A change to `server.py` is not reloaded: re-run the installer and restart CC5.

### Project Structure

```
cc5-mcp-server/
├── src/                    # MCP Server (TypeScript)
│   ├── index.ts            # Entry point
│   ├── cc5-bridge.ts       # HTTP client for CC5 bridge
│   ├── types.ts            # Type definitions
│   ├── util.ts             # Shared utilities (bridgeCall wrapper)
│   ├── auth.ts             # Bridge token lookup (CC5_BRIDGE_TOKEN or the token file)
│   ├── jobs.ts             # Job polling helpers for long operations
│   ├── recipe.ts           # Character recipe engine
│   ├── image-info.ts       # Texture header scan for the Quest budget check
│   ├── tools/              # MCP tool definitions (23 files, 84 tools total)
│   │   ├── morph.ts        # Morph search, adjust, reset (5 tools)
│   │   ├── scene.ts        # Scene/avatar management (7 tools)
│   │   ├── asset.ts        # Asset loading / FBX export (2 tools)
│   │   ├── character.ts    # Body presets, character description (2 tools)
│   │   ├── content.ts      # Clothes, hair, accessories, browse (5 tools)
│   │   ├── color.ts        # Eye, hair, lip, skin color setters (4 tools)
│   │   ├── material.ts     # Material info, diffuse color, shader parameters (9 tools)
│   │   ├── camera.ts       # Camera info, focal length, framing (3 tools)
│   │   ├── light.ts        # Lights, ambient, IBL (9 tools)
│   │   ├── visibility.ts   # Show/hide items (2 tools)
│   │   ├── edit.ts         # Undo/redo (2 tools)
│   │   ├── expression.ts   # Expression info, set, reset (3 tools)
│   │   ├── scripting.ts    # Python/RLPy execution (1 tool)
│   │   ├── metahuman.ts    # MetaHuman export (2 tools)
│   │   ├── actor-mixer.ts  # ActorMIXER PRO mixer assets (1 tool)
│   │   ├── jobs.ts         # job_status (1 tool)
│   │   ├── unity.ts        # Unity export, Quest budget check (2 tools)
│   │   ├── pipeline.ts     # Poses, saving, Blender/ZBrush/Substance round-trips (10 tools)
│   │   ├── skin.ts         # Skin overlays, clinical skin condition, wrinkles (4 tools)
│   │   ├── builder.ts      # Content search, facial profile, recipes, Headshot (switched off) (4 tools)
│   │   ├── selection.ts    # Select scene items, read and clear the selection (3 tools)
│   │   ├── dialog.ts       # Read and answer CC5 dialogs (2 tools)
│   │   └── batch.ts        # Batch patient generation (1 tool)
│   ├── prompts/
│   │   └── create-character.ts # create_character prompt
│   └── resources/
│       └── morphs.ts       # Morph catalog & avatar state resources
├── cc5-plugin/             # CC5 Python plugin
│   ├── main.py             # Plugin entry (initialize_plugin / uninitialize_plugin)
│   ├── server.py           # HTTP bridge server (http.server)
│   ├── cc5_api.py          # RLPy API wrapper
│   ├── cc5_pipeline.py     # Extension: Unity export, mesh stats, poses, DCC round-trips
│   ├── cc5_skin.py         # Extension: skin overlays, condition tints, wrinkles
│   ├── cc5_builder.py      # Extension: facial profiles, Headshot (switched off)
│   ├── cc5_scene.py        # Extension: scene selection
│   └── config.json         # Plugin configuration
├── start_bridge.py         # Manual bridge startup script
├── install-plugin.ps1      # Plugin installer (requires admin)
└── claude-mcp-config.json  # Claude Code MCP config snippet
```

## API Reference

Every endpoint except `GET /health` needs the `X-CC5-Token` header (the contents of `$LOCALAPPDATA/CC5_MCP_Bridge/token`, or `CC5_BRIDGE_TOKEN`). Requests without it get `401`.

### GET Endpoints

| Endpoint | Description | Response |
|----------|-------------|----------|
| `GET /health` | Health check (no token needed) | `{"result": {"status": "ok", "service": "cc5-mcp-bridge", "version": "..."}}` |
| `GET /api` | API discovery (all endpoints and required params in dev mode; service and version only otherwise) | `{"result": {"service": "...", "endpoints": {...}}}` |
| `GET /reload` | Hot-reload `cc5_api` and the extension modules. Dev mode only, token required | `{"result": {"success": true}}` |
| `GET /avatars` | List all scene avatars | `{"result": [{"name": "...", "id": "...", "type": "..."}]}` |
| `GET /avatar/info` | Current avatar details + active morphs | `{"result": {"name": "...", "active_morphs": {...}}}` |
| `GET /morphs/catalog` | Full morph catalog grouped by category | `{"result": {"Category": [{"id": "...", "display_name": "..."}]}}` |

### POST Endpoints

| Endpoint | Parameters | Description |
|----------|-----------|-------------|
| `POST /morph/get` | `morph_id` | Get current morph value |
| `POST /morph/set` | `morph_id`, `value` | Set a morph slider (-1.0 to 1.0) |
| `POST /morphs/set` | `morphs` (array of `{id, value}`) | Set multiple morphs at once (-1.0 to 1.0 each) |
| `POST /avatar/create` | *(none)* | Create a default CC3+ avatar |
| `POST /asset/load` | `file_path`, `target` (optional) | Load a CC5 asset file; character content is applied to `target`, the selected character or the first |
| `POST /scene/select` | `names`, `add` (optional) | Select scene items by name |
| `POST /scene/selection` | *(none)* | List the selection |
| `POST /scene/selection/clear` | *(none)* | Clear the selection |
| `POST /dialog` | *(none)* | The open CC5 dialog and the job waiting on it (served even while a command waits in a dialog) |
| `POST /dialog/answer` | `button` | Click a dialog button by its label |
| `POST /export/fbx` | `output_path`, `options` (optional) | Export avatar as FBX |
| `POST /viewport/capture` | `output_path` (optional) | Capture viewport screenshot |
| `POST /subdivision` | `level` (0-2) | Set HD subdivision level |

POST requests must send `Content-Type: application/json`. All responses follow the envelope format: `{"result": ...}` on success, `{"error": "..."}` on failure.

## Security

- **Localhost only** -- The bridge server binds exclusively to `127.0.0.1`. The MCP server validates that `CC5_BRIDGE_URL` points to localhost before connecting.
- **Token file** -- On first start the plugin writes a random access token to `$LOCALAPPDATA/CC5_MCP_Bridge/token` and reuses it afterwards. The MCP server reads the same file and sends the token on every request. `CC5_BRIDGE_TOKEN` overrides the file on both sides.
- **Token authentication** -- Every endpoint except `GET /health` needs the `X-CC5-Token` header; `/reload` also needs `CC5_DEV_MODE=1`.
- **Host and Content-Type checks** -- The bridge rejects requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding from a browser), and POST requests that are not `Content-Type: application/json` (blocks cross-site form posts).
- **Dev mode off by default** -- `CC5_DEV_MODE` defaults to `0`. Set `CC5_DEV_MODE=1` only for plugin development: it enables `exec_python` (arbitrary code inside CC5), `/reload` and full `/api` discovery. `CC5_ALLOW_EXEC=1` also enables `exec_python` without dev mode.
- **Path validation** -- Both the TypeScript MCP server and the Python plugin validate file paths to prevent path traversal (`..`) attacks. Only allowed file extensions are accepted for asset loading and export.
- **Request size limits** -- The bridge enforces a 1 MB maximum request body size.
- **Thread safety** -- All RLPy API calls are serialized through a command queue and executed on CC5's main thread via QTimer.

## License

MIT
