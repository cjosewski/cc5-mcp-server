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

### MCP Tools (89)

The MCP server provides 89 tools across 24 modules for controlling CC5. The tables below cover the core tools; the Exonicus additions are listed under [New tools](#new-tools):

#### Scene & Avatar Management
| Tool | Description |
|------|-------------|
| `check_cc5_connection` | Verify CC5 is running and the bridge plugin is active, and report an open dialog or progress window that holds other commands |
| `list_avatars` | List all avatars in the current scene |
| `get_scene_objects` | List all scene objects (avatars, props, lights, cameras) |
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
| `list_clothes` | List the clothing (shoes and socks included) the current avatar wears, by name and ID; "No clothes are applied." when it wears none, "No avatar in the scene." when the scene has no character |
| `list_hair` | List the hair the current avatar wears; "No hair is applied.", or "No avatar in the scene." when the scene has no character |
| `list_accessories` | List the accessories the current avatar wears; "No accessories are applied.", or "No avatar in the scene." when the scene has no character |
| `remove_scene_item` | Remove clothing, hair, or accessories by name |
| `browse_content` | Browse CC5 content by category (clothing, shoes, accessories, hair, eye presets, poses, makeup, SkinGen, characters, image libraries). The user's own content from CC5's Custom tab (`Reallusion Custom`; `Shared Custom` and `Shared Templates` when they hold content) is listed first, then CC5's templates. Finding nothing (also when CC5 resolves no folder for the category) is not an error: the reply suggests `search_content` and the Reallusion store (the agent only suggests store items; the user decides and buys) |
| `load_asset` | Load a CC5 asset file (.iAvatar, .ccm, .iClothes, .rlHair, .ccSkinGenPreset, etc.); character content (.ccEye, .ccCloth, ...) goes to `target`, else the selected character, else the first. Runs as a bridge job: when CC5 asks a question (e.g. Replace / Material Only), the reply shows it with the job id. Every character-content load is compared before and after: CHECK lines name what changed besides what the load was for (an item removed or swapped, the skin colour reset, an overlay gone), NOT CHECKED lines what the comparison cannot see (the fit, hidden hair or brows). `CC5_CHANGE_CHECK=0` in CC5's environment switches the comparison off |
| `export_fbx` | Export the current avatar as an FBX file. Mirrors the CC5 "Export FBX" dialog: `target_tool` preset, `export_motion` ("Mesh and Motion"), `sub_d_level` (HD subdivision), `embed_textures`, `fps`, `motion_range`, `texture_size` (`convert_image_format` is refused: CC5 5.13 crashes right after a scripted export with it). A bare filename exports into `D:\CC5Export` (override via `CC5_EXPORT_DIR`). A mesh-only export (`export_motion` false) of a character whose timeline is 0 frames long (after `apply_pose`) runs with a one-frame timeline, restored afterwards, so the FBX's animation take is not empty; if CC5 cannot set the timeline back, the FBX is still right: the replies (also of `export_for_unity`, `export_textures`, `job_status` and a batch) say to set the timeline's length in Character Creator 5, and never count it as an export setting CC5 did not apply. CC5 clears its undo history with every FBX export; a successful export's reply ends with a line saying so, and so does the error of an export that failed once CC5 had been asked to write the FBX or had set the timeline to one frame for it |
| `create_actor_mixer` | Generate ActorMIXER PRO mixer assets (.ccMixerPreset) from the open avatar. `confirm_create` gates a dry-run (false, CANCELs) vs real creation (true). Requires the ActorMIXER PRO plugin. |

#### Materials & Colors
| Tool | Description |
|------|-------------|
| `get_material_info` | Get mesh and material names |
| `get_shader_parameters` | Get a material's Digital Human shader parameters (skin roughness, SSS, micronormal, ...), each a list of values. Entries that are not settings (CC5 returns no value for them, the shader's padding entries, or values CC5 could not read) are listed apart in a "Left out (not settings)" line |
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
| `get_cc5_dialog` | Show the dialog CC5 has open (title, question, buttons) and the job waiting on it, or that CC5 is busy with a command's progress window |
| `answer_cc5_dialog` | Click a dialog button by its label; the "Unsaved project data found" prompt only with the button `CC5_RECOVERY_ANSWER` names; a progress window's Cancel is refused (it would abort the running command). When a recipe or batch stopped on the question, go on with the `continue_after` call its report gives, with the user's button as `layer_answer` for Replace / Material Only (after a Cancel, without `layer_answer`: a Cancel is not carried) |

When a command opens a CC5 dialog (a confirmation, or a choice such as "Replace / Material Only / Cancel"), the call fails within about a second with the question, the buttons and a job id. The command keeps running: answer the dialog with `answer_cc5_dialog`, then read the command's result with `job_status`. A recipe (`apply_character_recipe`) or a batch (`batch_generate_patients`) that meets such a question stops there: nothing after it is sent to CC5, and its report gives the question and the call to go on with (`continue_after`). It stops the same way when a step's wait ends while CC5 still reports a question for that step (it may be a newer window), and when a carried answer's click failed and CC5 could not be checked for an open dialog: CC5 may still be asking. Replace / Material Only has no standing answer: the user answers the first one in a build (one character built with the `create_character` prompt, or one batch call), and later identical questions in that build are answered with that choice, never in another build. Passed as `layer_answer` with `continue_after`, the user's button answers them for the rest of that recipe call and its continuations, or for the rest of that batch. A Cancel is not carried: after a Cancel, go on with `continue_after` and no `layer_answer`, and the next identical question goes to the user again. A recipe, a batch and `check_fit` do not start while CC5 shows a dialog or a progress window: they refuse and send CC5 nothing.

Messages that show a dialog's text (a blocked or waiting command's error, `job_status`, `get_cc5_dialog`, `check_cc5_connection`) replace licence serials and keys with `(serial)`, also a serial shown in a label of its own beside its "Serial Number" label. A command blocked by a window with no buttons (live: SkinGen's About box) fails naming only the window's title and asks for it to be closed in Character Creator 5, since no MCP tool can close it. Both are plugin `server.py` changes: re-run `install-plugin.ps1` and restart CC5 to get them.

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
| `undo` | Undo the last operation (CC5 does not report an undo with nothing left to undo). An FBX export (`export_fbx`, `export_for_unity`, `export_textures`, a batch) clears CC5's undo history: nothing done before it can be undone, and undo still reports success |
| `redo` | Redo an undone operation; refused when a viewport capture taken after the undo replaced CC5's redo history |

#### Advanced Features
| Tool | Description |
|------|-------------|
| `exec_python` | Execute Python/RLPy code in CC5 (needs `CC5_DEV_MODE=1` or `CC5_ALLOW_EXEC=1` on the bridge) |
| `export_head_metahuman` | Mesh to MetaHuman head export (File > Export > Export Head); CC5 asks for the output path and gender |
| `bake_skin_textures` | Opens CC5's skin bake command (Bake / Apply Skin / Skin Editor) when CC5 has one; CC5 has no bake API, so the bake itself is done by hand. CC5 5.13 has no such command: the tool opens nothing and returns the manual steps and the skin-related commands it looked at (see Known issues). Runs as a bridge job |

### MCP Resources

| Resource URI | Description |
|-------------|-------------|
| `cc5://morphs/catalog` | Complete catalog of all morph sliders grouped by category |
| `cc5://avatar/current` | Current avatar state with all active morph values |

## New tools

Exonicus additions for building Trauma Simulator patients and moving them between CC5, Unity, Blender, ZBrush and Substance Painter.

| Tool | Description |
|------|-------------|
| `job_status` | Check a long-running operation (export, load, import, batch step) started earlier; returns its result when finished. A finished `load_asset` shows the same before/after lines as `load_asset` itself; a finished `export_for_unity` or `export_textures` with WARNING lines is an error (a CC5 timeline left at one frame after the export is not: it gets a line of its own); any other finished job with WARNING lines is labelled "Finished with warnings" |
| `export_for_unity` | Export the current character as FBX with CC5's Unity preset into `<unity_dir>/<character_name>/`. `unity_dir` must be inside the `Assets` folder of an existing Unity project (`ProjectSettings\ProjectVersion.txt` beside `Assets`); anywhere else the call is refused before anything is exported. Runs as a bridge job and waits up to `wait_seconds` (default 120, the maximum) before it returns a job id for `job_status`. An FBX carries no skin overlays or skin conditions: pass `injuries` (`bake`, `separate` or `omit`) as the user chose for this character. There is no default: a character that has them and no choice is not exported, and the reply lists them. The reply always lists what the FBX does not carry; see [Skin overlays and skin conditions in Unity](#skin-overlays-and-skin-conditions-in-unity). `remove_tearline_occlusion` leaves the tear line and eye occlusion meshes out (fewer materials; the eyes lose their wet edge and soft shadow). With `include_current_pose`, the pose is a one-frame animation clip in the FBX, and Unity shows the imported model in that pose with a Generic or Humanoid rig; for a Humanoid rig, copy the avatar from an unposed export of the same character (Copy From Other Avatar). Without it, a posed character is exported with a one-frame timeline (restored afterwards), so the FBX's animation take is not empty. The reply ends with a line saying that CC5 cleared its undo history |
| `check_quest_budget` | Check the current character against the Quest 3 per-character budget (triangles, materials, and, given an export folder, texture size and estimated GPU memory). Over the material limit, a hint names materials an export wrote several times with byte-identical textures and the count after merging them in Unity. `remove_tearline_occlusion` (pass what the export used) leaves the tear line and eye occlusion out of the counts; see [Budget defaults](#budget-defaults) |
| `apply_pose` | Apply a pose or motion file (`.rlMotion`, `.rlPose`, `.iMotion`, `.iPose`, `.iMotionPlus`, `.ccPose`, `.ccMotion`) to the current character |
| `save_character` | Save the current character as a `.ccAvatar` file (the clean base for batch generation). A `.ccAvatar` keeps neither the facial expression nor the pose. When the character has a facial expression, the reply lists the sliders the file did not keep, with the expression step that sets them again in a batch variant, and says the pose is not kept either; the pose itself is not read back |
| `export_obj` | Export the current character as OBJ in CC5's T-pose (arms horizontal), for sculpting in ZBrush or Blender; keep that pose while sculpting and bring the mesh back with `replace_mesh_from_obj`, which needs a Y-up OBJ (`y_up` true, the default, and the sculpt saved Y-up from the sculpting tool). With `y_up` false the OBJ is Z-up, for a tool that expects that, and the reply says it cannot come back |
| `export_goz` | Export the current character as GoZ files for ZBrush (pose `tpose` by default, which `replace_mesh_from_obj` needs). Whether ZBrush's GoZ T-pose matches CC5's is untested: `replace_mesh_from_obj` refuses a mismatch |
| `import_fbx` | Import an FBX from Blender, Maya or another tool as a prop, or as clothing fitted to the current character (a garment must be skinned to the character's armature). Kind `character` is switched off (it crashed CC5) and fails at once: import a whole character by hand with File > Import in Character Creator 5. CC5 may stop on its own Import Settings dialog; the import waits until it is answered in CC5 |
| `list_meshes` | List the current character's mesh names (for `replace_mesh_from_obj` and `load_texture`) |
| `replace_mesh_from_obj` | Replace one of the character's meshes with an edited OBJ from `export_obj` (same topology, in CC5's T-pose, Y-up: export with `y_up` true and save the sculpt Y-up from the sculpting tool). The OBJ's object or group named like the mesh is read by the vertices its faces use, so an OBJ that names each object before its vertices (Blender) reads like CC5's own. CC5 reads an OBJ in the character's current pose, so the tool first removes the character's pose (it then stands in a T-pose; `apply_pose` puts a pose back) and refuses a character with an animation (a motion clip longer than one frame), which would have to be deleted for good. It also refuses, changing nothing, an OBJ with another vertex count, in another pose (an OBJ from an older `export_obj` is in the bind pose) or with another vertex order, and a Z-up OBJ, which it names as such. After the replace it checks the mesh against the OBJ and undoes the replace when CC5 read it differently, or did not apply it at all ("CC5 did not apply ..."). Runs as a bridge job |
| `load_texture` | Load an image into one texture channel of one material. For `diffuse_blend` it also sets the layer's strength (`strength` 0-100, default 100): CC5 shows a Diffuse Blend image only above 0. A plugin installed before that fix sets no strength: the reply is then an error that asks to reinstall the plugin, without a percentage |
| `load_substance_textures` | Apply a Substance Painter texture export folder to the current character |
| `export_textures` | Export the character as FBX plus its texture images (in their source formats), the starting point for texturing in Substance Painter. Like `export_for_unity`, the reply ends with a line saying that CC5 cleared its undo history, also when a check failed after the export ran |
| `apply_skin_overlay` | Blend an image laid out on the CC skin UVs over the skin (bruising, abrasions, dirt, dried blood): PNG, JPG, JPEG, TGA, BMP, TIF or TIFF (BMP and TIFF not yet tested in CC5 5.13). The reply gives the strength CC5 reads back; CC5 reads a new strength only after it renders, so while its read still differs the reply says so (`capture_viewport` shows the overlay) |
| `remove_skin_overlay` | Remove skin overlays added with `apply_skin_overlay`, and set the layer's strength back to 0, so an image loaded there later does not show at the old strength. That reset runs on the region's skin materials without an image too: a call that removed no image but reset a strength says so, as one CC5 undo step. When CC5 refuses a material, the error still names what was removed and reset |
| `set_skin_condition` | Move the skin toward a clinical appearance: pale (lighter and less saturated, through the Digital Human skin shader), cyanotic, flushed, jaundiced (colour tints), or back to normal |
| `set_wrinkle_strength` | Set the strength of CC5's expression wrinkles (0 = none, 1 = full): the creases that show while an expression is active. It does not age a resting face (use morphs or a SkinGen preset for that), and CC5 cannot read the value back |
| `search_content` | Search installed CC5 content by file-name keywords (clothing, shoes, hairstyles, eye presets, accessories, characters, poses, makeup, skin layers, textures): CC5's templates and the user's own content from CC5's Custom tab (`Reallusion Custom`, listed first in each category). No match is not an error: the reply suggests other words, `browse_content` and the Reallusion store (the agent only suggests; the user decides and buys). A category CC5 could not search is named in the reply; when none could be searched (an unknown category, say), the reply is an error with CC5's own answer and no store hint |
| `headshot_from_photo` | Switched off (it crashed CC5): fails at once and does nothing in CC5. Make a head from a photo by hand with the Headshot plugin inside Character Creator 5 |
| `load_facial_profile` | Load a facial profile file (expression set) onto the character |
| `apply_character_recipe` | Build or modify a character in one call from a recipe. Use it for body and face; load presets, hair and clothing one at a time with `load_asset`, each shown with captures and an undo offer. Steps run in one fixed order: base, body preset, morphs, facial profile, skin, makeup and eye presets and hairstyles, skin colour, skin condition, textures, injury overlays, clothing, shoes, accessories and other assets, wrinkle strength, expression, pose. So the recipe's skin colour wins over a preset's, and a preset's skin-colour CHECK line that a later step sets again shows as a NOTE (only for a preset that went to the first character, the one those steps change; a load that went to another character says so). Every step is reported, content loads are compared before and after, and a failed step does not stop the rest. A CC5 question nobody has answered stops the recipe, also when a step's wait ends while CC5 still reports a question, or when a carried answer's click failed and CC5 could not be checked for an open dialog: nothing after it is sent to CC5, and the report gives the question and the `continue_after` call with the remaining recipe; after a Replace / Material Only question, `layer_answer` passes the user's button (after a Cancel, go on without it). An empty recipe, and a base file that does not exist, are refused before anything changes; a recipe does not start while CC5 shows a dialog |
| `batch_generate_patients` | Generate many patient variants from one saved base character; each is exported to Unity, budget-checked, and recorded in `patients_manifest.json`. The base file and the Unity project (`ProjectSettings\ProjectVersion.txt`) are checked before anything is sent to CC5. A CC5 question stops the batch, also one CC5 still reports when a step's wait ends: nothing more is sent to CC5, and `continue_after` finishes the stopped variant from where it stopped, then runs the variants not started (`layer_answer` for Replace / Material Only; none after a Cancel). A variant with an empty recipe needs `export_base_unchanged: true` (a control patient). `injuries` applies to the whole batch, and a variant's own `injuries` overrides it; a batch with an injured variant and no choice is refused before CC5 is touched. The manifest keeps the entries of earlier batches in the same folder; a variant run again replaces its own entry. The reply notes the variants with no expression step (exported with a neutral face), and a variant whose content loads changed more than they were for is a FAIL: exported, but check with the user |
| `check_fit` | Frames the character from several views (default face, left, right, back, front), captures each and returns every image with a reading rubric; it detects nothing by itself and never reports a fit as clean; refused while a recipe or batch runs or a CC5 dialog is open |

| Prompt | Description |
|--------|-------------|
| `create_character` | Stage-by-stage workflow (body and face, then details and hair, then clothing) with a pick list and a check at each stage; asks how injuries reach Unity, saves, exports and checks the Quest budget |

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
| `CC5_CHANGE_CHECK` | *(unset = on)* | `0`, `false`, `no` or `off` switch off the before/after comparison of character-content loads (`load_asset`, recipe and batch loads). Read by the bridge plugin, so set it in CC5's environment before launch. Only for a person debugging the plugin: Claude and `scripts/cc5-restart.ps1` never set it, and while it is set every load reports that the comparison is off. |

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

Cancelling the call (Esc, or Claude Code giving up) stops the batch before its next CC5 command. Finished variants stay in place, and `patients_manifest.json` says which variants never started. One `batch_generate_patients`, `apply_character_recipe` or `check_fit` runs at a time; another is refused until it finishes, because they use the same scene. A CC5 question nobody has answered stops the batch: nothing more is sent to CC5, the manifest says where it stopped, and a call with `continue_after` (the same settings, the stopped variant first and unchanged, then the variants not started) finishes that variant from where it stopped after the answer. `patients_manifest.json` keeps the entries of earlier batches in the same folder, and a variant run again replaces its own entry (an earlier FBX stays listed under `earlier_export` when the new run did not export it). If the manifest cannot be written (Unity or a scanner holding the file, a full disk), the reply says that it does not show this run, and a stop the batch made is kept, so `continue_after` still works.

Long operations run as bridge jobs: `load_asset`, `export_for_unity`, `export_goz`, `import_fbx`, `export_textures`, `apply_pose`, `save_character`, `replace_mesh_from_obj`, `load_substance_textures` and `bake_skin_textures`. If one is still running when the tool stops waiting, it returns a job id to poll with `job_status`; do not start the same operation again. If CC5 restarts, an old job id is reported as not found and its result is lost.

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

The material limit counts material slots. When a character is over it, `check_quest_budget` looks in the export folder for materials the export wrote several times with byte-identical textures (CC5 names the copies' textures `<material>_<channel>_0001`, `_0002`, ...; live, the US Army uniform's shirt, pants and boots) and adds a hint per material with the count after merging its copies in Unity, and the count with all of them merged. The copies' CC5 settings can differ (e.g. glossiness), so check the look after a merge.

`remove_tearline_occlusion: true` leaves the tear line and eye occlusion meshes out of the FBX (CC5's RemoveTearLineAndOcclusion): fewer materials, but the eyes lose their wet edge and soft shadow. Pass the flag to `export_for_unity` and the same value to `check_quest_budget`, which then leaves those meshes out of its counts. Without the flag, an over-budget check whose scene has them suggests it. `batch_generate_patients` has no such flag.

## Skin overlays and skin conditions in Unity

An FBX carries neither a Diffuse Blend image (`apply_skin_overlay`, or `load_texture` into `diffuse_blend` on any material) nor the Digital Human skin shader's pallor offsets (`set_skin_condition` `pale`), and CC5's FBX export has no option that bakes Diffuse Blend. So `export_for_unity` checks the character before it exports: every material of every mesh (worn items too) for a Diffuse Blend image, and the skin materials for pallor offsets and a skin colour. With an overlay or pallor and no `injuries` choice it exports nothing and lists what it found ("Not exported: ..."). Its reply always lists what the FBX does not carry. The choice is made per character and per export; there is no default:

- `bake`: burned into this export's `<material>_Diffuse` images (pallor as desaturate and brighten, then the overlay blended with Multiply at its strength). Unity shows them with no extra setup, and they cannot be turned off there. Each bake checks its painted pixels against the formula. A material it cannot bake surely keeps its file as CC5 wrote it, with a WARNING line: no single diffuse image for its name, a diffuse image with an alpha channel (a bake would fill its transparent parts: use `separate` for that character), an overlay of unknown strength or an image that cannot be read or is not known (see below), a Brightness below 0 or a Saturation above 0, or painted pixels that differ from the formula. For an overlay of unknown strength, run `capture_viewport` and export again.
- `separate`: the textures stay as CC5 wrote them. Each overlay image goes to `<character_name>/Injuries/<Material>_DiffuseBlend.<ext>`, and `<character_name>_injuries.json` beside the FBX holds the values a Unity material needs to blend them.
- `omit`: exported without them; the Unity patient has no injuries or skin condition.

Every export removes the injuries files an earlier export left in its folder (the sidecar and the images it lists), so a Unity material never blends an old overlay over a new export. `separate` first writes its own over the earlier files of the same names, so those keep their Unity `.meta` files (GUIDs and import settings), and then removes only the earlier files it did not write again. The overlay images an export names are the ones this bridge last loaded (`apply_skin_overlay`, `load_texture`): a change made in CC5 itself is not seen. After an `undo` or `redo`, or when CC5 shows an overlay the bridge last set to 0%, which image CC5 shows is not known: the export counts that overlay at the strength CC5 reads, and `separate` and `bake` leave it out with a WARNING line (apply it again, then export again).

`<character_name>_injuries.json` (format 1):

| Field | Content |
|-------|---------|
| `format` | `1` |
| `character`, `fbx` | The character name and `<character_name>.fbx` |
| `created` | When it was written (local time, ISO 8601) |
| `blend` | How the overlays blend over the diffuse: `Multiply` |
| `overlays` | One entry per material with an overlay: `mesh`, `material`, `image` (path relative to the character folder), `strength` (0-1, or `null` when it is unknown), `diffuse` (that material's diffuse image in this export, or `null`) |
| `pallor` | One entry per skin material with pallor offsets: `mesh`, `material`, `brightness`, `saturation` |
| `tints` | One entry per skin material whose diffuse colour is not white: `mesh`, `material`, `rgb` (0-1) |

Calibration: the bake formula has not been fitted to CC5's look yet, so a reply that baked anything says to compare the Unity result with a CC5 capture, and the injuries question says so for `bake`. A skin colour (`set_skin_color`, or the cyanotic, flushed and jaundiced conditions) is written into the FBX as the material colour; whether Unity shows it has not been checked, so it is reported as "Not verified to reach Unity" on every export, never baked, and never stops an export.

Batches: `batch_generate_patients` takes `injuries` for the whole batch, and a variant's own `injuries` overrides it. A batch with a variant that adds an overlay, a `diffuse_blend` texture or a pale skin condition, and no choice for it, is refused before CC5 is touched. A variant whose export still finds overlays or pallor without a choice (from the saved base) stops the batch there, and the reply asks for the choice. The manifest's `injuries` lines say what each variant's export did.

A bake or a copy that fails keeps the export and shows as WARNING lines ("WARNING: injuries not carried: ..."): the reply is an error that names what the Unity patient is missing, `job_status` treats such a finished export as an error, and a batch marks the variant FAIL.

## Known issues (CC5 5.13)

Found in live testing on CC5 5.13.2030.1. None of them can be fixed from the bridge:

- **The first FBX export after CC5 starts often crashes CC5.** In testing, CC5 closed on about three in four sessions' first FBX export (`export_fbx`, `export_for_unity`, `export_textures`, a batch), whatever the settings, folder or call route. Once one FBX export had worked, every later FBX export in that session worked (22 of 22). Save your scene before the first export: the export tools and the `create_character` prompt tell the agent to call `save_character` first. If CC5 crashes, start it again, answer its "Unsaved project data found" question (OK restores your unsaved work), and run the export again. Started through `scripts/cc5-restart.ps1`, CC5 gets `CC5_RECOVERY_ANSWER=cancel` and the plugin answers that question Cancel by itself (pass `-RecoveryAnswer ok` to restore instead, or `ask` to answer it yourself).
- **`headshot_from_photo` is switched off.** It crashed CC5 in both Headshot modes with the test photo. The tool, and a recipe's `headshot_photo` step, now fail at once with a message and never call CC5. Make the head by hand with the Headshot plugin inside Character Creator 5.
- **`import_fbx` with kind `character` is switched off.** A whole-character import stopped in CC5's "Create Asset(s)" dialog and crashed CC5. It now fails at once with a message and never calls CC5. Import a whole character by hand with File > Import in Character Creator 5. Kinds `prop` and `clothing` still work.
- **`import_fbx` can wait for CC5's own import dialog** ("Import Settings" for the frame rate): answer it in CC5 and the import finishes.
- **Convert Image Format is refused**: every scripted export with it crashed CC5. Exported textures keep their source formats.
- **CC5 has no skin bake command the plugin can run.** CC5 has no bake API, and CC5 5.13's menus hold no Bake, Apply Skin or Skin Editor command (SkinGen's menu holds About, Online Manual, Video Tutorial and Remove SkinGen Data). So `bake_skin_textures` opens nothing and returns the manual steps (bake the skin by hand in SkinGen) and the skin-related commands it looked at.
- **An FBX export clears CC5's undo history.** After `export_fbx`, `export_for_unity`, `export_textures` or a batch export, nothing done before the export can be undone, and `undo` still says it succeeded. `export_fbx`, `export_for_unity` and `export_textures` end their reply with a line that says so after an export that ran, also when a check failed after it (`export_for_unity`, `export_textures`) or when the export failed once CC5 had been asked to write the FBX or had set a posed character's timeline to one frame for it; a failed `export_fbx` carries that line in its error text. A batch says it once. Save first (`save_character`) to keep a way back.
- **An FBX carries no skin overlays or skin conditions.** `export_for_unity` asks how they should reach Unity (`bake`, `separate` or `omit`); see [Skin overlays and skin conditions in Unity](#skin-overlays-and-skin-conditions-in-unity).

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

The bridge supports hot-reloading `cc5_api.py`, the extension modules (`cc5_pipeline.py`, `cc5_skin.py`, `cc5_builder.py`, `cc5_scene.py`) and `cc5_changes.py` without restarting CC5. It is only available in dev mode: start CC5 with `CC5_DEV_MODE=1` in its environment.

CC5 runs the installed copy of the plugin in `C:\Program Files\Reallusion\Character Creator 5\Bin64\OpenPlugin\CC5_MCP_Bridge\`, not the files in this repo, and `/reload` re-imports that copy. `/reload` also re-imports `cc5_changes.py` through `cc5_api`: re-importing `cc5_api` drops it from Python's module cache, so the next load reads the installed file again. So after editing a module, first re-run `install-plugin.ps1` from an Administrator PowerShell (it copies every `cc5-plugin/*.py`, new modules included), or copy each changed or new `.py` (such as `cc5_changes.py`) into that folder, then reload:

```bash
curl -H "X-CC5-Token: $(cat $LOCALAPPDATA/CC5_MCP_Bridge/token)" http://127.0.0.1:5101/reload
```

After reloading, the server's dispatch table is automatically patched with the updated functions. A change to `server.py` is not reloaded: re-run the installer and restart CC5.

### Project Structure

```
cc5-mcp-server/
├── src/                    # MCP Server (TypeScript)
│   ├── index.ts            # Entry point: server instructions, tool, resource and prompt registration
│   ├── cc5-bridge.ts       # HTTP client for CC5 bridge
│   ├── types.ts            # Type definitions
│   ├── util.ts             # Shared utilities (bridgeCall wrapper)
│   ├── auth.ts             # Bridge token lookup (CC5_BRIDGE_TOKEN or the token file)
│   ├── jobs.ts             # Job polling helpers for long operations
│   ├── recipe.ts           # Character recipe engine
│   ├── build-session.ts    # Where a recipe or batch stopped on a CC5 question (continue_after) and the layer answer
│   ├── change-report.ts    # Turns a load's before/after facts into CHECK and NOT CHECKED lines
│   ├── scene-lock.ts       # One recipe, batch or fit check at a time
│   ├── image-info.ts       # Image sizes from file headers (Quest budget check, check_fit captures)
│   ├── tools/              # MCP tool definitions (24 files, 89 tools total)
│   │   ├── morph.ts        # Morph search, adjust, reset (5 tools)
│   │   ├── scene.ts        # Scene/avatar management (7 tools)
│   │   ├── asset.ts        # Asset loading / FBX export (2 tools)
│   │   ├── character.ts    # Body presets, character description (2 tools)
│   │   ├── content.ts      # Clothes, hair, accessories, browse (5 tools)
│   │   ├── color.ts        # Eye, hair, lip, skin color setters (4 tools)
│   │   ├── material.ts     # Material info, diffuse color, shader parameters (9 tools)
│   │   ├── camera.ts       # Camera info, focal length, framing (3 tools)
│   │   ├── fit.ts          # check_fit: multi-view fit captures (1 tool)
│   │   ├── light.ts        # Lights, ambient, IBL (9 tools)
│   │   ├── visibility.ts   # Show/hide items (2 tools)
│   │   ├── edit.ts         # Undo/redo (2 tools)
│   │   ├── expression.ts   # Expression info, set, reset (3 tools)
│   │   ├── scripting.ts    # Python/RLPy execution (1 tool)
│   │   ├── metahuman.ts    # MetaHuman head export, skin bake (2 tools)
│   │   ├── actor-mixer.ts  # ActorMIXER PRO mixer assets (1 tool)
│   │   ├── jobs.ts         # job_status (1 tool)
│   │   ├── unity.ts        # Unity export, Quest budget check (2 tools)
│   │   ├── pipeline.ts     # Poses, saving, Blender/ZBrush/Substance round-trips (10 tools)
│   │   ├── skin.ts         # Skin overlays, clinical skin condition, wrinkles, skin shader (5 tools)
│   │   ├── builder.ts      # Content search, facial profile, recipes, Headshot (switched off) (4 tools)
│   │   ├── selection.ts    # Select, delete, move and scale scene items (6 tools)
│   │   ├── dialog.ts       # Read and answer CC5 dialogs (2 tools)
│   │   └── batch.ts        # Batch patient generation (1 tool)
│   ├── prompts/
│   │   ├── create-character.ts # create_character prompt (stage by stage)
│   │   └── content-rules.ts    # Chad's protocol rules: MCP server instructions and tool description texts
│   └── resources/
│       └── morphs.ts       # Morph catalog & avatar state resources
├── cc5-plugin/             # CC5 Python plugin
│   ├── main.py             # Plugin entry (initialize_plugin / uninitialize_plugin)
│   ├── server.py           # HTTP bridge server (http.server)
│   ├── cc5_api.py          # RLPy API wrapper
│   ├── cc5_changes.py      # Before/after load comparison, F-34; imported by cc5_api, not an extension module
│   ├── cc5_pipeline.py     # Extension: Unity export, mesh stats, poses, DCC round-trips
│   ├── cc5_skin.py         # Extension: skin overlays, condition tints, wrinkles, injuries in a Unity export
│   ├── cc5_builder.py      # Extension: facial profiles, Headshot (switched off)
│   ├── cc5_scene.py        # Extension: scene selection, delete, move and scale
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
