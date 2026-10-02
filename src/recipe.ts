/**
 * Declarative character recipe: one JSON object describing a whole character,
 * applied step by step. A failed step is recorded and the rest still run.
 */

import path from "node:path";
import { z } from "zod";
import type { CC5Bridge } from "./cc5-bridge.js";
import { BODY_PRESETS } from "./tools/character.js";
import { isLocalAbsolute } from "./tools/unity.js";
import { TEXTURE_CHANNELS } from "./tools/pipeline.js";
import { runJobStep } from "./jobs.js";

// Loads, the headshot and poses run as bridge jobs: a dressed .ccAvatar can take longer than the bridge's
// 30 s limit for direct calls, which would report the step failed while CC5 goes on to finish it.
export const BASE_LOAD_WAIT_MS = 300_000;
const STEP_JOB_WAIT_MS = 120_000;
const HEADSHOT_WAIT_MS = 180_000;

const rgb = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
const absPath = z.string().refine(isLocalAbsolute, "must be a local absolute path without '..' (no network/UNC paths)");

export const RecipeSchema = z.object({
  base: z.union([z.literal("default"), absPath]).optional()
    .describe("A .ccAvatar/.iAvatar path, best a textured character template from browse_content('character'); omit to modify the current character. 'default' loads CC5's neutral base, a mannequin with no skin or eye textures, eyebrows, eyelashes or hair. Setting it replaces any character already in the scene"),
  headshot_photo: absPath.optional(),
  body_preset: z.object({
    preset: z.enum(["athletic", "muscular", "slim", "heavy", "average"]),
    intensity: z.number().min(0).max(1).default(1),
  }).optional(),
  morphs: z.array(z.object({ morph_id: z.string(), value: z.number().min(-1).max(1) })).optional(),
  skin_rgb: rgb.optional(),
  skin_condition: z.object({
    condition: z.enum(["normal", "pale", "cyanotic", "flushed", "jaundiced"]),
    amount: z.number().min(0).max(1).default(1),
  }).optional(),
  facial_profile: absPath.optional(),
  assets: z.array(absPath).optional().describe("Hair, clothing, shoes, accessories, makeup content files (load_asset)"),
  textures: z.array(z.object({
    mesh_name: z.string(), material_name: z.string(),
    channel: z.enum(TEXTURE_CHANNELS),
    image_path: absPath,
  })).optional(),
  overlays: z.array(z.object({
    image_path: absPath,
    region: z.enum(["all", "head", "body", "arms", "legs"]).default("all"),
    strength: z.number().min(0).max(100).default(100),
  })).optional(),
  wrinkle_strength: z.number().min(0).max(1).optional(),
  expression: z.array(z.object({ name: z.string(), weight: z.number() })).optional(),
  pose_file: absPath.optional(),
});

export type Recipe = z.infer<typeof RecipeSchema>;
export interface StepResult { step: string; ok: boolean; detail: string }

type Outcome = { success?: boolean; error?: string };

export interface RecipeOptions {
  /** Aborted (e.g. the client cancelled the tool call): no further step starts and no further CC5 command is sent. */
  signal?: AbortSignal;
  /** Called after each step, e.g. to send a progress notification. */
  onStep?: (result: StepResult) => void;
}

/**
 * Apply a recipe step by step; a failed step is recorded and the rest still run. After `signal` aborts,
 * the remaining steps are skipped and the results so far are returned: the caller checks `signal.aborted`.
 */
export async function applyRecipe(bridge: CC5Bridge, recipe: Recipe, opts: RecipeOptions = {}): Promise<StepResult[]> {
  const { signal, onStep } = opts;
  const results: StepResult[] = [];
  const step = async (name: string, fn: () => Promise<Outcome>): Promise<void> => {
    if (signal?.aborted) return;
    let result: StepResult;
    try {
      const r = await fn();
      const ok = r.success !== false;
      result = { step: name, ok, detail: ok ? "" : r.error ?? "failed" };
    } catch (e) {
      if (signal?.aborted && e === signal.reason) return;  // cancelled before the step reached CC5
      result = { step: name, ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    results.push(result);
    onStep?.(result);
  };
  const jobOpts = (waitMs: number) => ({ waitMs, signal });

  const base = recipe.base;
  if (base) {
    // create_default_avatar and load_asset are additive, and every later step acts on
    // avatars[0], so clear the scene first or the edits land on the old character.
    await step("base", async () => {
      for (const a of (await bridge.getAvatars()) ?? []) {
        if (signal?.aborted) return { success: false, error: "cancelled before every old avatar was removed" };
        const d = await bridge.deleteAvatar(a.name);
        if (d?.success === false) {
          return { success: false, error: `could not remove existing avatar ${a.name}: ${d.error ?? "failed"}` };
        }
      }
      return base === "default"
        ? runJobStep(bridge, "create_default_avatar", {}, jobOpts(BASE_LOAD_WAIT_MS))
        : runJobStep(bridge, "load_asset", { file_path: base }, jobOpts(BASE_LOAD_WAIT_MS));
    });
  }
  const photo = recipe.headshot_photo;
  if (photo) {
    await step("headshot_photo",
      () => runJobStep(bridge, "headshot_from_photo", { photo_path: photo }, jobOpts(HEADSHOT_WAIT_MS)));
  }
  const preset = recipe.body_preset;
  if (preset) {
    await step("body_preset", () => bridge.setMultipleMorphs(BODY_PRESETS[preset.preset].map((m) => ({
      morph_id: m.morph_id, value: Math.max(-1, Math.min(1, m.value * preset.intensity)) }))));
  }
  const morphs = recipe.morphs;
  if (morphs?.length) await step("morphs", () => bridge.setMultipleMorphs(morphs));
  const skin = recipe.skin_rgb;
  if (skin) await step("skin_rgb", () => bridge.setSkinColor(skin[0], skin[1], skin[2]));
  const cond = recipe.skin_condition;
  // Pass skin_rgb as the base so the condition tints the chosen tone instead of overwriting it.
  if (cond) await step("skin_condition", () => bridge.setSkinCondition(cond.condition, cond.amount, "all", skin));
  const profile = recipe.facial_profile;
  if (profile) await step("facial_profile", () => bridge.loadFacialProfile(profile));
  for (const asset of recipe.assets ?? []) {
    await step(`asset ${path.basename(asset)}`,
      () => runJobStep(bridge, "load_asset", { file_path: asset }, jobOpts(STEP_JOB_WAIT_MS)));
  }
  for (const t of recipe.textures ?? []) {
    await step(`texture ${t.material_name}/${t.channel}`,
      () => bridge.loadTexture(t.mesh_name, t.material_name, t.channel, t.image_path));
  }
  for (const o of recipe.overlays ?? []) {
    await step(`overlay ${path.basename(o.image_path)}`, () => bridge.applySkinOverlay(o.image_path, o.region, o.strength));
  }
  const wrinkle = recipe.wrinkle_strength;
  if (wrinkle !== undefined) await step("wrinkle_strength", () => bridge.setWrinkleStrength(wrinkle));
  const expr = recipe.expression;
  if (expr?.length) await step("expression", () => bridge.setExpression(expr));
  const pose = recipe.pose_file;
  if (pose) {
    await step("pose_file", () => runJobStep(bridge, "apply_pose", { file_path: pose }, jobOpts(STEP_JOB_WAIT_MS)));
  }
  return results;
}

export function formatReport(results: StepResult[]): string {
  const failed = results.filter((r) => !r.ok);
  const head = failed.length
    ? `${failed.length} of ${results.length} steps failed.`
    : `All ${results.length} steps succeeded.`;
  const lines = results.map((r) => (r.ok ? `OK   ${r.step}` : `FAIL ${r.step}: ${r.detail}`));
  return `${head}\n${lines.join("\n")}`;
}
