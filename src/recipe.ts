/**
 * Declarative character recipe: one JSON object describing a whole character, applied step by step in one fixed
 * order (D2, planRecipe). A failed step is recorded and the rest still run. A CC5 question nobody has answered, or a
 * window that keeps a step from running, stops the recipe there (D1): nothing after it is sent to CC5, and the
 * report gives the remaining recipe to go on with after the answer.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CC5Bridge } from "./cc5-bridge.js";
import type { CC5Dialog } from "./types.js";
import { BODY_PRESETS } from "./tools/character.js";
import { isLocalAbsolute } from "./tools/unity.js";
import { TEXTURE_CHANNELS } from "./tools/pipeline.js";
import { runJobStep, type JobOutcome, type JobWaitOptions, type StepOutcome } from "./jobs.js";
import { dialogStopFromError, isBlockedByDialog, layerDialogHandler, type LayerAnswer } from "./build-session.js";
import { buildReport, capChecks, skinCheckTopic, type LoadJobResult } from "./change-report.js";
import { LAYER_STOP_ADVICE } from "./prompts/content-rules.js";

// Loads and poses run as bridge jobs: a dressed .ccAvatar can take longer than the bridge's
// 30 s limit for direct calls, which would report the step failed while CC5 goes on to finish it.
export const BASE_LOAD_WAIT_MS = 300_000;
export const STEP_JOB_WAIT_MS = 120_000;

// Character content, split by when it loads (D2). Together they are cc5_api._CHARACTER_CONTENT_EXTENSIONS; any other
// extension (e.g. .iProp) loads with the wearables. Presets load before skin_rgb and skin_condition, so the recipe's
// skin colour wins over a preset's (live: a lip makeup preset reset the skin colour).
export const PRESET_EXTENSIONS = [".cceye", ".ccskin", ".iskin", ".ccteeth", ".ccskingenpreset", ".rlhair", ".cchair", ".ihair"];
export const WEARABLE_EXTENSIONS = [
  ".cccloth", ".ccshoes", ".ccgloves", ".ccacc", ".iacc", ".iclothes", ".iclothing", ".ishoe", ".iaccessory",
];

// Chad's ruling (2026-10-03): switched off. Live in CC5 5.13 (Task 18), Headshot's CreateHeadFromPhoto crashed CC5
// in both modes. Keep the text in sync with HEADSHOT_DISABLED in cc5-plugin/cc5_builder.py.
export const HEADSHOT_DISABLED =
  "headshot_from_photo is switched off because it crashed Character Creator 5. Make the head by hand instead: " +
  "use the Headshot plugin inside Character Creator 5.";

const rgb = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
const absPath = z.string().refine(isLocalAbsolute, "must be a local absolute path without '..' (no network/UNC paths)");
const AVATAR_FILE = /\.(ccavatar|iavatar)$/i;

export const RecipeSchema = z.object({
  base: z.union([z.literal("default"), absPath.refine((p) => AVATAR_FILE.test(p), "base must be a .ccAvatar or .iAvatar file")]).optional()
    .describe("A .ccAvatar/.iAvatar path, best a textured character template from browse_content('character'); omit to modify the current character. 'default' loads CC5's neutral base, a mannequin with no skin or eye textures, eyebrows, eyelashes or hair. Setting it replaces any character already in the scene. A base file that does not exist is refused before anything changes."),
  headshot_photo: absPath.optional()
    .describe("Switched off: the step fails without calling CC5. Make the head by hand with the Headshot plugin inside Character Creator 5"),
  body_preset: z.object({
    preset: z.enum(["athletic", "muscular", "slim", "heavy", "average"]),
    intensity: z.number().min(0).max(1).default(1),
  }).optional(),
  morphs: z.array(z.object({ morph_id: z.string(), value: z.number().min(-1).max(1) })).optional(),
  skin_rgb: rgb.optional(),
  skin_condition: z.object({
    condition: z.enum(["normal", "pale", "cyanotic", "flushed", "jaundiced"]),
    amount: z.number().min(0).max(1).default(1),
    base_rgb: rgb.optional()
      .describe("The skin colour (0-1) the condition tints; left out, the recipe's skin_rgb is used. A remaining recipe a report gives carries it."),
  }).optional(),
  facial_profile: absPath.optional(),
  assets: z.array(absPath).optional()
    .describe("Content files (load_asset). Skin, makeup and eye presets and hairstyles load before skin_rgb and skin_condition, so the recipe's skin colour wins over a preset's; clothing, shoes, accessories and anything else load after the overlays."),
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
  wrinkle_strength: z.number().min(0).max(1).optional()
    .describe("Expression wrinkle strength 0-1 (set_wrinkle_strength): creases that show while an expression is active; it does not age a resting face"),
  expression: z.array(z.object({ name: z.string(), weight: z.number() })).optional(),
  pose_file: absPath.optional(),
});

export type Recipe = z.infer<typeof RecipeSchema>;

/**
 * One step's outcome. stopped: the step met a CC5 question or window and the recipe stopped there (ok is then
 * false): ran says whether CC5 started it (it finishes after the answer) or it never ran (it runs again); answered:
 * the button the run clicked in an earlier question of that job (RB-3). checks: every CHECK line of the load's
 * before/after comparison (RB-2: a report caps them only when it shows them, capChecks); notChecked: what it cannot
 * see; superseded: CHECK lines a later step of the recipe set again (shown as NOTE lines); changed: what a load that
 * failed still applied or changed (TS-3, shown as NOTE lines); otherTarget: the character a load went to when it
 * was not the first one, which skin_rgb and skin_condition change (X-1: its lines are never superseded).
 */
export interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
  stopped?: {
    ran: boolean; job_id?: string; question?: CC5Dialog; blocked_by?: string; wait_ms: number; asset?: string;
    answered?: string;
  };
  checks?: string[];
  notChecked?: string[];
  superseded?: string[];
  changed?: string[];
  otherTarget?: string;
}

type Outcome = { success?: boolean; error?: string };

export interface RecipeOptions {
  /** Aborted (e.g. the client cancelled the tool call): no further step starts and no further CC5 command is sent. */
  signal?: AbortSignal;
  /** Called after each step, e.g. to send a progress notification. */
  onStep?: (result: StepResult) => void;
  /** The user's answer to "Replace / Material Only" earlier in this run (D3): it answers the identical question. */
  layerAnswer?: LayerAnswer;
  /** Whether a file exists (default fs.existsSync); only the base is checked before anything changes (F-81). */
  fileExists?: (p: string) => boolean;
}

export type StepKind =
  | "base" | "headshot_photo" | "body_preset" | "morphs" | "facial_profile" | "preset" | "skin_rgb" | "skin_condition"
  | "texture" | "overlay" | "wearable" | "wrinkle_strength" | "expression" | "pose_file";

/** One step of a recipe: `part` is the recipe that runs this step alone; `asset` the content file it loads. */
export interface PlannedStep { name: string; kind: StepKind; part: Recipe; asset?: string }

function extensionOf(file: string): string {
  return /\.[^./\\]+$/.exec(file)?.[0].toLowerCase() ?? "";
}

const isPreset = (file: string): boolean => PRESET_EXTENSIONS.includes(extensionOf(file));

/** What a step's runner gets from applyRecipe: the bridge, the cancel signal, and the layer-answer handler. */
type StepContext = { bridge: CC5Bridge; signal?: AbortSignal; onDialog?: JobWaitOptions["onDialog"] };
type RunnableStep = PlannedStep & { exec: (x: StepContext) => Promise<Outcome> };

/** The base step: clear the scene, then create CC5's default character or load the base file (both as jobs). */
async function clearSceneAndLoad(x: StepContext, base: string): Promise<Outcome> {
  // create_default_avatar and load_asset are additive, and every later step acts on
  // avatars[0], so clear the scene first or the edits land on the old character.
  for (const a of (await x.bridge.getAvatars()) ?? []) {
    if (x.signal?.aborted) return { success: false, error: "cancelled before every old avatar was removed" };
    const d = await x.bridge.deleteAvatar(a.name);
    if (d?.success === false) {
      return { success: false, error: `could not remove existing avatar ${a.name}: ${d.error ?? "failed"}` };
    }
  }
  return base === "default"
    ? runJobStep(x.bridge, "create_default_avatar", {}, { waitMs: BASE_LOAD_WAIT_MS, signal: x.signal })
    : runJobStep(x.bridge, "load_asset", { file_path: base }, { waitMs: BASE_LOAD_WAIT_MS, signal: x.signal });
}

/**
 * The recipe's steps in the order they run (D2), each with the call that runs it. planRecipe is this list without
 * the calls, so applying, counting and the remaining recipe all come from this one place.
 */
function plan(recipe: Recipe): RunnableStep[] {
  const steps: RunnableStep[] = [];
  const add = (name: string, kind: StepKind, part: Recipe, exec: RunnableStep["exec"], asset?: string) => {
    steps.push({ name, kind, part, exec, ...(asset !== undefined ? { asset } : {}) });
  };
  // Content loads run as jobs; a run that carries the user's layer answer (D3) answers that question on the way.
  const loadAsset = (file: string) => (x: StepContext) =>
    runJobStep(x.bridge, "load_asset", { file_path: file }, { waitMs: STEP_JOB_WAIT_MS, signal: x.signal, onDialog: x.onDialog });
  const assets = recipe.assets ?? [];

  const base = recipe.base;
  if (base) add("base", "base", { base }, (x) => clearSceneAndLoad(x, base));
  const headshot = recipe.headshot_photo;
  if (headshot) {
    add("headshot_photo", "headshot_photo", { headshot_photo: headshot }, async () => ({ success: false, error: HEADSHOT_DISABLED }));
  }
  const preset = recipe.body_preset;
  if (preset) {
    add("body_preset", "body_preset", { body_preset: preset }, (x) => x.bridge.setMultipleMorphs(
      BODY_PRESETS[preset.preset].map((m) => ({
        morph_id: m.morph_id, value: Math.max(-1, Math.min(1, m.value * preset.intensity)) }))));
  }
  const morphs = recipe.morphs;
  if (morphs?.length) add("morphs", "morphs", { morphs }, (x) => x.bridge.setMultipleMorphs(morphs));
  const profile = recipe.facial_profile;
  if (profile) add("facial_profile", "facial_profile", { facial_profile: profile }, (x) => x.bridge.loadFacialProfile(profile));
  for (const a of assets.filter(isPreset)) add(`asset ${path.basename(a)}`, "preset", { assets: [a] }, loadAsset(a), a);
  const skin = recipe.skin_rgb;
  if (skin) add("skin_rgb", "skin_rgb", { skin_rgb: skin }, (x) => x.bridge.setSkinColor(skin[0], skin[1], skin[2]));
  const cond = recipe.skin_condition;
  if (cond) {
    // The condition tints this colour instead of overwriting the skin tone. It travels with the step, so a
    // remaining recipe that starts after skin_rgb keeps it.
    const baseRgb = cond.base_rgb ?? skin;
    add("skin_condition", "skin_condition",
      { skin_condition: { condition: cond.condition, amount: cond.amount, ...(baseRgb ? { base_rgb: baseRgb } : {}) } },
      (x) => x.bridge.setSkinCondition(cond.condition, cond.amount, "all", baseRgb));
  }
  for (const t of recipe.textures ?? []) {
    add(`texture ${t.material_name}/${t.channel}`, "texture", { textures: [t] },
      (x) => x.bridge.loadTexture(t.mesh_name, t.material_name, t.channel, t.image_path));
  }
  for (const o of recipe.overlays ?? []) {
    add(`overlay ${path.basename(o.image_path)}`, "overlay", { overlays: [o] },
      (x) => x.bridge.applySkinOverlay(o.image_path, o.region, o.strength));
  }
  for (const a of assets.filter((file) => !isPreset(file))) add(`asset ${path.basename(a)}`, "wearable", { assets: [a] }, loadAsset(a), a);
  const wrinkle = recipe.wrinkle_strength;
  if (wrinkle !== undefined) {
    add("wrinkle_strength", "wrinkle_strength", { wrinkle_strength: wrinkle }, (x) => x.bridge.setWrinkleStrength(wrinkle));
  }
  const expression = recipe.expression;
  if (expression?.length) add("expression", "expression", { expression }, (x) => x.bridge.setExpression(expression));
  const pose = recipe.pose_file;
  if (pose) {
    add("pose_file", "pose_file", { pose_file: pose },
      (x) => runJobStep(x.bridge, "apply_pose", { file_path: pose }, { waitMs: STEP_JOB_WAIT_MS, signal: x.signal }));
  }
  return steps;
}

/**
 * The recipe's steps in the order they run (D2): base, headshot_photo (switched off), body_preset, morphs,
 * facial_profile, skin/makeup/eye presets and hairstyles, skin_rgb, skin_condition, textures, overlays, then
 * clothing, shoes, accessories and any other asset, wrinkle_strength, expression, pose_file. Assets keep their order
 * within each class. `part` re-runs the step on its own.
 */
export function planRecipe(recipe: Recipe): PlannedStep[] {
  return plan(recipe).map(({ name, kind, part, asset }) => ({ name, kind, part, ...(asset !== undefined ? { asset } : {}) }));
}

export function recipeStepCount(recipe: Recipe): number {
  return planRecipe(recipe).length;
}

/** One recipe from steps' parts: assets, textures and overlays are concatenated in order; other keys are set. */
function mergeParts(parts: Recipe[]): Recipe {
  const out: Recipe = {};
  for (const p of parts) {
    const { assets, textures, overlays, ...rest } = p;
    Object.assign(out, rest);
    if (assets) out.assets = [...(out.assets ?? []), ...assets];
    if (textures) out.textures = [...(out.textures ?? []), ...textures];
    if (overlays) out.overlays = [...(out.overlays ?? []), ...overlays];
  }
  return out;
}

/**
 * The part of `recipe` still to run after `results` (applyRecipe's results for it): from the step after the one
 * that stopped when CC5 started it (it finishes after the answer), from that step itself when it never ran, and
 * from the first step without a result when none stopped. Nothing left gives {}.
 */
export function remainingRecipe(recipe: Recipe, results: StepResult[]): Recipe {
  const steps = planRecipe(recipe);
  let i = results.length;
  for (let j = results.length - 1; j >= 0; j--) {
    if (results[j].stopped) {
      i = j;
      break;
    }
  }
  const stopped = results[i]?.stopped;
  const k = stopped?.ran ? i + 1 : i;
  return mergeParts(steps.slice(k).map((s) => s.part));
}

/**
 * F-81: the base is the one step that deletes the characters in the scene before it loads, so a base file that
 * is wrong or missing is refused before anything changes. Other missing files fail their own step.
 */
export function checkRecipeFiles(recipe: Recipe, fileExists: (p: string) => boolean = fs.existsSync): string | null {
  const base = recipe.base;
  if (!base || base === "default") return null;
  if (!AVATAR_FILE.test(base)) return `base must be a .ccAvatar or .iAvatar file: ${base}. Nothing was changed in CC5.`;
  if (!fileExists(base)) return `base not found: ${base}. Nothing was changed in CC5: the characters in the scene were left as they were.`;
  return null;
}

type StopFields = { ran: boolean; job_id?: string; question?: CC5Dialog; blocked_by?: string; answered?: string };

function waitStep(s: Pick<PlannedStep, "name" | "kind" | "asset">, stop: StopFields, detail: string): StepResult {
  return {
    step: s.name,
    ok: false,
    detail,
    stopped: {
      ran: stop.ran,
      ...(stop.job_id ? { job_id: stop.job_id } : {}),
      ...(stop.question ? { question: stop.question } : {}),
      ...(stop.blocked_by ? { blocked_by: stop.blocked_by } : {}),
      wait_ms: s.kind === "base" ? BASE_LOAD_WAIT_MS : STEP_JOB_WAIT_MS,
      ...(s.asset ? { asset: s.asset } : {}),
      ...(stop.answered ? { answered: stop.answered } : {}),
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * X-1: the character a content load went to when the plugin says it was not the first one (changes.target_is_first
 * is not true), else undefined. skin_rgb and skin_condition change the first character, so such a load's skin lines
 * are never superseded by them.
 */
function otherTargetOf(r: StepOutcome): string | undefined {
  const changes = r.changes;
  if (!isRecord(changes) || changes.target_is_first === true) return undefined;
  const name = [changes.target, r.target].find((t): t is string => typeof t === "string" && t.length > 0);
  return name ?? "another character";
}

/**
 * A step that ran to its end: OK or FAIL with its detail. A content load (asset given) also gets the CHECK and NOT
 * CHECKED lines of its before/after comparison (every CHECK line: superseding needs them all, RB-2), what it still
 * changed when it failed (TS-3), the character it went to when that was not the first one (X-1), and says when it
 * answered "Replace / Material Only".
 */
function finishedStep(name: string, r: StepOutcome, asset?: string): StepResult {
  const ok = r.success !== false;
  const answered = typeof r.answered === "string" ? r.answered : undefined;
  let detail: string;
  if (ok) {
    detail = answered ? `CC5 asked 'Replace / Material Only'; answered '${answered}' (the user's answer earlier in this run)` : "";
  } else {
    detail = (typeof r.error === "string" ? r.error : undefined) ?? "failed";
    if (answered) detail += ` (after CC5 asked 'Replace / Material Only', answered '${answered}')`;
  }
  const result: StepResult = { step: name, ok, detail };
  if (asset !== undefined) {
    const report = buildReport(r as LoadJobResult, asset);
    if (report.checks.length) result.checks = report.checks;
    if (!ok && report.changed.length) result.changed = report.changed;
    if (report.notChecked.length) result.notChecked = report.notChecked;
    // Only a load with CHECK lines needs it: those are what skin_rgb or skin_condition could wrongly supersede. The
    // plugin also says "not first" when it could not tell (comparison off, or the read before the load failed), so
    // the line says "not confirmed", which holds either way.
    const otherTarget = report.checks.length ? otherTargetOf(r) : undefined;
    if (otherTarget !== undefined) {
      result.otherTarget = otherTarget;
      const where = `applied to ${otherTarget}, not confirmed to be the first character (skin_rgb and skin_condition ` +
        "change the first)";
      result.detail = result.detail ? `${result.detail}; ${where}` : where;
    }
  }
  return result;
}

/**
 * The step a job finished after the answer (continue_after), with the same rules as a step that ran in the recipe.
 * `answered`: the button the run clicked in that job before it stopped (RB-3), named when this wait clicked none.
 */
export function stepFromJob(
  name: string, out: Extract<JobOutcome, { done: true }>, asset?: string, answered?: string,
): StepResult {
  const raw = out.result;
  const result = (typeof raw === "object" && raw !== null ? raw : {}) as StepOutcome;
  const button = out.answered ?? answered;
  const finished: StepOutcome = button !== undefined ? { ...result, answered: button } : { ...result };
  return finishedStep(name, out.failed ? { ...finished, success: false, error: result.error ?? "failed" } : finished, asset);
}

/**
 * Apply a recipe in planRecipe's order. A failed step is recorded and the rest still run. A step that meets a CC5
 * question, or cannot run while CC5 has a window open, is a WAIT result and nothing after it is sent to CC5. A base
 * file that does not exist fails the base step before any CC5 call (F-81). After `signal` aborts, the remaining
 * steps are skipped and the results so far are returned: the caller checks `signal.aborted`.
 */
export async function applyRecipe(bridge: CC5Bridge, recipe: Recipe, opts: RecipeOptions = {}): Promise<StepResult[]> {
  const { signal, onStep } = opts;
  const results: StepResult[] = [];
  const fileError = checkRecipeFiles(recipe, opts.fileExists);
  if (fileError) {
    const refused: StepResult = { step: "base", ok: false, detail: fileError };
    onStep?.(refused);
    return [refused];
  }
  const ctx: StepContext = { bridge, signal, onDialog: layerDialogHandler(bridge, opts.layerAnswer) };

  /** Run one step and classify it; undefined when it was cancelled before it reached CC5. */
  const run = async (s: RunnableStep): Promise<StepResult | undefined> => {
    try {
      const r = (await s.exec(ctx)) as StepOutcome;
      // The step's job stopped on a CC5 question (or is queued behind one): it finishes after the answer.
      if (r.stopped) {
        const { job_id, question, blocked_by, answered } = r.stopped;
        return waitStep(s, { ran: true, job_id, question, blocked_by, answered }, r.error ?? "CC5 is waiting for an answer");
      }
      // The open-dialog guard failed the job: it never ran.
      if (r.success === false && isBlockedByDialog(r.error)) return waitStep(s, { ran: false }, r.error ?? "");
      return finishedStep(s.name, r, s.kind === "preset" || s.kind === "wearable" ? s.asset : undefined);
    } catch (e) {
      if (signal?.aborted && e === signal.reason) return undefined;  // cancelled before the step reached CC5
      const info = await dialogStopFromError(bridge, e);
      if (info) {
        // A base step stopped in getAvatars or deleteAvatar runs again as a whole after that command's job.
        return waitStep(s, { ran: s.kind === "base" ? false : info.ran, job_id: info.jobId, question: info.question }, info.text);
      }
      return { step: s.name, ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  };

  for (const s of plan(recipe)) {
    if (signal?.aborted) break;
    const result = await run(s);
    if (result === undefined) break;
    results.push(result);
    onStep?.(result);
    if (result.stopped) break;  // D1: nothing after an unanswered question is sent to CC5
  }
  return supersedeChecks(results);
}

/**
 * D2 vs F-34: a preset's skin-colour or pallor CHECK line is no surprise when a later step of the same recipe sets
 * that again (skin_rgb sets the colour; skin_condition sets the colour and the pallor). Such lines move to
 * `superseded` (shown as NOTE lines). X-1: skin_rgb and skin_condition change the first character, so the lines of
 * a load that went to another character (otherTarget) stay CHECK lines. Every CHECK line is there to supersede
 * (RB-2: reports cap them only when they show them). Changes the results in place, is idempotent, and returns the
 * array.
 */
export function supersedeChecks(results: StepResult[]): StepResult[] {
  results.forEach((later, i) => {
    if (!later.ok || later.stopped) return;
    const setsColour = later.step.startsWith("skin_rgb") || later.step.startsWith("skin_condition");
    if (!setsColour) return;
    const setsPallor = later.step.startsWith("skin_condition");
    for (const earlier of results.slice(0, i)) {
      if (!earlier.checks?.length || earlier.otherTarget !== undefined) continue;
      const keep: string[] = [];
      for (const line of earlier.checks) {
        const topic = skinCheckTopic(line);
        if (topic === "skin_colour" || (topic === "pallor" && setsPallor)) {
          earlier.superseded = [...(earlier.superseded ?? []), `${line}: set again by ${later.step} later in this recipe`];
        } else {
          keep.push(line);
        }
      }
      if (keep.length) earlier.checks = keep;
      else delete earlier.checks;
    }
  });
  return results;
}

/** Where a recipe stopped, for its report: the continue_after id, what is left to run, and whether it is D3's question. */
export type ReportStop = { id: string; remaining: Recipe; layer: boolean };
/** What a stopped recipe keeps for its continuation: the results so far (the WAIT step last) and what is left. */
export type RecipeStopData = { results: StepResult[]; remaining: Recipe };

const RAN_STOP_ADVICE = "Show the user the question. Answer a plain confirmation of exactly what they asked for " +
  "yourself and say so; for a real choice let them pick (a window no MCP command waits on may be the user's own: ask " +
  "them). Do not call job_status or run the step again: continue_after waits for it and reports it.";
const NOT_RAN_STOP_ADVICE = "Show the user the window above; they answer or close it in CC5 unless it is a plain " +
  "confirmation of what they asked for. Do not run the step again yourself: continue_after runs it once the window is closed.";

export function formatReport(results: StepResult[], stop?: ReportStop): string {
  const stopped = stop ? [...results].reverse().find((r) => r.stopped) : undefined;
  let head: string;
  if (stopped?.stopped) {
    head = stopped.stopped.ran
      ? `Stopped at ${stopped.step}: CC5 is waiting for an answer nobody has given yet, so nothing after it was sent to CC5.`
      : `Stopped at ${stopped.step}: it could not run while CC5 had a window open (a question nobody has answered, or a ` +
        "progress window), so nothing after it was sent to CC5.";
  } else {
    const failed = results.filter((r) => !r.ok).length;
    head = failed ? `${failed} of ${results.length} steps failed.` : `All ${results.length} steps succeeded.`;
    const changedMore = results.filter((r) => r.checks?.length).length;
    if (changedMore > 0) head += ` ${changedMore} step(s) changed more than they are for (CHECK lines below).`;
  }
  const lines = [head];
  for (const r of results) {
    if (r.stopped) lines.push(`WAIT ${r.step}: ${r.detail}`);
    else if (r.ok) lines.push(`OK   ${r.step}${r.detail ? `: ${r.detail}` : ""}`);
    else lines.push(`FAIL ${r.step}: ${r.detail}`);
    // RB-2: capped here, after superseding, so "... and N more" counts only the lines still to check.
    for (const c of capChecks(r.checks ?? [])) lines.push(`     CHECK ${c}`);
    for (const n of r.changed ?? []) lines.push(`     NOTE ${n}`);
    for (const n of r.superseded ?? []) lines.push(`     NOTE ${n}`);
  }
  // Each NOT CHECKED line once, with the steps it applies to: five clothing loads share one fit line.
  const notChecked = new Map<string, string[]>();
  for (const r of results) {
    for (const l of r.notChecked ?? []) {
      const steps = notChecked.get(l) ?? [];
      if (!steps.includes(r.step)) steps.push(r.step);
      notChecked.set(l, steps);
    }
  }
  for (const [l, steps] of notChecked) lines.push(`NOT CHECKED: ${l} (${steps.join(", ")})`);
  if (stop) {
    const names = planRecipe(stop.remaining).map((s) => s.name);
    lines.push(names.length ? `Still to run after the answer: ${names.join(", ")}.` : "Nothing else was left to run.");
    lines.push(`To go on after the answer: apply_character_recipe with continue_after "${stop.id}" and this recipe: ` +
      JSON.stringify(stop.remaining));
    if (stop.layer) lines.push(`${LAYER_STOP_ADVICE} layer_answer answers the same question for the rest of this recipe only.`);
    else lines.push(stopped?.stopped?.ran ? RAN_STOP_ADVICE : NOT_RAN_STOP_ADVICE);
  }
  if (results.some((r) => r.checks?.length)) {
    lines.push("These steps ran: do not run them again because of the CHECK lines; show those lines to the user.");
  }
  return lines.join("\n");
}
