/**
 * Pipeline tools: poses, saving, and DCC round-trips (Blender, Substance Painter, ZBrush).
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, bridgeErrorResult, errorResult, warningNotes } from "../util.js";
import { isLocalAbsolute } from "./unity.js";
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
    "Save the current character as a .ccAvatar file (used as the clean base for batch generation). Runs as a background job; a slow save returns a job id for job_status.",
    { output_path: z.string().describe("Absolute path ending in .ccAvatar") },
    async ({ output_path }) => {
      const err = checkFile(output_path, [".ccavatar"]);
      if (err) return errorResult(err);
      return runJobTool(bridge, "save_character", { output_path },
        (r: JobResult & { path?: string }) => `Saved ${r.path ?? output_path}`);
    }
  );

  server.tool(
    "export_obj",
    "Export the current character as OBJ (for sculpting in ZBrush or Blender). Bring the edited mesh back with replace_mesh_from_obj.",
    {
      output_path: z.string().describe("Absolute path ending in .obj"),
      y_up: z.boolean().default(true).describe("Y-up axis. Keep true for ZBrush, Maya and Blender (Blender's OBJ importer converts Y-up to Z-up); false only for a tool that expects Z-up OBJ"),
    },
    async ({ output_path, y_up }) => {
      const err = checkFile(output_path, [".obj"]);
      if (err) return errorResult(err);
      let warnings: string[] = [];
      const res = await bridgeCall(() => bridge.exportObj(output_path, y_up), (r) => {
        if (!r.success) return `Failed: ${r.error}`;
        warnings = warningNotes(r);
        if (!warnings.length) return `Exported ${r.path}`;
        // A weaker call form drops the bind-pose and axis options; such an OBJ breaks replace_mesh_from_obj.
        return `Exported ${r.path} with ${r.signature}, not as asked:\n${warnings.join("\n")}\n` +
          "Do not sculpt on this OBJ or bring it back with replace_mesh_from_obj.";
      });
      return warnings.length ? errorResult(res.content[0].text) : res;
    }
  );

  server.tool(
    "export_goz",
    "Export the current character as GoZ files for ZBrush (open them in ZBrush, sculpt, then export OBJ and use replace_mesh_from_obj to bring changes back).",
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
    "Replace one of the character's meshes with an edited OBJ (same topology, e.g. a ZBrush or Blender sculpt of CC_Base_Body). Runs as a background job; a slow replacement returns a job id for job_status.",
    {
      mesh_name: z.string().min(1).max(256).describe("Mesh to replace, from list_meshes"),
      obj_path: z.string().describe("Absolute path to the edited .obj"),
    },
    async ({ mesh_name, obj_path }) => {
      const err = checkFile(obj_path, [".obj"]);
      if (err) return errorResult(err);
      return runJobTool(bridge, "replace_mesh_from_obj", { mesh_name, obj_path },
        () => `Replaced ${mesh_name} with ${path.basename(obj_path)}`);
    }
  );

  server.tool(
    "load_texture",
    "Load an image into one texture channel of one material (e.g. a new iris, a normal map from Substance or ZBrush). Use get_material_info for mesh/material names.",
    {
      mesh_name: z.string().min(1).max(256),
      material_name: z.string().min(1).max(256),
      channel: z.enum(TEXTURE_CHANNELS),
      image_path: z.string().describe("Absolute path to the image"),
    },
    async ({ mesh_name, material_name, channel, image_path }) => {
      const err = checkFile(image_path, IMAGE_EXTENSIONS);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.loadTexture(mesh_name, material_name, channel, image_path),
        (r) => r.success ? `Loaded ${path.basename(image_path)} into ${material_name} (${channel})` : `Failed: ${r.error}`);
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
        const r = out.result as { success: boolean; error?: string; folder?: string; files?: unknown[]; notes?: string[] };
        const warnings = warningNotes(r);
        const warningText = warnings.length ? `\n${warnings.join("\n")}` : "";
        if (out.failed || !r.success) return errorResult(`Texture export failed: ${r.error ?? "unknown error"}${warningText}`);
        const exported = `Exported mesh and ${r.files?.length ?? 0} files to ${r.folder}`;
        return warnings.length
          ? errorResult(`${exported}, but CC5 did not apply every export setting:${warningText}`)
          : { content: [{ type: "text" as const, text: exported }] };
      } catch (e) {
        return bridgeErrorResult(e);
      }
    }
  );
}
