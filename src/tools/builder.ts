/**
 * Character-building tools: content search across categories, Headshot from a
 * photo, facial profiles, and whole-character recipes.
 */

import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isBrowseTruncation, type CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, errorResult, progressReporter } from "../util.js";
import { runJob, formatPending } from "../jobs.js";
import { checkFile } from "./pipeline.js";
import { isLocalAbsolute } from "./unity.js";
import { applyRecipe, formatReport, RecipeSchema } from "../recipe.js";
import { claimScene } from "../scene-lock.js";

export const SEARCH_FOLDERS = [
  "cloth", "cloth_upper", "cloth_lower", "shoes", "accessory_head", "character",
  "pose", "expression", "makeup_full", "makeup_foundation", "makeup_eye", "makeup_lip",
  "image_layer", "skingen", "texture",
];

/**
 * Content files whose names contain every word of `query`. CC5 filters by the query before its 200-file cap
 * (an older plugin ignores it and lists the first 200; the words are checked here as well). Folders that
 * failed go into `skipped`, and folders CC5 cut off at the cap into `truncated`.
 */
export async function searchContent(
  bridge: Pick<CC5Bridge, "browseContent">,
  query: string,
  folderTypes: string[],
  skipped?: string[],
  truncated?: string[],
): Promise<Array<{ folder: string; path: string }>> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: Array<{ folder: string; path: string }> = [];
  // Only rejected browseContent calls count here (e.g. CC5 down); in-list error strings are filtered below.
  const failures: string[] = [];
  for (const folder of folderTypes) {
    let files: string[];
    try {
      files = await bridge.browseContent(folder, query);
    } catch (e) {
      failures.push(`${folder}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const file of files) {
      if (isBrowseTruncation(file)) {
        truncated?.push(folder);
        continue;
      }
      // browse_content reports failures as a one-element list holding an error string
      // (same prefixes src/tools/content.ts filters); never treat those as file hits.
      if (/^(Unknown folder|No content folder|Content browsing|Error)/.test(file)) continue;
      const name = path.basename(file).toLowerCase();
      if (words.every((w) => name.includes(w))) hits.push({ folder, path: file });
    }
  }
  if (folderTypes.length > 0 && failures.length === folderTypes.length) {
    throw new Error(`browse_content failed for every folder (${failures[0]})`);
  }
  skipped?.push(...failures);
  return hits;
}

export function registerBuilderTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "search_content",
    "Search installed CC5 content (clothing, shoes, characters, poses, makeup, skin layers, textures) by keywords in the file name. Hair is not a searchable category. Load a hit with load_asset.",
    {
      query: z.string().min(1).max(200).describe("Keywords, e.g. 'camo jacket'"),
      folder_types: z.array(z.string()).optional().describe(`Categories to search (default: ${SEARCH_FOLDERS.join(", ")})`),
      limit: z.number().int().min(1).max(200).default(40),
    },
    async ({ query, folder_types, limit }) => {
      try {
        const skipped: string[] = [];
        const truncated: string[] = [];
        const hits = await searchContent(bridge, query, folder_types ?? SEARCH_FOLDERS, skipped, truncated);
        const note = (skipped.length ? `\n(skipped folders that failed: ${skipped.join("; ")})` : "") +
          (truncated.length ? `\n(search incomplete in ${truncated.join(", ")}: CC5 lists at most 200 matching files per category; use more specific words)` : "");
        if (!hits.length) return { content: [{ type: "text" as const, text: `No content matched '${query}'.${note}` }] };
        const lines = hits.slice(0, limit).map((h) => `[${h.folder}] ${h.path}`);
        return { content: [{ type: "text" as const, text: `${hits.length} match(es):\n${lines.join("\n")}${note}` }] };
      } catch (e) {
        return errorResult(`CC5 bridge error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "headshot_from_photo",
    "Generate the character's head from a front-facing photo (Headshot 3 plugin required). Takes a minute or more; returns a job id if still running.",
    { photo_path: z.string().describe("Absolute path to a .jpg/.png front-facing photo") },
    async ({ photo_path }) => {
      const err = checkFile(photo_path, [".jpg", ".jpeg", ".png"]);
      if (err) return errorResult(err);
      try {
        const out = await runJob(bridge, "headshot_from_photo", { photo_path }, { waitMs: 120_000 });
        if (!out.done) return { content: [{ type: "text" as const, text: formatPending(out.job_id) }] };
        const r = out.result as { success: boolean; error?: string; mode?: string };
        if (out.failed || !r.success) return errorResult(`Headshot failed: ${r.error ?? "unknown error"}`);
        return { content: [{ type: "text" as const, text: `Head generated from ${path.basename(photo_path)} (${r.mode})` }] };
      } catch (e) {
        return errorResult(`CC5 bridge error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  server.tool(
    "load_facial_profile",
    "Load a facial profile file (expression set) onto the character, e.g. a CC5 MetaHuman-compatible profile.",
    { file_path: z.string().describe("Absolute path to the facial profile file") },
    async ({ file_path }) => {
      if (!isLocalAbsolute(file_path)) return errorResult("file_path must be a local absolute path without '..' (no network/UNC paths)");
      return bridgeCall(() => bridge.loadFacialProfile(file_path),
        (r) => r.success ? `Loaded facial profile ${path.basename(file_path)}` : `Failed: ${r.error}`);
    }
  );

  server.tool(
    "apply_character_recipe",
    "Build or modify a character in one call from a recipe: base, headshot photo, body preset, morphs, skin colour and condition, facial profile, content assets (hair, clothes, shoes, accessories, makeup), textures, injury overlays, wrinkles, expression, pose. Every step is reported; a failed step does not stop the rest. Not while batch_generate_patients runs: both edit the same scene.",
    { recipe: RecipeSchema },
    async ({ recipe }, extra) => {
      const release = claimScene("apply_character_recipe");
      if (typeof release === "string") return errorResult(release);
      try {
        const report = progressReporter(extra);
        const results = await applyRecipe(bridge, recipe, {
          signal: extra?.signal, onStep: (s) => report(`${s.ok ? "OK" : "FAIL"} ${s.step}`),
        });
        const text = formatReport(results);
        if (extra?.signal?.aborted) return errorResult(`Cancelled: the remaining steps were not started.\n${text}`);
        return results.some((r) => !r.ok) ? errorResult(text) : { content: [{ type: "text" as const, text }] };
      } finally {
        release();
      }
    }
  );
}
