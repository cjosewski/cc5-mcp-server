/**
 * Unity export: writes the current character with CC5's Unity preset
 * straight into a folder inside a Unity project's Assets tree.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { errorResult } from "../util.js";
import { runJob, formatPending } from "../jobs.js";

export const CHARACTER_NAME = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe("File-safe name: letters, digits, '_' or '-' (max 64)");

/** Absolute local path without '..'. Rejects UNC/network paths (two leading slashes or backslashes) and device/NT paths (any '?'). */
export function isLocalAbsolute(p: string): boolean {
  return path.isAbsolute(p) && !/^[\\/]{2}/.test(p) && !p.includes("?") && !p.includes("..");
}

export function isInUnityAssets(folder: string): boolean {
  return path.normalize(folder).split(/[\\/]/).some((p) => p.toLowerCase() === "assets");
}

export function formatFiles(files: Array<{ path: string; bytes: number }>): string {
  const totalMb = files.reduce((s, f) => s + f.bytes, 0) / 1_048_576;
  return `${files.length} files, ${totalMb.toFixed(1)} MB total`;
}

export function registerUnityTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "export_for_unity",
    "Export the current character as FBX with CC5's Unity preset into <unity_dir>/<character_name>/. unity_dir must be inside a Unity project's Assets folder. Runs as a background job; long exports return a job id for job_status.",
    {
      unity_dir: z.string().describe("Absolute folder inside a Unity project's Assets folder"),
      character_name: CHARACTER_NAME,
      sub_d_level: z.number().int().min(0).max(2).optional().describe("Subdivision level (0 = base mesh, best for Quest)"),
      texture_size: z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)]).optional(),
      include_current_pose: z.boolean().optional().describe("Export in the current pose instead of T-pose"),
      wait_seconds: z.number().int().min(0).max(120).default(25),
    },
    async ({ unity_dir, character_name, sub_d_level, texture_size, include_current_pose, wait_seconds }) => {
      if (!isLocalAbsolute(unity_dir)) return errorResult("unity_dir must be a local absolute path without '..' (no network/UNC paths)");
      if (!isInUnityAssets(unity_dir)) return errorResult(`unity_dir must be inside a Unity project's Assets folder: ${unity_dir}`);
      try {
        const out = await runJob(bridge, "export_for_unity",
          { unity_dir, character_name, sub_d_level, texture_size, include_current_pose },
          { waitMs: (wait_seconds ?? 25) * 1000 });
        if (!out.done) return { content: [{ type: "text" as const, text: formatPending(out.job_id) }] };
        const r = out.result as { success: boolean; error?: string; fbx?: string; files?: Array<{ path: string; bytes: number }> };
        if (out.failed || !r.success) return errorResult(`Unity export failed: ${r.error ?? "unknown error"}`);
        return { content: [{ type: "text" as const, text: `Exported ${r.fbx} (${formatFiles(r.files ?? [])}). Switch to Unity to import it.` }] };
      } catch (err) {
        return errorResult(`CC5 bridge error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
