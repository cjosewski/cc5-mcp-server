/**
 * Pipeline tools: poses, saving, and DCC round-trips (Blender, Substance Painter, ZBrush).
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, errorResult } from "../util.js";
import { isLocalAbsolute } from "./unity.js";
import { runJob, formatPending } from "../jobs.js";

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

export function registerPipelineTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "apply_pose",
    "Apply a pose or motion file (.rlMotion, .rlPose, .iMotion, .iPose, .iMotionPlus, .ccPose, .ccMotion) to the current character, e.g. a supine pose before export. Use browse_content('pose') or browse_content('motion') to find files.",
    { file_path: z.string().describe("Absolute path to the pose/motion file") },
    async ({ file_path }) => {
      const err = checkFile(file_path, POSE_EXTENSIONS);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.applyPose(file_path),
        (r) => r.success ? `Applied pose ${path.basename(file_path)} (${r.method})` : `Failed: ${r.error}`);
    }
  );

  server.tool(
    "save_character",
    "Save the current character as a .ccAvatar file (used as the clean base for batch generation).",
    { output_path: z.string().describe("Absolute path ending in .ccAvatar") },
    async ({ output_path }) => {
      const err = checkFile(output_path, [".ccavatar"]);
      if (err) return errorResult(err);
      return bridgeCall(() => bridge.saveCharacter(output_path),
        (r) => r.success ? `Saved ${r.path}` : `Failed: ${r.error}`);
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
      return bridgeCall(() => bridge.exportObj(output_path, y_up),
        (r) => r.success ? `Exported ${r.path}` : `Failed: ${r.error}`);
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
        if (!out.done) return { content: [{ type: "text" as const, text: formatPending(out.job_id) }] };
        const r = out.result as { success: boolean; error?: string; folder?: string; files?: unknown[]; pose_applied?: boolean };
        if (out.failed || !r.success) return errorResult(`GoZ export failed: ${r.error ?? "unknown error"}`);
        const warn = r.pose_applied === false ? `\nWARNING: pose '${pose}' was NOT applied (no pose setter on RExportGoZMeshOption); files use the character's current pose.` : "";
        return { content: [{ type: "text" as const, text: `GoZ files written to ${r.folder} (${r.files?.length ?? 0} files)${warn}` }] };
      } catch (e) {
        return errorResult(`CC5 bridge error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );
}
