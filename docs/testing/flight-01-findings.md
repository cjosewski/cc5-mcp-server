# Flight 01 findings: live test of the MCP server against CC5 5.13

In-flight test of every MCP tool against a running Character Creator 5 (5.13), run by Chad from his runbook,
2026-10-04 to 2026-10-05. Step numbers (P2-11, P4-65) are the steps reported during the run.

Fix policy (agreed 2026-10-05): fix blockers at once; log everything else here and fix open bugs in one batch at
the end of a part, so each plugin change costs one reinstall and one CC5 restart.

**Severity:** blocker (a workflow cannot be done) · bug (wrong result or false report) · minor (works, but
inconsistent or awkward) · doc (description, docs or runbook wrong) · gap (missing capability).
**Status:** open · fixed (commit) · runbook (the runbook needs changing, not the code) · retest.

## Summary

| ID | Severity | Status | Finding |
|----|----------|--------|---------|
| F-01 | blocker | fixed (`499ea45`) | No way to select scene items; character presets need the character selected |
| F-02 | bug | fixed (`499ea45`) | `load_asset` reported success for a `.ccEye` that did nothing |
| F-03 | blocker | fixed (`499ea45`, `af5ddfb`) | A command that opens a CC5 dialog timed out blind and stalled every later command |
| F-04 | bug | fixed (`af5ddfb`) | Dialog lane never ran: it shared the command timer |
| F-05 | bug | fixed (`af5ddfb`) | `answer_cc5_dialog` reported clicks CC5 never received |
| F-06 | doc | fixed (`499ea45`) / runbook | Camera guidance said to create a second camera; CC5 cannot |
| F-07 | minor | fixed (`499ea45`) | `get_selection` showed an unknown object type as `0` |
| F-08 | bug | open | `get_diffuse_color` reads the base color (white), not the applied color |
| F-09 | bug | open | Undoing a diffuse color change is unreliable |
| F-10 | bug | open | `set_eye_color` has no visible effect and reports materials that do not exist |
| F-11 | bug | open | `reset_morphs` also zeroes a template's identity morphs |
| F-12 | doc | open | `adjust_morph` description points to a `get_morph_catalog` tool that does not exist |
| F-13 | minor | open | Morph and expression values come back as raw float32 (0.800000011920929) |
| F-14 | minor | open | Colors set from 0-1 are truncated to 0-255 steps (0.3 → 0.298), not rounded |
| F-15 | minor | open | `delete_avatar` on an empty scene is an error; a named delete then says "No avatars in scene" |
| F-16 | doc | open | `set_subdivision_level` refusal does not say to run Modify > Subdivide |
| F-17 | minor | open | `describe_character` says "average build" for templates and for heavy at 50% |
| F-18 | minor | open | `reset_expression` reports every slider (172), not the ones it changed |
| F-19 | gap | fixed (live P4-82) | `search_content` did not cover eye presets |
| F-20 | doc | runbook | `search_morphs` matches IDs too; several display names repeat with different IDs |
| F-21 | minor | open | Error wording differs across tools for the same situation |
| F-22 | minor | open | `capture_viewport` without a path always overwrites the same temp file |
| F-23 | doc | open | `check_cc5_connection` passes while a CC5 dialog blocks every command |
| F-24 | gap | open | Some changes cannot be read back: IBL image, item visibility, camera framing |
| F-25 | bug | retest | `get_camera_info` placed the camera at the side right after the home view |
| F-26 | minor | retest | The home view cropped Kevin's feet |
| F-27 | minor | open | `set_light_shadow` with no settings is only refused inside CC5 |
| F-28 | gap | open | Every second character preset stops on "Replace / Material Only"; batch runs need a preset answer |
| F-29 | doc | runbook | Runbook placeholders ("‹first jaw ID›") are ambiguous; give real IDs |
| F-30 | doc | runbook | Value checks need a tolerance (float32 and 0-255 storage) |
| F-31 | retest | open | Worn accessory selection (duplicate-name risk) untested: Kevin has no accessories |
| F-32 | minor | open | Claude Code showed a stale `load_asset` schema (no `target`) after restarts; the build is correct |
| F-33 | blocker | fixed (live P4-78 to P4-81) | Hair could not be loaded at all: every CC5 hairstyle is `.rlHair`, which `load_asset` refused |
| F-34 | gap | open (to become MCP protocol) | Presets override more than they are named for (lip makeup hid hair, brows, probably the Boxers and possibly the torso skin, reset skin); `load_asset` reports a clean load |
| F-35 | bug | not a bug (P4-102) | `get_material_properties` read-back: works on a clean character; the earlier 100 came from F-34 |
| F-36 | blocker | fixed (live P4-104 to P4-106) | Material setters sent 0-1 to CC5's 0-100 scale: opacity 1.0 = 1%, the skin vanished |
| F-37 | bug | not a bug (P4-107) | Opacity undo: works on a clean character; the earlier failure came from F-34 |
| F-38 | bug | open | `set_material_glossiness` / `set_material_specular` change nothing on Kevin's skin (read-back and viewport) |

## Details

### Fixed

**F-01: no selection; character presets need the character selected** (P4-19 to P4-24)
A `.ccEye` loaded with nothing selected did nothing; with Kevin selected by hand it applied. No MCP tool could
select. Fixed: `select_objects` / `get_selection` / `clear_selection` (`cc5_scene.py`, `selection.ts`), and
`load_asset` aims character content at `target`, else the selected character, else the first, and selects it.
Live: P4-25, P4-56 to P4-63 (several at once, add, unknown name, clear, props, not an undo step).

**F-02: `load_asset` ignored `LoadFile`'s result** (P4-21)
It returned success whatever CC5 did. Fixed: the status is checked for every load. Live: `.ccAvatar`, `.iProp`,
`.ccCam` and `.ccEye` loads still succeed (P4-38, P4-60, P4-63).

**F-03: a command that opens a CC5 dialog timed out blind** (P4-27)
A second `.ccEye` load asked "The target object layer already exists ... Replace / Material Only / Cancel"; the call
timed out after 35 s and every later command stalled. Fixed: the call returns within about 1 s with the question,
buttons and a job id; `get_cc5_dialog` / `answer_cc5_dialog`; jobs report waiting dialogs. Answering rule: Claude
answers plain confirmations, asks Chad on real choices, never answers "Unsaved project data found".
Live: P4-47 to P4-55.

**F-04: the dialog lane never ran** (P4-30, P4-31)
Qt never fires a timer again while its own callback runs; a command waiting in a dialog is that callback. Fixed:
the dialog lane has its own 50 ms timer (`main.py`, `server.process_dialog_lane`).

**F-05: `answer_cc5_dialog` clicks never reached CC5** (P4-35, P4-37, P4-45)
Deferred clicks (`QTimer.singleShot(0, callable)`, then a kept-alive `QTimer`, both behind `shiboken2.isValid`)
were reported as made but never arrived. A probe showed a direct `click()` on CC5's `QMessageBox` works. Fixed:
`answer_dialog` clicks directly.

**F-06: camera guidance** (P2-28 to P2-37)
The focal-length refusal and CLAUDE.md said "create a new camera in CC5"; CC5 has only the Preview Camera, whose
lens the API cannot change. Fixed: text now points to loading a `.ccCam` preset, which replaces the Preview Camera.
Runbook: the "set 85 mm on the new camera" step cannot pass; test the refusal instead.

**F-07: unknown object type shown as `0`** (P4-28)
Fixed: shown as "Other (type 0)".

### Open

**F-08: `get_diffuse_color` reads the base color** (P4-6, P4-10, P4-65) · bug
After `set_diffuse_color` (0.2, 0.4, 0.9) the torso is visibly blue, but the read-back is RGB(1, 1, 1). Cause
(likely): `set_diffuse_color` writes an animation key (`AddDiffuseKey`); `GetDiffuseColor(mesh, material)` has no
time argument and returns the material's base color. Fix needs an `exec_python` probe (CC5 started with
`CC5_ALLOW_EXEC=1`) to find a call that returns the keyed color. Until then, check color changes with a screenshot.

**F-09: undoing a diffuse color change is unreliable** (P4-12, P4-13) · bug
Of two undos, the first reverted the Boxers color and the second reported success with no visible effect (torso
stayed blue; morphs and facial profile unchanged). Workaround: set the color back explicitly (P4-15, P4-67).

**F-10: `set_eye_color`** (P4-16 to P4-18) · bug
No visible change on textured eyes (the iris is a texture; the tool's description warns of this). It also reported
applying to `CC_Base_Eye/Eye_R` and `Eye_L`, which do not exist (only `Std_Eye_R/L`, `Std_Cornea_R/L`): failed
`AddDiffuseKey` calls are only printed (`cc5_api.py` around lines 2245-2280). Fix: report only materials actually
changed; consider pointing to eye presets (`.ccEye` via `load_asset`), which do work.

**F-11: `reset_morphs` zeroes template identity morphs** (P3-28) · bug
On Kevin it reset 8 morphs including `cc4 kevin_body` and `cc4 kevin_head` (100% → 0), leaving Kevin's textures on
a neutral body. One `undo` restores them (P3-30). Fix: warn in the description, or offer "reset to template".

**F-12: `adjust_morph` description** (P3-5) · doc
Says "use get_morph_catalog first"; there is no such MCP tool. Should say `search_morphs`.

**F-13: raw float32 values** (P3-6, P3-10, P3-34) · minor
`get_morph_value` and `set_expression` return 0.800000011920929 for 0.8. Round for display, or document.

**F-14: 0-1 colors truncated to 0-255** (P2-56) · minor
`set_ambient` 0.3 / 0.1 stored as 76/255 = 0.298 and 25/255 = 0.098 (truncated, not rounded). Round to nearest.

**F-15: `delete_avatar` on an empty scene** (P2-2, P2-16) · minor
Errors instead of reporting nothing to delete, while `list_avatars` / `get_avatar_info` return a normal message.
A named delete on an empty scene says "No avatars in scene", not "Avatar not found: <name>".

**F-16: subdivision refusal** (P2-11) · doc
"Requested level 2 exceeds the mesh's max subdivision level 0" should add: run Modify > Subdivide in CC5 first.

**F-17: `describe_character`** (P3-1, P3-25) · minor
Built only from morph values: a template ("average build", 2 identity morphs) and heavy at 50% both read
"average build". Skin, eyes, hair and clothing are not described.

**F-18: `reset_expression` count** (P3-35) · minor
Reports 172 (all sliders) after only 2 were set. Report the number changed, or say "all".

**F-19: `search_content` misses eye presets** (P4-19) · gap · fixed with F-33; live: `search_content` "green" in `eye` found both green presets (P4-82)
"eye green" and "iris" found nothing; presets are in `Reallusion Templates/Actor/Eye/` (`.ccEye`). Fixed: an `eye`
category (`EContentRootFolder_Eye`) in `browse_content` and the `search_content` defaults.

**F-20: `search_morphs` IDs and duplicate names** (P3-2) · doc / runbook
The search matches IDs (`pack_jaw10` = "Neck Front Smooth"), and "Jaw Height", "Jaw Outer Define", "Jaw Scale"
("Jaw  Scale" with a double space) each appear twice with different IDs. Use IDs in scripts and the runbook.

**F-21: error wording** (P3-8, P3-38, P2-58, P2-13, P2-52) · minor
"Avatar not found", "Light not found", "Item not found", "Unknown morph ID", "File not found", "IBL image not
found". Unify on "<thing> not found: <name>".

**F-22: `capture_viewport` default path** (P2-23) · minor
Without a path it always writes `%TEMP%\cc5_viewport.png`, overwriting the last capture.

**F-23: `check_cc5_connection` and dialogs** (P1-6, P1-7) · doc
`/health` bypasses the command queue, so it reports "connected" while a dialog blocks every command. Say so in the
description, or add the open dialog (`/dialog`) to the check.

**F-24: changes that cannot be read back** (P2-21, P2-59, P2-61) · gap
`get_visual_settings` does not report the IBL image; no tool reads an item's visibility; `frame_camera` only
acknowledges. Only screenshots confirm these.

**F-25: camera position after the home view** (P2-27) · retest
`get_camera_info` reported (-677.6, 2.6, 87.8), a side position, right after `frame_camera("home")`; a later
home view framed correctly from the front (P2-66). Retest: home view, then `get_camera_info`.

**F-26: home view cropped the feet** (P2-66) · retest
With the 105 mm `.ccCam` lens loaded earlier, the home view cut Kevin off mid-shin. With the default 80 mm
viewport preset, the home view shows the feet (P4-66). Probably the lens; retest.

**F-27: `set_light_shadow` validation** (P2-51) · minor
The MCP schema makes both settings optional, so an empty call reaches CC5 before being refused. Validate in
TypeScript.

**F-28: presets stop on "Replace / Material Only"** (P4-27, P4-44, P4-52) · gap
Even on a freshly loaded Kevin, an eye preset asks. Interactive use is handled (F-03), but recipes and batch runs
will stop on it every time. Add a `load_asset` option (e.g. `if_layer_exists: "material" | "replace"`) that
answers this dialog by policy.

**F-29: runbook placeholders** (P3-7, P3-9, P3-12) · runbook
"‹first jaw ID›" / "‹second jaw ID›" were read two ways. Give literal IDs.

**F-30: value checks need a tolerance** (F-13, F-14) · runbook
Compare floats to about 0.004 (one 0-255 step) or round to 3 decimals.

**F-31: worn accessory selection** · retest
The reviewer's open question: whether a worn accessory resolves to one item or a duplicate name. Kevin has no
accessories; worn clothing (Boxers) resolved to one item. Retest on a character with an accessory.

**F-32: stale tool schema in Claude Code** · minor (environment). Seen again after the F-33 restart: `search_content`
still showed "Hair is not a searchable category" while the server searched hair. Call with explicit options.
After the MCP server restarts, the `load_asset` schema Claude Code showed had no `target` option, while
`build/tools/asset.js` has it and the server runs `build/index.js`. The dialog tools loaded fine. Check whether
Claude Code caches tool schemas across restarts.

**F-33: hair could not be loaded** (P4-77) · blocker · fixed
"Apply a short cropped hairstyle to Kevin": all 233 hairstyles under `Reallusion Templates/Hair` are `.rlHair`, and
`load_asset` refused them ("Disallowed file extension: .rlhair") before reaching CC5. `search_content` and
`browse_content` had no hair category. Fixed: `.rlHair` is character content in `load_asset` (TypeScript and
plugin), aimed at the target character; a `hair` category (`EContentRootFolder_Group`, the `Hair/Group` folder;
CC5 has no `EContentRootFolder_Hair`) lists `.rlHair` files; the create_character prompt no longer says hair is
not searchable. Live (P4-78 to P4-81): `search_content` "buzz cut" in `hair` found Buzz Cut and Afro Buzz Cut; `load_asset`
applied Buzz Cut to Kevin with no dialog (he had no hair); `list_hair` shows `Buzz_Cut`; a 4K face capture shows
the cut. `EContentRootFolder_Group` does resolve to `Hair/Group`.

**F-34: presets override more than they are named for** (P4-87 to P4-91) · gap
"Red Velvet" (`.ccSkinGenPreset`, lip makeup) made Kevin's lips red, but his Buzz Cut hair and eyebrows stopped
rendering (meshes still listed; `set_item_visible` did not bring them back) and the skin lost the `set_skin_color`
tone. Chad: a known CC5 complication; presets, especially Reallusion store content, override things you want to
keep. `load_asset` said only "Asset loaded". Fix ideas: capture and compare before/after around character presets
(hair, brows, skin, eyes, morph count) and report every change beyond the intended one, offering `undo`; at minimum,
say in `load_asset`'s description that presets can override other parts of the character.
Chad (2026-10-05): this must be baked into the MCP as protocol: every preset load checks before/after and
reports what else changed, not left to the agent's judgment.

**F-35: material property read-back** (P4-93 to P4-95) · bug
`set_material_opacity` 0.3 on `Std_Skin_Body` applied (the torso vanished in the viewport) but
`get_material_properties` still reported Opacity 100. Same pattern as F-08 (keyed value vs base value); fix together.
Also: 0.3 rendered as fully invisible, not 70% see-through; the viewport probably treats skin opacity as a cut-off.
Chad: a CC5 quirk; the control that makes a change happen is often buried in another feature (layered controls).
Find which layer decides partial transparency (material/shader mode) before treating this as an MCP bug.

**F-36: opacity scales differ** (P4-92 to P4-94) · minor
`set_material_opacity` takes 0.0-1.0; `get_material_properties` reports 0-100 (Opacity 100, Glossiness 20,
Specular 100). Use one scale (0-1, like the color tools) in both.

**F-37: opacity undo and a lagging read-back** (P4-96 to P4-98) · bug
Opacity read back: 100 before the set; 100 right after `set_material_opacity` 0.3 (torso already invisible); after one
`undo`, 0.30000001192092896 (0-1 scale, raw float) while the torso stayed invisible. So the undo did not revert the
opacity (what it reverted is unknown), and the getter returns values from different sources/steps. Same family as
F-08, F-09, F-35, F-36: material changes are made as keys, and neither undo nor the getters handle them reliably.
Workaround: set the value back explicitly and check the viewport.

**Correction to F-35 / F-37** (P4-99) · setting opacity back to 1.0 did not bring the torso back either. The
full body was never captured between the Red Velvet lip preset (P4-88) and the opacity change, and the first
full-body view after the preset already showed the torso and Boxers missing. So the missing torso may be a preset
side effect (F-34), not opacity; whether `set_material_opacity` and its undo work is unknown. Retest on a freshly
loaded Kevin: capture, opacity 0.3, capture, read back, opacity 1.0, capture, read back.

**Retest on a fresh Kevin (P4-100 to P4-103) resolves F-35 / F-36 / the Boxers.** Baseline read 100 / 20 / 100.
Opacity 0.3: torso vanished, Boxers stayed (so the missing Boxers were F-34), read back 0.30000001192092896.
Opacity 1.0: torso still invisible, read back 1. Cause (`cc5_api.py`): `set_material_opacity`, `set_material_glossiness`
and `set_material_specular` passed their 0-1 value straight to `AddOpacityKey` / `AddGlossinessKey` /
`AddSpecularKey`, but CC5 uses 0-100, so 1.0 meant 1%. Fixed: the setters scale to 0-100 and
`get_material_properties` reports 0-1 (rounded to 3 decimals). F-37 (opacity undo) still needs a retest.

**Live check after the F-36 fix (P4-104 to P4-108).** Baseline read 1 / 0.2 / 1. Opacity 0.3 read 0.3 and cut the
torso out (the skin shader treats low opacity as a cut-out, not a blend: a CC5 layered-controls behavior); opacity 1.0
restored it and read 1; opacity 0.3 then one `undo` restored it (F-37 not a bug).

**F-38: glossiness and specular do nothing on skin** (P4-108) · bug
`set_material_glossiness` 0.8 and `set_material_specular` 0.5 on `Std_Skin_Body` reported success, but
`get_material_properties` still read 0.2 / 1 and the viewport did not change. Likely cause: Kevin's skin uses the
Digital Human skin shader, whose shine comes from shader parameters (`set_shader_parameter`), so the legacy
material-level values are ignored or not stored. Fix: verify the value after setting and fail if it did not take;
say in both descriptions that Digital Human materials use `set_shader_parameter`. Confirm on a non-skin material.

## Ideas (not findings)

**I-01: a panel inside CC5** (Chad, 2026-10-05) · after the run
CC5's plugin API can add docked panels, menus and hotkeys (`RUi.CreateRDockWidget`, `RUi.AddMenu`,
`RUi.AddHotKey`, `RUi.GetMainWindow`), and the plugin already runs PySide2 inside CC5. Options, smallest first:
a bridge activity log panel (live view of MCP commands, waiting dialogs and jobs); a Python console panel (RLPy
commands on CC5's main thread; must obey the same `CC5_DEV_MODE` / `CC5_ALLOW_EXEC` switch as `exec_python`); a
shell panel (PowerShell/cmd through a pipe; not a real terminal, so full-screen programs such as Claude Code do not
render); a Claude chat panel (needs its own link to Claude; separate design). Decide the purpose first.
