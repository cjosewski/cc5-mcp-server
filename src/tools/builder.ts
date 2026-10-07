/**
 * Character-building tools: content search across categories, facial profiles,
 * whole-character recipes, and the switched-off Headshot from a photo.
 *
 * A recipe that meets a CC5 question nobody has answered stops there (D1): its report shows the question and the
 * continue_after call that finishes the stopped step and runs the rest after the answer. A recipe does not start
 * while a CC5 window is open. CC5's "Replace / Material Only" has no standing answer (D3): the user's button,
 * passed as layer_answer with continue_after, answers the identical question for the rest of that recipe only. A step
 * whose question was answered Cancel is reported CANCELLED, never OK (F-98).
 */

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BridgeHttpError, BridgeUnreachableError, isBrowseTruncation, type CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall, bridgeErrorResult, errorResult, progressReporter, type ToolResult } from "../util.js";
import { isLocalAbsolute } from "./unity.js";
import { formatDialog } from "./dialog.js";
import {
  applyRecipe, checkRecipeFiles, formatReport, recipeStepCount, remainingRecipe, stepFromJob, supersedeChecks, waitKind,
  RecipeSchema, HEADSHOT_DISABLED, type Recipe, type RecipeStopData, type StepResult, type WaitKind,
} from "../recipe.js";
import { claimScene } from "../scene-lock.js";
import { awaitJob, lostJobMessage, type JobOutcome } from "../jobs.js";
import {
  carryLayerAnswer, currentStop, findStop, finishBuild, layerDialogHandler, openDialog, recordStop, startBuild,
  LAYER_ANSWERS, STOP_ID_PATTERN, type Build,
} from "../build-session.js";
import { CANCEL_NOT_CARRIED, NOT_A_CHECK, PICK_RULE, STORE_HINT, STORE_RULE } from "../prompts/content-rules.js";

export const SEARCH_FOLDERS = [
  "cloth", "cloth_upper", "cloth_lower", "underwear", "gloves", "cloth_other", "shoes",
  "accessory_head", "accessory_body", "accessory_other", "character",
  "pose", "expression", "makeup_full", "makeup_foundation", "makeup_eye", "makeup_lip",
  "image_layer", "skingen", "texture", "hair", "eye",
];

/**
 * Every category browse_content takes (cc5_api.browse_content's keys; a test compares them): the categories
 * search_content searches by default plus motion, props, light, camera and wrinkle_mask.
 */
export const BROWSE_FOLDERS = [
  "cloth_upper", "cloth_lower", "cloth", "underwear", "gloves", "cloth_other", "shoes",
  "accessory_head", "accessory_body", "accessory_other",
  "pose", "motion", "expression", "props", "light", "camera", "character",
  "makeup_full", "makeup_foundation", "makeup_eye", "makeup_lip",
  "image_layer", "skingen", "wrinkle_mask", "texture", "hair", "eye",
] as const;

/**
 * browse_content's answer for a category it could not list: a one-element list holding an error string
 * (cc5_api.browse_content: an unknown category with the 'Available: ...' list, no folder resolved, no content
 * browsing in this CC5, or an error). Never a file.
 */
export function isBrowseError(entry: string): boolean {
  return /^(Unknown folder|No content folder|Content browsing|Error)/.test(entry);
}

/**
 * TS-1: every folder search_content was asked to search failed, at least one with CC5's own answer for it: nothing
 * was searched. The message names each folder with what CC5 said (an unknown category keeps its 'Available: ...').
 */
export class NothingSearchedError extends Error {
  constructor(readonly failures: string[]) {
    super(`Nothing was searched: no folder could be listed (${failures.join("; ")})`);
    this.name = "NothingSearchedError";
  }
}

/**
 * Content files whose names contain every word of `query`. CC5 filters by the query before its 200-file cap
 * (an older plugin ignores it and lists the first 200; the words are checked here as well). Folders that
 * failed (a rejected call, or CC5's error answer for that folder) go into `skipped`, and folders CC5 cut off at
 * the cap into `truncated`. When every folder failed it throws: a NothingSearchedError when CC5 answered for at
 * least one of them, else an Error naming them.
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
  const failures: string[] = [];
  const failed = new Set<string>();
  let answered = false;  // CC5 answered at least one failed folder with its own error text
  for (const folder of folderTypes) {
    let files: string[];
    try {
      files = await bridge.browseContent(folder, query);
    } catch (e) {
      // CC5 down or not answering, or a reply that holds for every folder (browse_content never refuses one folder
      // with a 400: that is the open-dialog guard, 5 s per folder; 409/504 are a dialog wait and a timeout): stop
      // here, unwrapped, so the caller's error says what happened.
      if (e instanceof BridgeUnreachableError || (e instanceof BridgeHttpError && [400, 409, 504].includes(e.status))) {
        throw e;
      }
      failures.push(`${folder}: ${e instanceof Error ? e.message : String(e)}`);
      failed.add(folder);
      continue;
    }
    for (const file of files) {
      if (isBrowseTruncation(file)) {
        truncated?.push(folder);
        continue;
      }
      // TS-1: CC5's error answer for this folder is that folder's failure, never a silent skip (nor a file hit).
      if (isBrowseError(file)) {
        failures.push(`${folder}: ${file}`);
        failed.add(folder);
        answered = true;
        continue;
      }
      const name = path.basename(file).toLowerCase();
      if (words.every((w) => name.includes(w))) hits.push({ folder, path: file });
    }
  }
  if (!hits.length && folderTypes.length > 0 && [...new Set(folderTypes)].every((f) => failed.has(f))) {
    if (answered) throw new NothingSearchedError(failures);
    throw new Error(`browse_content failed for every folder (${failures.join("; ")})`);
  }
  skipped?.push(...failures);
  return hits;
}

const SEARCH_DESCRIPTION =
  "Search installed CC5 content (CC5's templates and the user's own content from CC5's Custom tab, 'Reallusion " +
  "Custom') by keywords in the file name: clothing, shoes, hairstyles, eye presets, accessories, characters, poses, " +
  "makeup, skin layers, textures. Load a hit with load_asset. If no hit fits, try other words or browse_content. " +
  PICK_RULE + " " + STORE_RULE;

const APPLY =
  "Build or modify a character in one call from a recipe. Steps run in this order: base, body preset, morphs, facial " +
  "profile, skin, makeup and eye presets and hairstyles (from assets), skin colour, skin condition, textures, injury " +
  "overlays, clothing, shoes, accessories and other assets, wrinkle strength, expression, pose. Use a recipe for body " +
  "and face; load presets, hair and clothing one at a time with load_asset, showing each with captures and an undo " +
  "offer before the next. Every step is reported, and every content load is compared before and after (CHECK and " +
  "NOT CHECKED lines). A failed step does not stop the rest. A CC5 question stops the recipe: nothing after it is " +
  "sent to CC5 until it is answered, and the report gives the question and the continue_after call to go on. " +
  "Replace / Material Only has no standing answer: after the user picked a button, pass it as layer_answer with " +
  "continue_after; it answers the same question for the rest of this recipe only. A base file that does not exist is " +
  "refused before anything changes. Not while batch_generate_patients runs: both edit the same scene.";

// BUILD_RULE and FIT_RULE stay out: with them the description would pass 2,000 characters. They reach the agent
// through the server instructions, load_asset and the stop reports.
const APPLY_DESCRIPTION = `${APPLY} ${PICK_RULE} ${NOT_A_CHECK}`;

const LAYER_WITHOUT_CONTINUE =
  "layer_answer only goes on after a recipe stopped on CC5's 'Replace / Material Only' question (with " +
  "continue_after). There is no standing answer: run the recipe without it; if CC5 asks, the recipe stops and the " +
  "question goes to the user. Nothing was sent to CC5.";

const TOOL_FOR: Record<Build["kind"], string> = { recipe: "apply_character_recipe", batch: "batch_generate_patients" };

type RunContext = { bridge: CC5Bridge; signal?: AbortSignal; report: (message: string) => void };

const progressLine = (s: StepResult): string =>
  `${s.stopped ? "WAIT" : s.cancelled ? "CANCELLED" : s.ok ? "OK" : "FAIL"} ${s.step}`;

/**
 * What a run stopped on, and when it goes on, for a new recipe's note (F-94: a window with no buttons is closed, not
 * answered; F-99: one whose buttons the bridge cannot read is answered or closed in CC5; review #8: a question whose
 * text could not be read is still a question, which the user answers in CC5).
 */
const STOPPED_ON: Record<WaitKind, [string, string]> = {
  question: ["question", "after the answer"],
  unread: ["question", "after the answer"],
  close: ["window", "once it is closed"],
  unreadable: ["window", "once it is answered or closed"],
};

/**
 * What continue_after asks for first while the stopped job still waits in its window: answer_cc5_dialog can click
 * neither a window with no buttons (F-94) nor one whose buttons the bridge cannot read (F-99), and it refuses a question
 * whose text could not be read (review #8), which the user answers in CC5.
 */
const FIRST: Record<WaitKind, string> = {
  question: "Answer it first",
  unread: "Ask the user to answer it in CC5 first",
  close: "Answer or close it first",
  unreadable: "Answer or close it first",
};

/**
 * The reply once a recipe (or a continuation's segment) has run: a stop is recorded so continue_after can finish it,
 * else the run is over. `all` is the whole recipe's results; `segment` the results of `segmentRecipe` in this call.
 */
function finishRecipe(
  ctx: RunContext, build: Build, all: StepResult[], segmentRecipe: Recipe, segment: StepResult[], prefix: string,
): ToolResult {
  const last = segment[segment.length - 1];
  if (last?.stopped) {
    const st = last.stopped;
    const remaining = remainingRecipe(segmentRecipe, segment);
    const data: RecipeStopData = { results: all, remaining };
    const stop = recordStop(build, {
      step: last.step,
      ran: st.ran,
      ...(st.job_id ? { jobId: st.job_id } : {}),
      ...(st.question ? { question: st.question } : {}),
      ...(st.blocked_by ? { blockedBy: st.blocked_by } : {}),
      text: last.detail,
      waitMs: st.wait_ms,
      ...(st.asset ? { asset: st.asset } : {}),
      ...(st.answered ? { answered: st.answered } : {}),
      data,
    });
    return errorResult(prefix + formatReport(all, { id: stop.id, remaining, layer: stop.layer }));
  }
  finishBuild(build);
  const text = prefix + formatReport(all);
  if (ctx.signal?.aborted) return errorResult(`Cancelled: the remaining steps were not started.\n${text}`);
  return all.some((r) => !r.ok) ? errorResult(text) : { content: [{ type: "text" as const, text }] };
}

/** A new recipe: refused while CC5 has a window open. A stop the last run left can no longer be continued after it. */
async function runNewRecipe(ctx: RunContext, recipe: Recipe): Promise<ToolResult> {
  const d = await openDialog(ctx.bridge);
  if (d?.dialog) {
    let text = formatDialog(d.dialog, d.waiting_job) + (d.dialog.progress
      ? "\nNothing was sent to CC5: run the recipe again when it closes."
      : "\nNothing was sent to CC5: answer or close it first, then run the recipe again.");
    const pending = currentStop();
    if (pending?.jobId && pending.jobId === d.waiting_job) {
      const [what, when] = STOPPED_ON[waitKind(d.dialog)];
      text += `\nThe last ${pending.kind} stopped on this ${what} at ${pending.step}: ${when}, go on with ` +
        `${TOOL_FOR[pending.kind]} continue_after "${pending.id}".`;
    }
    return errorResult(text);
  }
  const build = startBuild("recipe");
  const replaced = build.replaced;
  const prefix = replaced
    ? `Note: the ${replaced.kind} that stopped at ${replaced.step} (continue_after "${replaced.id}") was not ` +
      "continued; it can no longer be continued.\n"
    : "";
  const results = await applyRecipe(ctx.bridge, recipe, { signal: ctx.signal, onStep: (s) => ctx.report(progressLine(s)) });
  return finishRecipe(ctx, build, results, recipe, results, prefix);
}

/**
 * continue_after: wait for the stopped step's job (answering the run's layer_answer on the way), then run the
 * remaining recipe. The report covers the whole recipe. Every refusal keeps the stop, except a job CC5 lost.
 */
async function continueRecipe(ctx: RunContext, id: string, recipe: Recipe, layerAnswer?: string): Promise<ToolResult> {
  const found = findStop("recipe", id);
  if (!found) {
    return errorResult(`continue_after ${id} is not where the last recipe stopped (or the MCP server restarted): ` +
      "run the remaining steps as a new recipe. Nothing was sent to CC5.");
  }
  const { build, stop } = found;
  const data = stop.data as RecipeStopData;
  // Only the remaining recipe (or none): the original recipe would run its base again and delete the half-built character.
  if (Object.keys(recipe).length > 0 && !isDeepStrictEqual(recipe, data.remaining)) {
    return errorResult(`continue_after ${id} goes on with the remaining recipe its report gave. Pass that recipe ` +
      `(or an empty one): ${JSON.stringify(data.remaining)}. Nothing was sent to CC5.`);
  }
  if (layerAnswer !== undefined) {
    const refusal = carryLayerAnswer(build, stop, layerAnswer);
    if (refusal) return errorResult(refusal);
  }
  const d = await openDialog(ctx.bridge, { allowJob: stop.jobId });
  if (d?.dialog) {
    return errorResult(formatDialog(d.dialog, d.waiting_job) + (d.dialog.progress
      ? `\nNothing was sent to CC5: call apply_character_recipe with continue_after "${id}" again when CC5 has ` +
        "finished; the progress window closes by itself."
      : `\nNothing was sent to CC5: answer or close it first, then call apply_character_recipe with continue_after "${id}" again.`));
  }
  let after: StepResult | undefined;
  if (stop.jobId) {
    let out: JobOutcome;
    try {
      out = await awaitJob(ctx.bridge, stop.jobId, {
        waitMs: stop.waitMs, signal: ctx.signal, onDialog: layerDialogHandler(ctx.bridge, build.layerAnswer),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === lostJobMessage(stop.jobId)) {
        finishBuild(build);
        return errorResult(`${message} The recipe that stopped at ${stop.step} cannot be continued: check the scene ` +
          `(list_avatars, capture_viewport), then run the remaining steps as a new recipe: ${JSON.stringify(data.remaining)}.`);
      }
      return bridgeErrorResult(err);
    }
    // RB-3: a button this wait clicked stays with the stop: the retry's wait reads a job that names no button any more.
    if (out.answered !== undefined) stop.answered = out.answered;
    if (!out.done) {
      if (ctx.signal?.aborted) {
        return errorResult(`Cancelled while waiting for ${stop.step} to finish; nothing else was sent to CC5. Call ` +
          `apply_character_recipe with continue_after "${id}" again to go on.`);
      }
      if (out.dialog) {
        return errorResult(`${out.dialog}\n${FIRST[waitKind(out.question)]}, then call apply_character_recipe with ` +
          `continue_after "${id}" again. Nothing else was sent to CC5.`);
      }
      return errorResult(`${stop.step} is still running in CC5 (job ${stop.jobId}). Call apply_character_recipe with ` +
        `continue_after "${id}" again in a moment; nothing else was sent to CC5.`);
    }
    // F-98: the job's answers say whether CC5 was answered Cancel (stepFromJob reports that step CANCELLED).
    if (stop.ran) after = stepFromJob(`${stop.step} (after the answer)`, out, stop.asset, stop.answered);
  } else if (stop.ran) {
    after = {
      step: `${stop.step} (after the answer)`, ok: false,
      detail: "its job id is unknown: check the scene (list_clothes, capture_viewport) before relying on it",
    };
  }
  build.stop = undefined;
  const segment = await applyRecipe(ctx.bridge, data.remaining, {
    signal: ctx.signal, onStep: (s) => ctx.report(progressLine(s)), layerAnswer: build.layerAnswer,
  });
  // F-92: what the stopped step's commands noted (the base step's delete_avatar notes) stays with that step: with the
  // step that finished after the answer, or with the step run again when it never ran.
  const carried = data.results[data.results.length - 1]?.notes;
  const again = stop.ran ? after : segment[0]?.step === stop.step ? segment[0] : undefined;
  if (carried?.length && again) again.notes = [...new Set([...carried, ...(again.notes ?? [])])];
  const all = supersedeChecks([...data.results.slice(0, -1), ...(after ? [after] : []), ...segment]);
  const prefix = `Continued after the answer (continue_after "${id}"): this report covers the whole recipe.\n`;
  return finishRecipe(ctx, build, all, data.remaining, segment, prefix);
}

export function registerBuilderTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "search_content",
    SEARCH_DESCRIPTION,
    {
      query: z.string().min(1).max(200).describe("Keywords, e.g. 'camo jacket'"),
      folder_types: z.array(z.enum(BROWSE_FOLDERS)).min(1).optional()
        .describe(`Categories to search, at least one (default: ${SEARCH_FOLDERS.join(", ")}); browse_content's motion, props, light, camera and wrinkle_mask can be named too`),
      limit: z.number().int().min(1).max(200).default(40),
    },
    async ({ query, folder_types, limit }) => {
      try {
        const skipped: string[] = [];
        const truncated: string[] = [];
        const hits = await searchContent(bridge, query, folder_types ?? SEARCH_FOLDERS, skipped, truncated);
        const note = (skipped.length ? `\n(skipped folders that failed: ${skipped.join("; ")})` : "") +
          (truncated.length ? `\n(search incomplete in ${truncated.join(", ")}: CC5 lists at most 200 matching files per category; use more specific words)` : "");
        if (!hits.length) {
          // Not an error: the search worked and found nothing, and the next step is other words or the store (I-02).
          return { content: [{ type: "text" as const, text: `No content matched '${query}' in the installed content ` +
            `(CC5's templates and the user's Custom content). Try other words or browse_content. ${STORE_HINT}${note}` }] };
        }
        // I-07: Lite Hair hairstyles are labelled and come after the other hairstyles, so the hits shown are full
        // quality first; hits of other categories keep their places. content.ts imports this module, so its helpers
        // are imported when the tool runs, not while the modules load (no import cycle).
        const { liteHairLabel, liteHairLast } = await import("./content.js");
        const lines = liteHairLast(hits, (h) => (h.folder === "hair" ? h.path : undefined)).slice(0, limit)
          .map((h) => `[${h.folder}] ${h.path}${h.folder === "hair" ? liteHairLabel(h.path) : ""}`);
        return { content: [{ type: "text" as const, text: `${hits.length} match(es):\n${lines.join("\n")}${note}` }] };
      } catch (e) {
        // TS-1: CC5 could list none of the folders; its own answer says why (no store hint: nothing was searched).
        if (e instanceof NothingSearchedError) return errorResult(e.message);
        return bridgeErrorResult(e);
      }
    }
  );

  server.tool(
    "headshot_from_photo",
    "Switched off: it crashed Character Creator 5, so it fails at once and does nothing in CC5. To make a head from a photo, ask the user to use the Headshot plugin inside Character Creator 5 by hand.",
    { photo_path: z.string().describe("Absolute path to a .jpg/.png front-facing photo (ignored: the tool is switched off)") },
    // Chad's ruling (2026-10-03): never calls CC5.
    async () => errorResult(HEADSHOT_DISABLED)
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
    APPLY_DESCRIPTION,
    {
      recipe: RecipeSchema,
      continue_after: z.string().regex(STOP_ID_PATTERN).optional()
        .describe("Only to go on after a recipe stopped on a CC5 question: the id its report gives. Pass the remaining recipe the report gives (or an empty recipe)."),
      layer_answer: z.enum(LAYER_ANSWERS).optional()
        .describe(`Only with continue_after, after the recipe stopped on CC5's 'Replace / Material Only' question: the button the user picked. It answers the same question for the rest of this recipe only; there is no standing answer. ${CANCEL_NOT_CARRIED}`),
    },
    async ({ recipe, continue_after, layer_answer }, extra) => {
      // Checks that need no CC5 call come before the scene lock, so they answer even while another run holds it.
      // The SDK has validated already; parsing again makes the recipe canonical for continue_after's comparison.
      const checked = RecipeSchema.safeParse(recipe);
      if (!checked.success) {
        return errorResult(`Invalid recipe: ${checked.error.issues
          .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ")}`);
      }
      const parsed = checked.data;
      if (layer_answer !== undefined && continue_after === undefined) return errorResult(LAYER_WITHOUT_CONTINUE);
      // F-79: 'All 0 steps succeeded' would report a no-op as success.
      if (continue_after === undefined && recipeStepCount(parsed) === 0) {
        return errorResult("The recipe has no steps, so nothing was sent to CC5. Give it at least one step.");
      }
      const fileError = checkRecipeFiles(parsed);
      if (fileError) return errorResult(fileError);
      const release = claimScene("apply_character_recipe");
      if (typeof release === "string") return errorResult(release);
      try {
        const ctx: RunContext = { bridge, signal: extra?.signal, report: progressReporter(extra) };
        return continue_after === undefined
          ? await runNewRecipe(ctx, parsed)
          : await continueRecipe(ctx, continue_after, parsed, layer_answer);
      } finally {
        release();
      }
    }
  );
}
