/**
 * Pipeline tools: poses, saving, and DCC round-trips (Blender, Substance Painter, ZBrush).
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, bridgeErrorResult, errorResult, warningNotes } from "../util.js";
import {
  isLocalAbsolute, TIMELINE_LEFT_LINE, TIMELINE_NOT_RESTORED_PREFIX, TIMELINE_USABLE_LINE, withUndoHistoryLine,
} from "./unity.js";
import { runJob, runJobTool, pendingResult, type JobResult } from "../jobs.js";

/** Local absolute path (no '..', no UNC/network or device path), extension in the allowed set. Returns an error message or null. */
export function checkFile(filePath: string, allowed: string[]): string | null {
  if (filePath.includes("..")) return "Path traversal ('..') is not allowed";
  if (!isLocalAbsolute(filePath)) return `Path must be a local absolute path (no network/UNC or device paths): ${filePath}`;
  const ext = path.extname(filePath).toLowerCase();
  if (!allowed.includes(ext)) return `Unsupported file type ${ext || "(none)"}. Allowed: ${allowed.join(", ")}`;
  return null;
}

// Keep in sync with POSE_EXTENSIONS in cc5-plugin/cc5_pipeline.py.
export const POSE_EXTENSIONS = [".rlmotion", ".imotion", ".rlpose", ".ipose", ".imotionplus", ".ccpose", ".ccmotion"];

// Keep in sync with TEXTURE_CHANNELS and IMAGE_EXTENSIONS in cc5-plugin/cc5_pipeline.py.
export const TEXTURE_CHANNELS = ["diffuse", "normal", "roughness", "metallic", "ao", "opacity",
  "displacement", "specular", "glow", "bump", "diffuse_blend"] as const;
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff"];

/** "A, B or C". */
function inWords(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names.join("");
}

// F-68: the image types in words, from IMAGE_EXTENSIONS ("PNG, JPG, JPEG, TGA, BMP, TIF or TIFF"). If BMP or TIFF fail
// to load live, drop them from IMAGE_EXTENSIONS here and in cc5_pipeline.py together (load_texture and
// apply_skin_overlay both hand the file to LoadImageToTexture); never narrow unity.ts IMAGE_EXT, which reads exports.
export const IMAGE_TYPES_TEXT = inWords(IMAGE_EXTENSIONS.map((ext) => ext.slice(1).toUpperCase()));

// F-77: what a .ccAvatar does not keep. The pose is not read back, so this static text names it with the expression.
const NOT_IN_CCAVATAR = "A .ccAvatar keeps neither the facial expression nor the pose: after loading it the face is " +
  "neutral and the body is back in its default pose; re-apply them with set_expression and apply_pose, or with " +
  "expression and pose_file steps in each batch variant.";

type SaveCharacterResult = JobResult & { path?: string; expression_not_saved?: Array<{ name: string; weight: number }> };

/** save_character's reply: the path, and the facial expression sliders the .ccAvatar did not keep. */
function savedText(r: SaveCharacterResult, outputPath: string): string {
  const saved = `Saved ${r.path ?? outputPath}`;
  const unsaved = r.expression_not_saved;
  if (unsaved === undefined) return `${saved}\n${NOT_IN_CCAVATAR}`;  // an older plugin, or the expression was unreadable
  if (!unsaved.length) return saved;
  const count = `${unsaved.length} slider${unsaved.length === 1 ? "" : "s"}`;
  const sliders = unsaved.map((e) => `${e.name} ${e.weight}`).join(", ");
  return `${saved}\nNot saved: the facial expression (${count}: ${sliders}). A .ccAvatar keeps neither the facial ` +
    `expression nor the pose: to keep this expression, give each batch variant this expression step: ${JSON.stringify(unsaved)}`;
}

// F-83 (live CC5 5.13): CC5 reads an OBJ as the mesh in the character's current pose, and no OBJ export writes that
// pose: export_obj writes CC5's T-pose, the pose a character with no motion clip stands in, and replace_mesh_from_obj
// removes the character's pose before it replaces.
// TS-8 (DT-3): replace_mesh_from_obj checks the OBJ against a Y-up T-pose export of the character and refuses a Z-up
// OBJ (an export_obj with y_up false), naming the axis (cc5_pipeline.replace_mesh_from_obj). What it needs:
export const OBJ_Y_UP = "a Y-up OBJ (export with y_up true, and save Y-up from the sculpting tool)";

export const EXPORT_OBJ_DESCRIPTION =
  "Export the current character as OBJ in CC5's T-pose (arms horizontal), for sculpting in ZBrush or Blender. Keep " +
  `the pose while sculpting, then bring the mesh back with replace_mesh_from_obj, which needs ${OBJ_Y_UP}.`;

// DEC-9 (Chad, 2026-10-06): replace_mesh_from_obj removes a pose (a motion clip of at most one frame) but refuses
// an animation, which it would have to delete for good. Keep in step with ANIMATION_REFUSED and _clips_to_remove in
// cc5-plugin/cc5_pipeline.py.
export const REPLACE_MESH_ANIMATION_RULE =
  "It refuses a character with an animation (a motion clip longer than one frame): the animation would have to be " +
  "deleted and cannot be restored, so the user removes it in Character Creator 5 first.";

export const REPLACE_MESH_DESCRIPTION =
  "Replace one of the character's meshes with an edited OBJ from export_obj (same topology, in CC5's T-pose), e.g. a " +
  `ZBrush or Blender sculpt of CC_Base_Body. It needs ${OBJ_Y_UP}. CC5 reads the OBJ in the character's current ` +
  "pose, so the tool first removes the character's pose (it then stands in a T-pose; apply_pose puts a pose back). " +
  `${REPLACE_MESH_ANIMATION_RULE} It also refuses, changing nothing, an OBJ whose mesh has a different vertex count, ` +
  "another pose (an OBJ from an older export_obj is in the bind pose) or another vertex order, and a Z-up OBJ (an " +
  "export_obj with y_up false). After the replace it checks the mesh against the OBJ and undoes the replace if CC5 " +
  "read it differently or did not apply it. Runs as a background job; a slow replacement returns a job id for " +
  "job_status.";

export const EXPORT_GOZ_DESCRIPTION =
  "Export the current character as GoZ files for ZBrush (open them in ZBrush, sculpt, then export an OBJ and bring " +
  "the changes back with replace_mesh_from_obj). replace_mesh_from_obj needs the mesh in CC5's T-pose: export with " +
  "pose 'tpose' (the default) and export the OBJ from ZBrush without changing the pose. Whether ZBrush's GoZ T-pose " +
  "matches CC5's is untested: replace_mesh_from_obj refuses a mismatch.";

/** A plugin result's notes, in their order (strings only). */
function resultNotes(result: unknown): string[] {
  const notes = typeof result === "object" && result !== null ? (result as { notes?: unknown }).notes : undefined;
  return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === "string") : [];
}

type ReplaceMeshResult = JobResult & { mesh?: string; pose_removed?: boolean; check_max_cm?: number | null; notes?: string[] };

/** replace_mesh_from_obj's reply (F-83): the replace, its check against the OBJ, and the notes (the pose removed). */
function replacedText(r: ReplaceMeshResult, meshName: string, objPath: string): string {
  const lines = [`Replaced ${meshName} with ${path.basename(objPath)}`];
  if (typeof r.check_max_cm === "number") lines.push(`Checked: the mesh matches the OBJ (max ${r.check_max_cm.toFixed(2)} cm).`);
  return [...lines, ...resultNotes(r)].join("\n");
}

// Chad's ruling (2026-10-03): switched off. Live in CC5 5.13 (Task 18), a whole-character FBX import stopped in CC5's
// "Create Asset(s)" dialog and crashed CC5. Keep the text in sync with IMPORT_CHARACTER_DISABLED in
// cc5-plugin/cc5_pipeline.py.
export const IMPORT_CHARACTER_DISABLED =
  "import_fbx with kind 'character' is switched off because it crashed Character Creator 5. Import the whole " +
  "character by hand instead: use File > Import in Character Creator 5. Importing a 'prop' or 'clothing' " +
  "still works.";

export function registerPipelineTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "apply_pose",
    "Apply a pose or motion file (.rlMotion, .rlPose, .iMotion, .iPose, .iMotionPlus, .ccPose, .ccMotion) to the current character, e.g. a supine pose before export. Use browse_content('pose') or browse_content('motion') to find files. Runs as a background job; a slow load returns a job id for job_status.",
    { file_path: z.string().describe("Absolute path to the pose/motion file") },
    async ({ file_path }) => {
      const err = checkFile(file_path, POSE_EXTENSIONS);
      if (err) return errorResult(err);
      // Jobs, not direct calls, for anything that can outlast the bridge's 30 s limit for direct calls.
      return runJobTool(bridge, "apply_pose", { file_path },
        (r: JobResult & { method?: string }) => `Applied pose ${path.basename(file_path)} (${r.method})`);
    }
  );

  server.tool(
    "save_character",
    `Save the current character as a .ccAvatar file (used as the clean base for batch generation). Runs as a background job; a slow save returns a job id for job_status. ${NOT_IN_CCAVATAR}`,
    { output_path: z.string().describe("Absolute path ending in .ccAvatar") },
    async ({ output_path }) => {
      const err = checkFile(output_path, [".ccavatar"]);
      if (err) return errorResult(err);
      return runJobTool(bridge, "save_character", { output_path },
        (r: SaveCharacterResult) => savedText(r, output_path));
    }
  );

  server.tool(
    "export_obj",
    EXPORT_OBJ_DESCRIPTION,
    {
      output_path: z.string().describe("Absolute path ending in .obj"),
      y_up: z.boolean().default(true).describe(`Y-up axis. Keep true for ZBrush, Maya and Blender (Blender's OBJ importer converts Y-up to Z-up); replace_mesh_from_obj needs ${OBJ_Y_UP}. false only for a tool that expects Z-up OBJ: replace_mesh_from_obj refuses that OBJ`),
    },
    async ({ output_path, y_up }) => {
      const err = checkFile(output_path, [".obj"]);
      if (err) return errorResult(err);
      let warnings: string[] = [];
      const res = await bridgeCall(() => bridge.exportObj(output_path, y_up), (r) => {
        if (!r.success) return `Failed: ${r.error}`;
        warnings = warningNotes(r);
        // The plugin's note says the OBJ is in CC5's T-pose (F-83).
        if (!warnings.length) return [`Exported ${r.path}`, ...resultNotes(r)].join("\n");
        // A weaker call form drops the axis, part and material options, and its OBJ may not be in CC5's T-pose:
        // replace_mesh_from_obj would refuse it, or read it wrong.
        return `Exported ${r.path} with ${r.signature}, not as asked:\n${warnings.join("\n")}\n` +
          "Do not sculpt on this OBJ or bring it back with replace_mesh_from_obj.";
      });
      return warnings.length ? errorResult(res.content[0].text) : res;
    }
  );

  server.tool(
    "export_goz",
    EXPORT_GOZ_DESCRIPTION,
    {
      output_dir: z.string().describe("Absolute folder for the GoZ files"),
      pose: z.enum(["current", "tpose", "apose"]).default("tpose"),
    },
    async ({ output_dir, pose }) => {
      if (!isLocalAbsolute(output_dir)) return errorResult("output_dir must be a local absolute path without '..' (no network/UNC paths)");
      try {
        const out = await runJob(bridge, "export_goz", { output_dir, pose });
        if (!out.done) return pendingResult(out);
        const r = out.result as { success: boolean; error?: string; folder?: string; files?: unknown[]; pose_applied?: boolean };
        if (out.failed || !r.success) return errorResult(`GoZ export failed: ${r.error ?? "unknown error"}`);
        const warn = r.pose_applied === false ? `\nWARNING: pose '${pose}' was NOT applied (RExportGoZMeshOption took no pose); files use the character's current pose.` : "";
        return { content: [{ type: "text" as const, text: `GoZ files written to ${r.folder} (${r.files?.length ?? 0} files)${warn}` }] };
      } catch (e) {
        return bridgeErrorResult(e);
      }
    }
  );

  server.tool(
    "import_fbx",
    "Import an FBX made in Blender, Maya or another tool: as a 'prop' (placed at the origin; move it with set_object_transform, remove it with delete_object), or as 'clothing' fitted to a character (target, else the selected character, else the first). Kind 'character' is switched off (it crashed Character Creator 5) and fails at once: ask the user to import a whole character by hand with File > Import in Character Creator 5. CC5 can stop to ask about the import (its 'Import Settings' frame-rate question, Convert All / Cancel): read it with get_cc5_dialog and answer it with answer_cc5_dialog (Convert All is the plain go-ahead), then job_status. Live CC5 5.13 once crashed on the first FBX import of a fresh session: make sure the user's work is saved first.",
    {
      file_path: z.string().describe("Absolute path to the .fbx"),
      kind: z.enum(["prop", "character", "clothing"]).describe("'prop' or 'clothing'; 'character' is switched off"),
      target: z.string().min(1).max(256).optional().describe("Character to dress (a list_avatars name); clothing only"),
    },
    async ({ file_path, kind, target }) => {
      if (kind === "character") return errorResult(IMPORT_CHARACTER_DISABLED);  // Chad's ruling: never calls CC5
      if (target !== undefined && kind !== "clothing") return errorResult("target is only for kind 'clothing'");
      const err = checkFile(file_path, [".fbx"]);
      if (err) return errorResult(err);
      try {
        const out = await runJob(bridge, "import_fbx", target === undefined ? { file_path, kind } : { file_path, kind, target });
        if (!out.done) {
          return pendingResult(out, "If CC5 shows its Import Settings dialog, read it with get_cc5_dialog and answer it with answer_cc5_dialog: the import waits for it.");
        }
        const r = out.result as { success: boolean; error?: string; signature?: string; notes?: string[] };
        if (out.failed || !r.success) return errorResult(`Import failed: ${r.error ?? "unknown error"}`);
        const done = `Imported ${path.basename(file_path)} as ${kind}`;
        const warnings = warningNotes(r);
        // Not an error result: the import ran, and repeating it would add the content a second time.
        return { content: [{ type: "text" as const, text: warnings.length
          ? `${done} (${r.signature}), with warnings:\n${warnings.join("\n")}\nThe import ran: check the scene before importing again.`
          : done }] };
      } catch (e) {
        return bridgeErrorResult(e);
      }
    }
  );

  server.tool(
    "list_meshes",
    "List the current character's mesh names (needed for replace_mesh_from_obj and load_texture).",
    {},
    async () => bridgeCall(() => bridge.listMeshes(),
      (r) => r.success ? (r.meshes ?? []).join("\n") : `Failed: ${r.error}`)
  );

  server.tool(
    "replace_mesh_from_obj",
    REPLACE_MESH_DESCRIPTION,
    {
      mesh_name: z.string().min(1).max(256).describe("Mesh to replace, from list_meshes"),
      obj_path: z.string().describe("Absolute path to the edited .obj (from export_obj, sculpted in the same pose, saved Y-up)"),
    },
    async ({ mesh_name, obj_path }) => {
      const err = checkFile(obj_path, [".obj"]);
      if (err) return errorResult(err);
      return runJobTool(bridge, "replace_mesh_from_obj", { mesh_name, obj_path },
        (r: ReplaceMeshResult) => replacedText(r, mesh_name, obj_path));
    }
  );

  server.tool(
    "load_texture",
    "Load an image into one texture channel of one material (e.g. a new iris, a normal map from Substance or ZBrush). Use get_material_info for mesh/material names. For diffuse_blend (a layer blended over the diffuse) the tool also sets the layer's strength, default 100: CC5 shows a Diffuse Blend image only above 0. For skin overlays use apply_skin_overlay.",
    {
      mesh_name: z.string().min(1).max(256),
      material_name: z.string().min(1).max(256),
      channel: z.enum(TEXTURE_CHANNELS),
      image_path: z.string().describe("Absolute path to the image"),
      strength: z.number().min(0).max(100).optional()
        .describe("diffuse_blend only: blend strength 0-100 (default 100). CC5 shows a Diffuse Blend image only above 0"),
    },
    async ({ mesh_name, material_name, channel, image_path, strength }) => {
      if (strength !== undefined && channel !== "diffuse_blend") return errorResult("strength is only for channel 'diffuse_blend'");
      const err = checkFile(image_path, IMAGE_EXTENSIONS);
      if (err) return errorResult(err);
      const loaded = `Loaded ${path.basename(image_path)} into ${material_name}`;
      let strengthNotSet = false;
      // Four arguments without a strength: the plugin then uses its own default (100 for diffuse_blend).
      const res = await bridgeCall(() => strength === undefined
        ? bridge.loadTexture(mesh_name, material_name, channel, image_path)
        : bridge.loadTexture(mesh_name, material_name, channel, image_path, strength),
      (r) => {
        if (!r.success) return `Failed: ${r.error}`;
        if (channel !== "diffuse_blend") return `${loaded} (${channel})`;
        if (typeof r.strength !== "number") {
          // TS-7 (X-4): the plugin reports the strength it set on every diffuse_blend load since F-66. A plugin
          // installed before that set none, so the layer may still be at 0: no percentage, and an error.
          strengthNotSet = true;
          return `${loaded} (diffuse_blend), but the installed CC5 plugin predates the strength fix and did not set ` +
            "the layer's strength, so the image may not show (CC5 shows a Diffuse Blend image only above 0). " +
            "Reinstall the plugin with install-plugin.ps1.";
        }
        // The strength set, never CC5's read (which lags until CC5 renders).
        return `${loaded} (diffuse_blend) at ${Math.round(r.strength * 100)}%` +
          (r.stale ? " (CC5 reads the strength back only after it renders)" : "");
      });
      return strengthNotSet ? errorResult(res.content[0].text) : res;
    }
  );

  server.tool(
    "load_substance_textures",
    "Apply a Substance Painter texture export folder to the current character (CC5's built-in Substance import). Runs as a background job; a slow import returns a job id for job_status.",
    { folder: z.string().describe("Absolute path of the Substance Painter export folder") },
    async ({ folder }) => {
      if (!isLocalAbsolute(folder)) return errorResult("folder must be a local absolute path without '..' (no network/UNC paths)");
      return runJobTool(bridge, "load_substance_textures", { folder }, () => `Applied Substance textures from ${folder}`);
    }
  );

  server.tool(
    "export_textures",
    "Export the character as FBX plus its texture images (in their source formats) into <output_dir>/<character_name>/ — the starting point for texturing in Substance Painter. CC5 5.13 often crashes on the first FBX export after it starts: call save_character before the session's first FBX export, so the character is not lost.",
    {
      output_dir: z.string().describe("Absolute folder"),
      character_name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    },
    async ({ output_dir, character_name }) => {
      if (!isLocalAbsolute(output_dir)) return errorResult("output_dir must be a local absolute path without '..' (no network/UNC paths)");
      try {
        const out = await runJob(bridge, "export_textures", { output_dir, character_name });
        if (!out.done) return pendingResult(out);
        const r = out.result as {
          success: boolean; error?: string; folder?: string; files?: unknown[]; notes?: string[];
          undo_history_cleared?: boolean;
        };
        const warnings = warningNotes(r);
        // X-2: the note on CC5's timeline, set to one frame for this mesh-only export (F-82) and not set back, is no
        // export setting CC5 failed to apply: the FBX is right. Its line calls the FBX usable only when nothing else
        // went wrong (TIMELINE_USABLE_LINE); beside a failure or settings CC5 did not apply it is TIMELINE_LEFT_LINE.
        const timelineNotRestored = warnings.some((n) => n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
        const settingWarnings = warnings.filter((n) => !n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
        const timelineLeft = timelineNotRestored ? [TIMELINE_LEFT_LINE] : [];
        if (out.failed || !r.success) {
          const failed = [`Texture export failed: ${r.error ?? "unknown error"}`, ...settingWarnings, ...timelineLeft];
          return errorResult(withUndoHistoryLine(failed.join("\n"), r));
        }
        const exported = `Exported mesh and ${r.files?.length ?? 0} files to ${r.folder}`;
        // F-86: this is an FBX export too, so CC5 cleared its undo history.
        if (settingWarnings.length) {
          const notApplied = [`${exported}, but CC5 did not apply every export setting:`, ...settingWarnings, ...timelineLeft];
          return errorResult(withUndoHistoryLine(notApplied.join("\n"), r));
        }
        const done = [exported, ...(timelineNotRestored ? [TIMELINE_USABLE_LINE] : [])];
        return { content: [{ type: "text" as const, text: withUndoHistoryLine(done.join("\n"), r) }] };
      } catch (e) {
        return bridgeErrorResult(e);
      }
    }
  );
}
