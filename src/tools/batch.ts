/**
 * Batch patient generation: for each variant, reload a saved base character,
 * apply a recipe, export to Unity, and record a budget check — writing the
 * manifest after every variant so finished work survives a crash.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { errorResult, progressReporter, warningNotes } from "../util.js";
import { runJob, runJobStep } from "../jobs.js";
import { applyRecipe, BASE_LOAD_WAIT_MS, RecipeSchema, type StepResult } from "../recipe.js";
import { claimScene } from "../scene-lock.js";
import { CHARACTER_NAME, isInUnityAssets, isLocalAbsolute, evaluateExportBudget, scanTextures, QUEST_DEFAULTS } from "./unity.js";

const EXPORT_WAIT_MS = 300_000;

// Each variant exports to <unity_dir>/<name>/, and Windows folder names ignore case.
const uniqueNames = (variants: Array<{ name: string }>) =>
  new Set(variants.map((v) => v.name.toLowerCase())).size === variants.length;

export const BatchSchema = z.object({
  base_character: z.string().describe("Absolute path to a saved .ccAvatar base (see save_character)"),
  unity_dir: z.string().describe("Absolute folder inside a Unity project's Assets folder"),
  variants: z.array(z.object({ name: CHARACTER_NAME, recipe: RecipeSchema })).min(1).max(50)
    .refine(uniqueNames, "Variant names must be unique, ignoring case: each variant exports to <unity_dir>/<name>/"),
  sub_d_level: z.number().int().min(0).max(2).default(0)
    .describe("Subdivision level of the exported FBX (0 = base mesh, best for Quest). Above 0 the triangle budget is not checked, because the scene stats count the base mesh"),
  texture_size: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).default(2048),
});
export type BatchInput = z.input<typeof BatchSchema>;

export type Manifest = {
  created: string;
  base: string;
  unity_dir: string;
  /** Set when the client cancelled the run: says which variants never started. */
  cancelled?: string;
  variants: Array<{
    name: string; ok: boolean; steps: StepResult[]; fbx?: string; budget_pass?: boolean; budget?: string[];
    /** WARNING notes from the export: settings CC5 did not apply. Such a variant is not ok. */
    notes?: string[];
    error?: string;
  }>;
};

export interface BatchOptions {
  /** Aborted when the client cancels the tool call: the batch then sends CC5 nothing more and stops. */
  signal?: AbortSignal;
  /** Called after every recipe step and variant, e.g. to send a progress notification. */
  onProgress?: (message: string) => void;
}

export async function runBatch(bridge: CC5Bridge, input: BatchInput, writeManifest: (m: Manifest) => void,
  opts: BatchOptions = {}): Promise<Manifest> {
  const { signal, onProgress } = opts;
  const parsed = BatchSchema.parse(input);
  const manifest: Manifest = { created: new Date().toISOString(), base: parsed.base_character, unity_dir: parsed.unity_dir, variants: [] };
  const cancelBefore = (index: number) => {
    const notStarted = parsed.variants.slice(index).map((v) => v.name);
    manifest.cancelled = `Cancelled by the client. ${notStarted.length ? `Not started: ${notStarted.join(", ")}` : "Every variant was started"}.`;
  };
  for (const [index, v] of parsed.variants.entries()) {
    if (signal?.aborted) {
      cancelBefore(index);
      writeManifest(manifest);
      break;
    }
    const label = `${v.name} (${index + 1}/${parsed.variants.length})`;
    const entry: Manifest["variants"][number] = { name: v.name, ok: false, steps: [] };
    try {
      // load_asset is additive and recipe steps act on avatars[0], so the scene must be empty first.
      for (const a of (await bridge.getAvatars()) ?? []) {
        signal?.throwIfAborted();
        const d = await bridge.deleteAvatar(a.name);
        if (d?.success === false) throw new Error(`could not remove existing avatar ${a.name}: ${d.error ?? "failed"}`);
      }
      // A job, not a direct call: a dressed base can take longer than the bridge's 30 s limit for direct calls.
      const loaded = await runJobStep(bridge, "load_asset", { file_path: parsed.base_character }, { waitMs: BASE_LOAD_WAIT_MS, signal });
      if (loaded.success === false) throw new Error(`base load failed: ${loaded.error}`);
      entry.steps = await applyRecipe(bridge, v.recipe, {
        signal, onStep: (s) => onProgress?.(`${label}: ${s.ok ? "OK" : "FAIL"} ${s.step}`),
      });
      signal?.throwIfAborted();
      const out = await runJob(bridge, "export_for_unity", {
        unity_dir: parsed.unity_dir, character_name: v.name,
        sub_d_level: parsed.sub_d_level, texture_size: parsed.texture_size,
        include_current_pose: Boolean(v.recipe.pose_file),
      }, { waitMs: EXPORT_WAIT_MS, signal });
      if (!out.done) throw new Error(`export still running in CC5 as job ${out.job_id}`);
      const r = out.result as { success: boolean; error?: string; fbx?: string; folder?: string; notes?: string[] };
      const warnings = warningNotes(r);
      if (warnings.length) entry.notes = warnings;
      if (out.failed || !r.success) throw new Error(r.error ?? "export failed");
      entry.fbx = r.fbx;
      signal?.throwIfAborted();
      const stats = await bridge.getMeshStats();
      if (!stats.success) throw new Error(`mesh stats failed: ${stats.error ?? "unknown error"}`);
      const textures = r.folder && fs.existsSync(r.folder) ? scanTextures(r.folder) : [];
      const budget = evaluateExportBudget(stats, textures, QUEST_DEFAULTS, parsed.sub_d_level);
      entry.budget_pass = budget.pass;
      entry.budget = budget.lines;
      entry.ok = entry.steps.every((s) => s.ok) && !warnings.length;
      if (warnings.length) entry.error = `exported without some of its settings: ${warnings.join("; ")}`;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      entry.error = signal?.aborted
        ? `cancelled before this variant finished${e === signal.reason ? "" : ` (${message})`}`
        : message;
    }
    if (signal?.aborted) cancelBefore(index + 1);
    manifest.variants.push(entry);
    writeManifest(manifest);
    onProgress?.(`${label}: ${entry.ok ? "done" : "FAILED"}`);
    if (signal?.aborted) break;
  }
  return manifest;
}

export function registerBatchTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "batch_generate_patients",
    "Generate many patient variations from one saved base character: each variant applies a character recipe, exports to <unity_dir>/<name>/ and gets a Quest budget check. Writes patients_manifest.json in unity_dir after every variant. Save the base first with save_character. One batch or recipe runs at a time; cancelling stops the batch before its next CC5 command.",
    BatchSchema.shape,
    async (rawInput, extra) => {
      const checked = BatchSchema.safeParse(rawInput);
      if (!checked.success) return errorResult(`Invalid batch: ${checked.error.issues.map((i) => i.message).join("; ")}`);
      const input = checked.data;
      if (!isLocalAbsolute(input.unity_dir) || !isInUnityAssets(input.unity_dir)) {
        return errorResult(`unity_dir must be a local absolute folder inside a Unity project's Assets folder: ${input.unity_dir}`);
      }
      if (!isLocalAbsolute(input.base_character) || path.extname(input.base_character).toLowerCase() !== ".ccavatar") return errorResult("base_character must be a local absolute .ccAvatar path (no network/UNC paths)");
      const manifestPath = path.join(input.unity_dir, "patients_manifest.json");
      const release = claimScene(`batch_generate_patients (progress in ${manifestPath})`);
      if (typeof release === "string") return errorResult(release);
      try {
        fs.mkdirSync(input.unity_dir, { recursive: true });
        const m = await runBatch(bridge, input, (man) => fs.writeFileSync(manifestPath, JSON.stringify(man, null, 2)),
          { signal: extra?.signal, onProgress: progressReporter(extra) });
        const lines = m.variants.map((v) => `${v.ok ? "OK  " : "FAIL"} ${v.name}${v.error ? `: ${v.error}` : ""}${v.budget_pass === false ? " (over Quest budget)" : ""}${v.budget && v.budget_pass === undefined ? ` (triangle budget not checked: sub_d_level ${input.sub_d_level})` : ""}`);
        const failed = m.variants.filter((v) => !v.ok).length;
        const head = `${m.variants.length - failed}/${m.variants.length} variants exported. Manifest: ${manifestPath}`;
        const text = `${m.cancelled ? `${m.cancelled}\n` : ""}${head}\n${lines.join("\n")}`;
        return failed || m.cancelled ? errorResult(text) : { content: [{ type: "text" as const, text }] };
      } finally {
        release();
      }
    }
  );
}
