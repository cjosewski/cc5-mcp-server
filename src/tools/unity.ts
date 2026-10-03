/**
 * Unity export: writes the current character with CC5's Unity preset
 * straight into a folder inside a Unity project's Assets tree.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { MeshStatsResult } from "../types.js";
import { bridgeCall, errorResult, warningNotes } from "../util.js";
import { runJob, formatPending } from "../jobs.js";
import { readImageSize } from "../image-info.js";

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

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Defaults match the heaviest shipping Trauma Sim patient (Patient_FemaleWhite), measured 2026-10-02.
// maxFaces (env CC5_BUDGET_MAX_FACES, tool max_faces) counts TRIANGLES, as Unity does: CC5's own face count is
// polygons (quads), so the check uses get_mesh_stats' triangle totals. maxTextureGpuMb is the textures'
// estimated Quest GPU memory in MiB (bytes / 1,048,576).
export const QUEST_DEFAULTS = {
  maxFaces: envNumber("CC5_BUDGET_MAX_FACES", 65_000),
  maxTexturePx: envNumber("CC5_BUDGET_MAX_TEXTURE_PX", 2048),
  maxTextureGpuMb: envNumber("CC5_BUDGET_MAX_TEXTURE_GPU_MB", 66),
  maxMaterials: envNumber("CC5_BUDGET_MAX_MATERIALS", 20),
};
export type BudgetLimits = typeof QUEST_DEFAULTS;
export type TextureInfo = { path: string; bytes: number; width: number; height: number };

// Same model the reference measurement used: ASTC 6x6 (Unity's default Android compression) with a full mip chain.
const ASTC_6X6_BITS_PER_PIXEL = 3.56;
const MIP_CHAIN_FACTOR = 4 / 3;

/** Estimated Quest GPU memory in MiB, each texture scaled so its longer edge is at most maxPx (Unity's import clamp). */
export function estimateTextureGpuMb(textures: TextureInfo[], maxPx: number): number {
  let bytes = 0;
  for (const t of textures) {
    const longEdge = Math.max(t.width, t.height);
    if (longEdge === 0) continue;
    const scale = Math.min(1, maxPx / longEdge);
    bytes += (t.width * scale) * (t.height * scale) * (ASTC_6X6_BITS_PER_PIXEL / 8) * MIP_CHAIN_FACTOR;
  }
  return bytes / 1_048_576;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff"]);

export function scanTextures(folder: string): TextureInfo[] {
  const out: TextureInfo[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        const size = readImageSize(full) ?? { width: 0, height: 0 };
        out.push({ path: full, bytes: fs.statSync(full).size, ...size });
      }
    }
  };
  walk(folder);
  return out;
}

/** Scene triangles, and whether that is an estimate (2 per polygon): a plugin older than the triangle count, or a
 * mesh whose faces CC5 would not list. */
function sceneTriangles(stats: MeshStatsResult): { triangles: number; estimated: boolean } {
  const estimated = stats.totals.triangles === undefined || (stats.meshes ?? []).some((m) => m.approximate);
  return { triangles: stats.totals.triangles ?? stats.totals.faces * 2, estimated };
}

export function evaluateBudget(stats: MeshStatsResult, textures: TextureInfo[], limits: BudgetLimits): { pass: boolean; lines: string[] } {
  const lines: string[] = [];
  let pass = true;
  const check = (ok: boolean, text: string) => { if (!ok) pass = false; lines.push(`${ok ? "OK  " : "OVER"} ${text}`); };
  const fmt = (n: number) => n.toLocaleString("en-US");
  const { triangles, estimated } = sceneTriangles(stats);
  check(triangles <= limits.maxFaces,
    `Triangles: ${fmt(triangles)} / ${fmt(limits.maxFaces)}${estimated ? " (estimated as 2 per polygon)" : ""}`);
  check(stats.totals.materials <= limits.maxMaterials, `Materials: ${stats.totals.materials} / ${limits.maxMaterials}`);
  if (textures.length) {
    const gpuMb = estimateTextureGpuMb(textures, limits.maxTexturePx);
    check(gpuMb <= limits.maxTextureGpuMb,
      `Texture GPU memory (est., ASTC 6x6 + mips): ${gpuMb.toFixed(1)} MiB / ${limits.maxTextureGpuMb} MiB`);
    const fileMb = textures.reduce((s, t) => s + t.bytes, 0) / 1_048_576;
    lines.push(`     Texture files on disk: ${fileMb.toFixed(1)} MiB (information only)`);
    const big = textures.filter((t) => Math.max(t.width, t.height) > limits.maxTexturePx);
    check(big.length === 0, `Textures larger than ${limits.maxTexturePx}px: ${big.length}`);
    for (const t of big) lines.push(`     ${path.basename(t.path)} (${t.width}x${t.height})`);
    const unreadable = textures.filter((t) => t.width === 0 || t.height === 0);
    check(unreadable.length === 0, `Textures with unreadable size: ${unreadable.length}`);
    for (const t of unreadable) lines.push(`     ${path.basename(t.path)} (size unreadable)`);
  } else {
    lines.push("     (no texture images scanned)");
  }
  return { pass, lines };
}

/**
 * Budget verdict for an FBX exported at `subDLevel`. export_fbx subdivides only the FBX
 * (RExportFbxSetting.SetExportLevel leaves the scene mesh at base level), so the scene stats cannot vouch for a
 * subdivided export's triangles. Subdivision only adds triangles and leaves materials and textures alone, so a
 * base-mesh fail still holds; a base-mesh pass proves nothing. `pass` is undefined when triangles were not checked.
 */
export function evaluateExportBudget(stats: MeshStatsResult, textures: TextureInfo[], limits: BudgetLimits, subDLevel = 0):
  { pass: boolean | undefined; lines: string[] } {
  const budget = evaluateBudget(stats, textures, limits);
  if (subDLevel <= 0) return budget;
  const factor = 4 ** subDLevel;
  const estimate = (sceneTriangles(stats).triangles * factor).toLocaleString("en-US");
  return {
    pass: budget.pass ? undefined : false,
    lines: [
      `NOT CHECKED Triangles: the FBX was exported at sub_d_level ${subDLevel} (about ${factor}x the triangles, roughly ${estimate}); the Triangles line below counts the base scene mesh`,
      ...budget.lines,
    ],
  };
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
      include_current_pose: z.boolean().optional()
        .describe("Export the current pose. The FBX carries it as a one-frame animation clip; the model's default pose stays the bind pose"),
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
        const r = out.result as {
          success: boolean; error?: string; fbx?: string; files?: Array<{ path: string; bytes: number }>;
          notes?: string[]; export_level?: number | null;
        };
        const warnings = warningNotes(r);
        const warningText = warnings.length ? `\n${warnings.join("\n")}` : "";
        if (out.failed || !r.success) return errorResult(`Unity export failed: ${r.error ?? "unknown error"}${warningText}`);
        const level = r.export_level ?? 0;
        const subdivided = level > 0
          ? ` Exported at sub_d_level ${level}: if the character has HD data, the FBX has about ${4 ** level}x the base mesh's triangles, so give check_quest_budget sub_d_level ${level}.`
          : "";
        const posed = include_current_pose
          ? " The pose is a one-frame animation clip in the FBX: the model's default pose stays the bind pose, so apply that clip (e.g. as the Animator's default state) to show the pose in Unity."
          : "";
        const exported = `Exported ${r.fbx} (${formatFiles(r.files ?? [])}).${subdivided}${posed}`;
        if (warnings.length) {
          return errorResult(`${exported}\nCC5 did not apply every export setting, so do not use this FBX until that is fixed:${warningText}`);
        }
        return { content: [{ type: "text" as const, text: `${exported} Switch to Unity to import it.` }] };
      } catch (err) {
        return errorResult(`CC5 bridge error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  server.tool(
    "check_quest_budget",
    "Check the current character against the Quest 3 per-character budget (triangles, materials, and — when export_folder is given — texture sizes). Defaults (matching the current Trauma Sim patient): 65,000 triangles (CC5 counts polygons; this counts triangles, like Unity), 20 materials, 2048px textures, 66 MiB estimated texture GPU memory (ASTC 6x6 + mips; file size on disk is reported but not limited). Checking an export made with sub_d_level above 0? Pass the same sub_d_level: its triangles cannot be counted from the scene.",
    {
      export_folder: z.string().optional().describe("Folder from export_for_unity, to include texture checks"),
      sub_d_level: z.number().int().min(0).max(2).optional()
        .describe("The sub_d_level that export was made with (0 = base mesh). Above 0 the triangle budget is reported as NOT CHECKED, because the scene stats count the base mesh"),
      max_faces: z.number().int().positive().optional().describe("Triangle limit (default 65,000)"),
      max_materials: z.number().int().positive().optional(),
      max_texture_px: z.number().int().positive().optional(),
      max_texture_gpu_mb: z.number().positive().optional(),
    },
    async ({ export_folder, sub_d_level, max_faces, max_materials, max_texture_px, max_texture_gpu_mb }) => {
      if (export_folder && (!isLocalAbsolute(export_folder) || !fs.existsSync(export_folder))) {
        return errorResult(`export_folder must be an existing local absolute folder (no network/UNC paths): ${export_folder}`);
      }
      if (export_folder && !fs.statSync(export_folder).isDirectory()) {
        return errorResult(`export_folder is not a folder: ${export_folder}`);
      }
      const limits: BudgetLimits = {
        maxFaces: max_faces ?? QUEST_DEFAULTS.maxFaces,
        maxMaterials: max_materials ?? QUEST_DEFAULTS.maxMaterials,
        maxTexturePx: max_texture_px ?? QUEST_DEFAULTS.maxTexturePx,
        maxTextureGpuMb: max_texture_gpu_mb ?? QUEST_DEFAULTS.maxTextureGpuMb,
      };
      const res = await bridgeCall(() => bridge.getMeshStats(), (stats) => {
        if (!stats.success) return `Failed: ${stats.error}`;
        const level = sub_d_level ?? 0;
        const { pass, lines } = evaluateExportBudget(stats, export_folder ? scanTextures(export_folder) : [], limits, level);
        const verdict = pass === undefined
          ? `NOT CHECKED — Quest budget: the triangles of a sub_d_level ${level} export cannot be counted from the scene (everything else is within budget)`
          : `${pass ? "PASS" : "FAIL"} — Quest budget`;
        return `${verdict}\n${lines.join("\n")}`;
      });
      return res.content[0].text.startsWith("FAIL") ? errorResult(res.content[0].text) : res;
    }
  );
}
