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
import { runJob } from "./jobs.js";

const rgb = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
const absPath = z.string().refine(isLocalAbsolute, "must be a local absolute path without '..' (no network/UNC paths)");

export const RecipeSchema = z.object({
  base: z.union([z.literal("default"), absPath]).optional()
    .describe("'default' for a new base character, or a .ccAvatar/.iAvatar path; omit to modify the current one. Setting it replaces any character already in the scene"),
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

async function step(results: StepResult[], name: string, fn: () => Promise<Outcome>): Promise<void> {
  try {
    const r = await fn();
    const ok = r.success !== false;
    results.push({ step: name, ok, detail: ok ? "" : r.error ?? "failed" });
  } catch (e) {
    results.push({ step: name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

export async function applyRecipe(bridge: CC5Bridge, recipe: Recipe): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const base = recipe.base;
  if (base) {
    // create_default_avatar and load_asset are additive, and every later step acts on
    // avatars[0], so clear the scene first or the edits land on the old character.
    await step(results, "base", async () => {
      for (const a of (await bridge.getAvatars()) ?? []) {
        const d = await bridge.deleteAvatar(a.name);
        if (d?.success === false) {
          return { success: false, error: `could not remove existing avatar ${a.name}: ${d.error ?? "failed"}` };
        }
      }
      return base === "default" ? bridge.createDefaultAvatar() : bridge.loadAsset(base);
    });
  }
  const photo = recipe.headshot_photo;
  if (photo) {
    await step(results, "headshot_photo", async () => {
      const out = await runJob(bridge, "headshot_from_photo", { photo_path: photo }, { waitMs: 180_000 });
      if (!out.done) return { success: false, error: `still running as job ${out.job_id}` };
      return out.result as Outcome;
    });
  }
  const preset = recipe.body_preset;
  if (preset) {
    await step(results, "body_preset", () => bridge.setMultipleMorphs(BODY_PRESETS[preset.preset].map((m) => ({
      morph_id: m.morph_id, value: Math.max(-1, Math.min(1, m.value * preset.intensity)) }))));
  }
  const morphs = recipe.morphs;
  if (morphs?.length) await step(results, "morphs", () => bridge.setMultipleMorphs(morphs));
  const skin = recipe.skin_rgb;
  if (skin) await step(results, "skin_rgb", () => bridge.setSkinColor(skin[0], skin[1], skin[2]));
  const cond = recipe.skin_condition;
  // Pass skin_rgb as the base so the condition tints the chosen tone instead of overwriting it.
  if (cond) await step(results, "skin_condition", () => bridge.setSkinCondition(cond.condition, cond.amount, "all", skin));
  const profile = recipe.facial_profile;
  if (profile) await step(results, "facial_profile", () => bridge.loadFacialProfile(profile));
  for (const asset of recipe.assets ?? []) {
    await step(results, `asset ${path.basename(asset)}`, () => bridge.loadAsset(asset));
  }
  for (const t of recipe.textures ?? []) {
    await step(results, `texture ${t.material_name}/${t.channel}`,
      () => bridge.loadTexture(t.mesh_name, t.material_name, t.channel, t.image_path));
  }
  for (const o of recipe.overlays ?? []) {
    await step(results, `overlay ${path.basename(o.image_path)}`, () => bridge.applySkinOverlay(o.image_path, o.region, o.strength));
  }
  const wrinkle = recipe.wrinkle_strength;
  if (wrinkle !== undefined) await step(results, "wrinkle_strength", () => bridge.setWrinkleStrength(wrinkle));
  const expr = recipe.expression;
  if (expr?.length) await step(results, "expression", () => bridge.setExpression(expr));
  const pose = recipe.pose_file;
  if (pose) await step(results, "pose_file", () => bridge.applyPose(pose));
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
