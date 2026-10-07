/**
 * Unity export: writes the current character with CC5's Unity preset
 * straight into a folder inside a Unity project's Assets tree.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { MeshStatsResult } from "../types.js";
import { bridgeCall, bridgeErrorResult, errorResult, warningNotes } from "../util.js";
import { runJob, pendingResult } from "../jobs.js";
import { readImageSize } from "../image-info.js";

export const CHARACTER_NAME = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe("File-safe name: letters, digits, '_' or '-' (max 64)");

/** Absolute local path without '..'. Rejects UNC/network paths (two leading slashes or backslashes) and device/NT paths (any '?'). */
export function isLocalAbsolute(p: string): boolean {
  return path.isAbsolute(p) && !/^[\\/]{2}/.test(p) && !p.includes("?") && !p.includes("..");
}

/** Whether a path segment is named Assets. export_for_unity also wants a Unity project around it: unityFolderError. */
export function isInUnityAssets(folder: string): boolean {
  return path.normalize(folder).split(/[\\/]/).some((p) => p.toLowerCase() === "assets");
}

/**
 * null when `folder` is inside the Assets folder of a Unity project, else why not (F-76; mirrors the plugin's
 * unity_folder_error). A Unity project has ProjectSettings\ProjectVersion.txt beside its Assets folder; each Assets
 * folder in the path is tried, innermost first, so a project nested inside another project's Assets counts. Never throws.
 */
export function unityFolderError(folder: string): string | null {
  const outside = `unity_dir must be inside a Unity project's Assets folder: ${folder}`;
  if (!isInUnityAssets(folder)) return outside;
  const markers: string[] = [];
  let current = path.resolve(folder);
  for (;;) {
    const parent = path.dirname(current);
    if (path.basename(current).toLowerCase() === "assets" && parent !== current) {
      // A drive-root parent ("C:\") keeps its separator: C:\ProjectSettings\ProjectVersion.txt.
      const marker = path.join(parent, "ProjectSettings", "ProjectVersion.txt");
      try {
        if (fs.statSync(marker).isFile()) return null;
      } catch {
        // missing or unreadable: try the next Assets folder out
      }
      markers.push(marker);
    }
    if (parent === current) break;
    current = parent;
  }
  if (!markers.length) return outside;
  return `unity_dir is not inside a Unity project: ${folder}. ${markers[0]} does not exist (a Unity project has ProjectSettings\\ProjectVersion.txt beside its Assets folder)`;
}

// F-75: how skin overlays and a skin condition reach Unity in one export. Same set as INJURY_CHOICES in
// cc5-plugin/cc5_pipeline.py (a test compares them); there is no default.
export const INJURY_CHOICES = ["bake", "separate", "omit"] as const;
export type InjuryChoice = typeof INJURY_CHOICES[number];
/** Starts the export notes about injuries that did not reach the export (= INJURY_WARNING_PREFIX in cc5_pipeline.py). */
export const INJURY_WARNING_PREFIX = "WARNING: injuries not carried: ";

/**
 * X-2: starts the export note (cc5_api.py) when CC5's timeline, set to one frame for a mesh-only export (F-82), could
 * not be set back. The FBX is right; only the scene's timeline is wrong, so it is no export setting CC5 failed to
 * apply: replies show TIMELINE_USABLE_LINE (or TIMELINE_LEFT_LINE next to other problems) instead.
 */
export const TIMELINE_NOT_RESTORED_PREFIX = "WARNING: CC5 timeline not restored: ";
export const TIMELINE_LEFT_LINE = "CC5's timeline was left at one frame: set its length in Character Creator 5.";
export const TIMELINE_USABLE_LINE = `The FBX is usable; ${TIMELINE_LEFT_LINE}`;

/** The plugin's report of what an export did with the character's skin overlays and skin condition. */
export type InjuryReport = {
  choice: InjuryChoice | null;
  /** What the FBX itself does not carry. */
  not_carried: string[];
  /** What may not reach Unity (not checked yet, or CC5 could not read it). */
  unverified: string[];
  /** What was baked into the textures or written beside the FBX. */
  done: string[];
  /** What the choice could not do: such an export is not ready for Unity. */
  failed: string[];
  notes: string[];
  /** When the bake formula was fitted to CC5; null while it is not. */
  calibrated: string | null;
  /** The <character_name>_injuries.json written by 'separate'. */
  sidecar?: string;
};

/** How the injuries question ends for export_for_unity itself. */
export const EXPORT_AGAIN_WITH_INJURIES = "then call export_for_unity again with injuries";

/**
 * The question for the user when export_for_unity refused to export without an injuries choice. `again`: what to do
 * after the user chose (TS-4: a batch runs batch_generate_patients again instead).
 */
export function injuryQuestion(report?: InjuryReport, again = EXPORT_AGAIN_WITH_INJURIES): string {
  const listed = report ? [...report.not_carried, ...report.unverified].map((l) => `- ${l}`)
    : ["- (the CC5 plugin did not list them)"];
  const unchecked = report?.calibrated ? "" : " (the bake formula is not yet checked against CC5's look)";
  return [
    "Not exported: this character has skin overlays or a skin condition that an FBX cannot carry:",
    ...listed,
    `Ask the user how they should reach Unity for this character (there is no default), ${again}:`,
    `- 'bake': burned into this export's diffuse textures; Unity shows them with no extra setup, and they cannot be turned off there${unchecked}`,
    "- 'separate': the textures stay unchanged; the overlay images and <character_name>_injuries.json (strengths, skin-condition values) are written beside the FBX for a Unity material to blend",
    "- 'omit': exported without them; the Unity patient has no injuries or skin condition",
  ].join("\n");
}

/** What an export reply says about the injuries. Failed lines are left to the caller (the handler, a batch). */
export function injuryLines(report?: InjuryReport): string[] {
  if (!report) return ["The CC5 plugin did not report skin overlays or skin conditions (reinstall it): an FBX does not carry them."];
  const notes = report.notes.map((n) => `Note: ${n}`);
  if (![report.not_carried, report.unverified, report.done, report.failed].some((l) => l.length)) {
    return ["Skin overlays and skin condition: none on this character.", ...notes];
  }
  const items = (entries: string[]) => entries.map((l) => `- ${l}`);
  const lines: string[] = [];
  if (report.choice === "bake" && report.done.length) {
    lines.push("Baked into this export's diffuse textures:", ...items(report.done));
    if (!report.calibrated) lines.push("The bake formula has not been checked against CC5 yet: compare the Unity result with a CC5 capture.");
  } else if (report.choice === "separate" && report.done.length) {
    lines.push("Written beside the FBX for a Unity material to blend (the FBX itself carries none):", ...items(report.done));
  } else if (report.choice === "omit" && report.not_carried.length) {
    lines.push("Left out of this export, as asked (an FBX cannot carry them):", ...items(report.not_carried));
  } else if (report.choice === null && report.not_carried.length) {
    lines.push("Not in this FBX (an FBX cannot carry them):", ...items(report.not_carried));
  }
  if (report.choice === "separate" && report.sidecar) lines.push(`Sidecar: ${report.sidecar}`);
  return [...lines, ...report.unverified.map((l) => `Not verified to reach Unity: ${l}`), ...notes];
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

/** MD5 of a file, or null when it cannot be read. */
function md5(file: string): string | null {
  try {
    return crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Materials an export wrote several times with byte-identical textures (F-73), e.g. a uniform whose meshes each got
 * their own copy of one material: CC5 names the copies' textures <material>_<channel>_0001, _0002... Files are grouped
 * by folder and by their name without a trailing _NNNN: material = the name up to its last '_', channel = the rest. A
 * group counts when every channel has the same number n > 1 of files and each channel's files share one MD5; an
 * unreadable file rules its group out. Only the files of such candidate groups are hashed.
 */
export function identicalMaterialCopies(textures: TextureInfo[]):
  Array<{ folder: string; material: string; copies: number; channels: string[] }> {
  const groups = new Map<string, { folder: string; material: string; channels: Map<string, string[]> }>();
  for (const t of textures) {
    const stem = path.basename(t.path, path.extname(t.path)).replace(/_\d{4}$/, "");
    const cut = stem.lastIndexOf("_");
    if (cut <= 0 || cut === stem.length - 1) continue;
    const folder = path.dirname(t.path);
    const material = stem.slice(0, cut);
    const key = `${folder}\u0000${material}`;
    let group = groups.get(key);
    if (!group) {
      group = { folder, material, channels: new Map() };
      groups.set(key, group);
    }
    const channel = stem.slice(cut + 1);
    group.channels.set(channel, [...(group.channels.get(channel) ?? []), t.path]);
  }
  const out: Array<{ folder: string; material: string; copies: number; channels: string[] }> = [];
  for (const group of groups.values()) {
    const files = [...group.channels.values()];
    const copies = files[0].length;
    if (copies < 2 || files.some((f) => f.length !== copies)) continue;
    const identical = files.every((f) => {
      const first = md5(f[0]);
      return first !== null && f.slice(1).every((other) => md5(other) === first);
    });
    if (identical) out.push({ folder: group.folder, material: group.material, copies, channels: [...group.channels.keys()].sort() });
  }
  return out;
}

const TEARLINE_OR_OCCLUSION = /tear\s*line|eye\s*occlusion/i;

/**
 * The scene stats without the tear line and eye occlusion meshes, which export_for_unity's remove_tearline_occlusion
 * leaves out of the FBX (F-73; LIVE-VERIFY the mesh names with get_mesh_stats), and how many materials and triangles
 * they had.
 */
export function withoutTearlineOcclusion(stats: MeshStatsResult): { stats: MeshStatsResult; materials: number; triangles: number } {
  const meshes = stats.meshes ?? [];
  const removed = meshes.filter((m) => TEARLINE_OR_OCCLUSION.test(m.mesh));
  const sum = (count: (m: MeshStatsResult["meshes"][number]) => number) => removed.reduce((s, m) => s + count(m), 0);
  const materials = sum((m) => m.materials);
  const triangles = sum((m) => m.triangles ?? m.faces * 2);
  const totals: MeshStatsResult["totals"] = {
    ...stats.totals,
    vertices: stats.totals.vertices - sum((m) => m.vertices),
    faces: stats.totals.faces - sum((m) => m.faces),
    materials: stats.totals.materials - materials,
  };
  if (stats.totals.triangles !== undefined) totals.triangles = stats.totals.triangles - sum((m) => m.triangles ?? 0);
  return { stats: { ...stats, meshes: meshes.filter((m) => !TEARLINE_OR_OCCLUSION.test(m.mesh)), totals }, materials, triangles };
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
  if (stats.totals.materials > limits.maxMaterials) {
    // F-73: only when over budget, so the textures are hashed only when the hint can help.
    const groups = identicalMaterialCopies(textures);
    for (const g of groups) {
      lines.push(`     Hint: ${g.material} is exported ${g.copies} times with byte-identical textures (${g.channels.join(", ")}): merge these in Unity: the count would be ${stats.totals.materials - (g.copies - 1)}. Their CC5 settings can differ (e.g. glossiness), so check the look after the merge.`);
    }
    if (groups.length > 1) {
      lines.push(`     All merged: ${stats.totals.materials - groups.reduce((s, g) => s + g.copies - 1, 0)}`);
    }
  }
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

/**
 * F-86 (live CC5 5.13): an FBX export clears CC5's undo history, and undo still reports success afterwards. The last
 * line of the reply of every export whose result says so (undo_history_cleared).
 */
export const UNDO_HISTORY_CLEARED = "CC5 cleared its undo history with this export: changes made before it can no " +
  "longer be undone (save_character first to keep a way back).";

/** `text` with UNDO_HISTORY_CLEARED as its last line when the export result says CC5 cleared its undo history. */
export function withUndoHistoryLine(text: string, result?: { undo_history_cleared?: boolean }): string {
  return result?.undo_history_cleared ? `${text}\n${UNDO_HISTORY_CLEARED}` : text;
}

type ExportForUnityResult = {
  success: boolean; error?: string; fbx?: string; folder?: string; files?: Array<{ path: string; bytes: number }>;
  notes?: string[]; export_level?: number | null; needs_choice?: boolean; injuries?: InjuryReport;
  remove_tearline_occlusion?: boolean;
  /** F-86: the FBX export cleared CC5's undo history (passed through from export_fbx). */
  undo_history_cleared?: boolean;
};

export function registerUnityTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "export_for_unity",
    "Export the current character as FBX with CC5's Unity preset into <unity_dir>/<character_name>/. unity_dir must be inside the Assets folder of an existing Unity project (ProjectSettings\\ProjectVersion.txt beside Assets). Runs as a background job; an export that takes longer than wait_seconds (default 120) returns a job id for job_status. Skin overlays and skin conditions do not travel in an FBX: pass injuries as the user chose for this character (ask each time; there is no default); the reply always lists what the FBX does not carry. CC5 5.13 often crashes on the first FBX export after it starts: call save_character before the session's first FBX export, so the character is not lost.",
    {
      unity_dir: z.string().describe("Absolute folder inside a Unity project's Assets folder (the project has ProjectSettings\\ProjectVersion.txt)"),
      character_name: CHARACTER_NAME,
      sub_d_level: z.number().int().min(0).max(2).optional().describe("Subdivision level (0 = base mesh, best for Quest). It must not exceed the character's highest subdivision level (0 without HD data); higher values are refused."),
      texture_size: z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)]).optional(),
      include_current_pose: z.boolean().optional()
        .describe("Export the current pose. The FBX carries it as a one-frame animation clip, and Unity shows the imported model in that pose with a Generic or Humanoid rig. For a Humanoid rig, copy the avatar from an unposed export of the same character (Avatar Definition: Copy From Other Avatar)"),
      injuries: z.enum(INJURY_CHOICES).optional()
        .describe("How skin overlays (apply_skin_overlay, and diffuse_blend textures on any material) and a skin condition reach Unity in this export; an FBX cannot carry them. 'bake': burned into this export's diffuse textures. 'separate': the textures stay unchanged; the overlay images and <character_name>_injuries.json are written beside the FBX for a Unity material to blend. 'omit': left out. Ask the user for each character; there is no default."),
      remove_tearline_occlusion: z.boolean().optional()
        .describe("Leave the tear line and eye occlusion meshes out of the FBX (CC5's RemoveTearLineAndOcclusion): fewer materials for the Quest budget; the eyes lose their wet edge and soft shadow. Pass the same value to check_quest_budget."),
      wait_seconds: z.number().int().min(0).max(120).default(120),
    },
    async ({ unity_dir, character_name, sub_d_level, texture_size, include_current_pose, injuries, remove_tearline_occlusion, wait_seconds }) => {
      if (!isLocalAbsolute(unity_dir)) return errorResult("unity_dir must be a local absolute path without '..' (no network/UNC paths)");
      const folderError = unityFolderError(unity_dir);
      if (folderError) return errorResult(folderError);
      try {
        const out = await runJob(bridge, "export_for_unity", {
          unity_dir, character_name, sub_d_level, texture_size, include_current_pose,
          ...(injuries !== undefined ? { injuries } : {}),
          ...(remove_tearline_occlusion !== undefined ? { remove_tearline_occlusion } : {}),
        }, { waitMs: (wait_seconds ?? 120) * 1000 });
        if (!out.done) return pendingResult(out);
        const r = out.result as ExportForUnityResult;
        // Refused before anything was exported: the user has to choose how the injuries reach Unity.
        if (r.needs_choice) return errorResult(injuryQuestion(r.injuries));
        const warnings = warningNotes(r);
        const injuryNotes = warnings.filter((n) => n.startsWith(INJURY_WARNING_PREFIX));
        const otherNotes = warnings.filter((n) => !n.startsWith(INJURY_WARNING_PREFIX));
        if (out.failed || !r.success) {
          // A failed export shows the plugin's notes as they are, a timeline left at one frame among them.
          const noteText = otherNotes.length ? `\n${otherNotes.join("\n")}` : "";
          return errorResult(withUndoHistoryLine(`Unity export failed: ${r.error ?? "unknown error"}${noteText}`, r));
        }
        // X-2: a timeline CC5 could not set back after the export is no export setting it failed to apply.
        const timelineLeft = otherNotes.some((n) => n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
        const settingWarnings = otherNotes.filter((n) => !n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
        const warningText = settingWarnings.length ? `\n${settingWarnings.join("\n")}` : "";
        const level = r.export_level ?? 0;
        const subdivided = level > 0
          ? ` Exported at sub_d_level ${level}: if the character has HD data, the FBX has about ${4 ** level}x the base mesh's triangles, so give check_quest_budget sub_d_level ${level}.`
          : "";
        const posed = include_current_pose
          ? " The pose is a one-frame animation clip in the FBX, and Unity shows the imported model in that pose with a Generic or Humanoid rig."
            + " For a Humanoid rig, copy the avatar from an unposed export of the same character (Avatar Definition: Copy From Other Avatar):"
            + " an avatar created from the posed FBX comes out slightly different from the unposed one."
          : "";
        const exported = `Exported ${r.fbx} (${formatFiles(r.files ?? [])}).${subdivided}${posed}`;
        // The report's failed lines, else (a report without them) the injury WARNING notes themselves.
        const reported = r.injuries?.failed ?? [];
        const failedInjuries = reported.length ? reported : injuryNotes.map((n) => n.slice(INJURY_WARNING_PREFIX.length));
        const blocks: string[] = [];
        if (failedInjuries.length) {
          blocks.push(["The injuries did not all reach this export, so the Unity patient is missing:",
            ...failedInjuries.map((l) => `- ${l}`)].join("\n"));
        }
        if (settingWarnings.length) {
          blocks.push(`CC5 did not apply every export setting, so do not use this FBX until that is fixed:${warningText}`);
        }
        const lines = injuryLines(r.injuries);
        if (blocks.length) {
          const timeline = timelineLeft ? [TIMELINE_LEFT_LINE] : [];
          return errorResult(withUndoHistoryLine([exported, ...blocks, ...lines, ...timeline].join("\n"), r));
        }
        const parts = [`${exported} Switch to Unity to import it.`, ...lines];
        if (remove_tearline_occlusion) parts.push("Tear line and eye occlusion left out: pass remove_tearline_occlusion: true to check_quest_budget.");
        if (timelineLeft) parts.push(TIMELINE_USABLE_LINE);
        return { content: [{ type: "text" as const, text: withUndoHistoryLine(parts.join("\n"), r) }] };
      } catch (err) {
        return bridgeErrorResult(err);
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
      remove_tearline_occlusion: z.boolean().optional()
        .describe("Pass the value the export used: the tear line and eye occlusion are then left out of the counts"),
    },
    async ({ export_folder, sub_d_level, max_faces, max_materials, max_texture_px, max_texture_gpu_mb, remove_tearline_occlusion }) => {
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
        // F-73: the tear line and eye occlusion are left out only when the export left them out (a batch has no such
        // flag, so these lines live here only).
        const trimmed = withoutTearlineOcclusion(stats);
        const present = trimmed.stats.meshes.length < (stats.meshes ?? []).length;
        const counted = remove_tearline_occlusion ? trimmed.stats : stats;
        const { pass, lines } = evaluateExportBudget(counted, export_folder ? scanTextures(export_folder) : [], limits, level);
        let tearline: string | undefined;
        if (remove_tearline_occlusion) {
          tearline = present
            ? `     Tear line and eye occlusion left out of the export (remove_tearline_occlusion): ${trimmed.materials} materials and ${trimmed.triangles.toLocaleString("en-US")} triangles not counted`
            : "     remove_tearline_occlusion: no tear line or eye occlusion meshes in the scene stats, so nothing was subtracted";
        } else if (present && stats.totals.materials > limits.maxMaterials) {
          tearline = `     Hint: export_for_unity with remove_tearline_occlusion: true leaves out the tear line and eye occlusion (${trimmed.materials} materials); the eyes lose their wet edge and soft shadow. Pass the same flag here.`;
        }
        if (tearline) {
          const at = lines.findIndex((l) => /^(OK {2}|OVER) Materials:/.test(l));
          lines.splice(at < 0 ? lines.length : at + 1, 0, tearline);
        }
        const verdict = pass === undefined
          ? `NOT CHECKED — Quest budget: the triangles of a sub_d_level ${level} export cannot be counted from the scene (everything else is within budget)`
          : `${pass ? "PASS" : "FAIL"} — Quest budget`;
        return `${verdict}\n${lines.join("\n")}`;
      });
      return res.content[0].text.startsWith("FAIL") ? errorResult(res.content[0].text) : res;
    }
  );
}
