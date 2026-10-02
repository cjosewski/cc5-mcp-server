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
import { errorResult } from "../util.js";
import { runJob } from "../jobs.js";
import { applyRecipe, RecipeSchema, type StepResult } from "../recipe.js";
import { CHARACTER_NAME, isInUnityAssets, isLocalAbsolute, evaluateBudget, scanTextures, QUEST_DEFAULTS } from "./unity.js";

export const BatchSchema = z.object({
  base_character: z.string().describe("Absolute path to a saved .ccAvatar base (see save_character)"),
  unity_dir: z.string().describe("Absolute folder inside a Unity project's Assets folder"),
  variants: z.array(z.object({ name: CHARACTER_NAME, recipe: RecipeSchema })).min(1).max(50),
  sub_d_level: z.number().int().min(0).max(2).default(0)
    .describe("Subdivision level of the exported FBX (0 = base mesh, best for Quest). Above 0 the face budget is not checked, because the scene stats count the base mesh"),
  texture_size: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).default(2048),
});
export type BatchInput = z.input<typeof BatchSchema>;

export type Manifest = {
  created: string;
  base: string;
  unity_dir: string;
  variants: Array<{ name: string; ok: boolean; steps: StepResult[]; fbx?: string; budget_pass?: boolean; budget?: string[]; error?: string }>;
};

export async function runBatch(bridge: CC5Bridge, input: BatchInput, writeManifest: (m: Manifest) => void): Promise<Manifest> {
  const parsed = BatchSchema.parse(input);
  const manifest: Manifest = { created: new Date().toISOString(), base: parsed.base_character, unity_dir: parsed.unity_dir, variants: [] };
  for (const v of parsed.variants) {
    const entry: Manifest["variants"][number] = { name: v.name, ok: false, steps: [] };
    try {
      // load_asset is additive and recipe steps act on avatars[0], so the scene must be empty first.
      for (const a of (await bridge.getAvatars()) ?? []) {
        const d = await bridge.deleteAvatar(a.name);
        if (d?.success === false) throw new Error(`could not remove existing avatar ${a.name}: ${d.error ?? "failed"}`);
      }
      const loaded = await bridge.loadAsset(parsed.base_character);
      if (loaded.success === false) throw new Error(`base load failed: ${loaded.error}`);
      entry.steps = await applyRecipe(bridge, v.recipe);
      const out = await runJob(bridge, "export_for_unity", {
        unity_dir: parsed.unity_dir, character_name: v.name,
        sub_d_level: parsed.sub_d_level, texture_size: parsed.texture_size,
        include_current_pose: Boolean(v.recipe.pose_file),
      }, { waitMs: 300_000 });
      if (!out.done) throw new Error(`export still running as job ${out.job_id}`);
      const r = out.result as { success: boolean; error?: string; fbx?: string; folder?: string };
      if (out.failed || !r.success) throw new Error(r.error ?? "export failed");
      entry.fbx = r.fbx;
      const stats = await bridge.getMeshStats();
      if (!stats.success) throw new Error(`mesh stats failed: ${stats.error ?? "unknown error"}`);
      const textures = r.folder && fs.existsSync(r.folder) ? scanTextures(r.folder) : [];
      const budget = evaluateBudget(stats, textures, QUEST_DEFAULTS);
      if (parsed.sub_d_level > 0) {
        // export_fbx subdivides only the FBX (RExportFbxSetting.SetExportLevel leaves the scene mesh at base level),
        // so getMeshStats counts base-mesh faces and cannot vouch for the export. Subdivision only adds faces and
        // leaves materials and textures alone, so a base-mesh fail still holds; a base-mesh pass proves nothing.
        const factor = 4 ** parsed.sub_d_level;
        const est = (stats.totals.faces * factor).toLocaleString("en-US");
        entry.budget_pass = budget.pass ? undefined : false;
        entry.budget = [
          `NOT CHECKED Faces: the FBX was exported at sub_d_level ${parsed.sub_d_level} (about ${factor}x the faces, roughly ${est}); the Faces line below counts the base scene mesh`,
          ...budget.lines,
        ];
      } else {
        entry.budget_pass = budget.pass;
        entry.budget = budget.lines;
      }
      entry.ok = entry.steps.every((s) => s.ok);
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
    }
    manifest.variants.push(entry);
    writeManifest(manifest);
  }
  return manifest;
}

export function registerBatchTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "batch_generate_patients",
    "Generate many patient variations from one saved base character: each variant applies a character recipe, exports to <unity_dir>/<name>/ and gets a Quest budget check. Writes patients_manifest.json in unity_dir after every variant. Save the base first with save_character.",
    BatchSchema.shape,
    async (input) => {
      if (!isLocalAbsolute(input.unity_dir) || !isInUnityAssets(input.unity_dir)) {
        return errorResult(`unity_dir must be a local absolute folder inside a Unity project's Assets folder: ${input.unity_dir}`);
      }
      if (!isLocalAbsolute(input.base_character) || path.extname(input.base_character).toLowerCase() !== ".ccavatar") return errorResult("base_character must be a local absolute .ccAvatar path (no network/UNC paths)");
      const manifestPath = path.join(input.unity_dir, "patients_manifest.json");
      fs.mkdirSync(input.unity_dir, { recursive: true });
      const m = await runBatch(bridge, input, (man) => fs.writeFileSync(manifestPath, JSON.stringify(man, null, 2)));
      const lines = m.variants.map((v) => `${v.ok ? "OK  " : "FAIL"} ${v.name}${v.error ? `: ${v.error}` : ""}${v.budget_pass === false ? " (over Quest budget)" : ""}${v.budget && v.budget_pass === undefined ? ` (face budget not checked: sub_d_level ${input.sub_d_level})` : ""}`);
      const failed = m.variants.filter((v) => !v.ok).length;
      const text = `${m.variants.length - failed}/${m.variants.length} variants exported. Manifest: ${manifestPath}\n${lines.join("\n")}`;
      return failed ? errorResult(text) : { content: [{ type: "text" as const, text }] };
    }
  );
}
