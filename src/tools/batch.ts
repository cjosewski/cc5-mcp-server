/**
 * Batch patient generation: for each variant, reload a saved base character, apply a recipe, export to Unity, and
 * record a budget check, writing the manifest after every variant so finished work survives a crash.
 *
 * D1 (Chad, 2026-10-06): a CC5 question nobody has answered, or a call that cannot run behind an open window, stops
 * the batch. Nothing more goes to CC5, the manifest says where it stopped, and continue_after finishes the stopped
 * variant from where it stopped after the answer, then runs the variants not started. A batch does not start while a
 * CC5 dialog is open. D3: CC5's "Replace / Material Only" has no standing answer: the user's button, passed as
 * layer_answer with continue_after, answers the identical question for the rest of this batch only.
 */

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import type { CC5Dialog, MeshStatsResult } from "../types.js";
import { bridgeErrorResult, errorResult, progressReporter, warningNotes, type ToolResult } from "../util.js";
import { awaitJob, lostJobMessage, runJob, runJobStep, type JobOutcome } from "../jobs.js";
import {
  applyRecipe, checkRecipeFiles, recipeStepCount, remainingRecipe, stepFromJob, supersedeChecks,
  BASE_LOAD_WAIT_MS, RecipeSchema, STEP_JOB_WAIT_MS, type Recipe, type StepResult,
} from "../recipe.js";
import { claimScene } from "../scene-lock.js";
import { capChecks } from "../change-report.js";
import {
  carryLayerAnswer, dialogStopFromError, findStop, finishBuild, isBlockedByDialog, layerDialogHandler, openDialog,
  recordStop, startBuild, LAYER_ANSWERS, LAYER_EXPECT, STOP_ID_PATTERN, type Build, type BuildStop, type LayerAnswer,
} from "../build-session.js";
import { BATCH_RULE, CANCEL_NOT_CARRIED } from "../prompts/content-rules.js";
import { formatDialog } from "./dialog.js";
import {
  CHARACTER_NAME, INJURY_CHOICES, INJURY_WARNING_PREFIX, injuryLines, injuryQuestion, isLocalAbsolute,
  evaluateExportBudget, scanTextures, unityFolderError, QUEST_DEFAULTS, TIMELINE_LEFT_LINE, TIMELINE_NOT_RESTORED_PREFIX,
  type InjuryReport,
} from "./unity.js";

const EXPORT_WAIT_MS = 300_000;
const MANIFEST_FILE = "patients_manifest.json";
/**
 * RB-5: U+FEFF, the byte-order mark Windows PowerShell 5 (Set-Content -Encoding UTF8) writes at the start of a file.
 * Compared by code point: an invisible literal in the source is easily lost in an edit.
 */
const BYTE_ORDER_MARK = 0xfeff;

/**
 * DEC-1 (Chad, 2026-10-06: what counts as one build), the recommended option: one batch call and its
 * continuations. Under option B (each variant is its own build) this reads "for the rest of variant <v> only; later
 * variants ask again", and runBatch passes the answer to the resumed variant only.
 */
const LAYER_SCOPE = "for the rest of this batch only";

/**
 * DEC-4 (Chad, 2026-10-06: option a): a content load that changed more than it was for (F-34) makes
 * the patient not OK, and its FBX is kept until the user has seen the CHECK lines.
 */
const checksProblem = (checks: string[]): string =>
  `exported, but check with the user: ${checks.join("; ")} (CC5 side effects of this recipe: running it again gives ` +
  "the same result)";

// F-77: a .ccAvatar keeps neither the facial expression nor (P8-10) the pose; the batch re-applies pose_file itself.
const NEUTRAL_FACE = "No expression step: exported with a neutral face (a .ccAvatar does not keep the facial expression).";
// F-86: every FBX export clears CC5's undo history; one line for the whole batch.
const UNDO_CLEARED = "CC5 cleared its undo history with these exports: changes made before them can no longer be undone.";
/** What injuryLines says for an export without an injuries report: a plugin older than F-75. */
const NO_INJURY_REPORT = injuryLines();
const UNKNOWN_JOB = "its job id is unknown: check the scene (list_clothes, capture_viewport) before relying on it";

const LAYER_WITHOUT_CONTINUE =
  "layer_answer only goes on after a batch stopped on CC5's 'Replace / Material Only' question (with continue_after). " +
  "There is no standing answer: run the batch without it; if CC5 asks, the batch stops and the question goes to the " +
  "user. Nothing was sent to CC5.";

const LAYER_STOP_TEXT =
  "This is a real choice: show the user the question and buttons with your recommendation; answer it with " +
  `answer_cc5_dialog(<button>, expect: '${LAYER_EXPECT}'); then go on with layer_answer set to that button: it ` +
  `answers the same question ${LAYER_SCOPE}. ${CANCEL_NOT_CARRIED}`;

/** TS-4: the injuries question in a batch ends with the batch's own way on, not with export_for_unity. */
const INJURIES_AGAIN = "then run batch_generate_patients again with injuries (or this variant's own injuries) and the " +
  "variants not finished";
/** X-2: the timeline note is no export setting CC5 failed to apply; the batch says it once, with the variants. */
const timelineLine = (names: string[]): string =>
  `CC5's timeline was left at one frame after the export of ${names.join(", ")}: set its length in Character ` +
  "Creator 5 (this does not change the FBX files).";

const DESCRIPTION =
  "Generate many patient variations from one saved base character: each variant applies a character recipe, exports " +
  "to <unity_dir>/<name>/ and gets a Quest budget check. Writes patients_manifest.json in unity_dir after every " +
  "variant. Save the base first with save_character. One batch or recipe runs at a time; cancelling stops the batch " +
  "before its next CC5 command. Character Creator 5 5.13 often crashes on the first FBX export after it starts: if " +
  "CC5 closes during the first variant, restart CC5, answer its recovery prompt and run the batch again " +
  "(patients_manifest.json records the error of each variant that failed). " +
  "A CC5 question stops the batch: nothing more is sent to CC5 until it is answered, and the reply gives the " +
  "continue_after call that finishes the stopped variant from where it stopped. A batch does not start while a CC5 " +
  "dialog is open. Replace / Material Only has no standing answer: after the user picked a button, pass it as " +
  `layer_answer with continue_after; it answers the same question ${LAYER_SCOPE}. A variant with an empty recipe is ` +
  "refused unless export_base_unchanged is true (a control patient). patients_manifest.json keeps the entries of " +
  "earlier batches in the same folder; a variant run again replaces its entry. A .ccAvatar does not keep the facial " +
  "expression: give each variant that needs one an expression step. Skin overlays and skin conditions do not travel " +
  "in an FBX: variants that have them need injuries ('bake', 'separate' or 'omit'), as the user chose; there is no " +
  "default. unity_dir must be inside an existing Unity project, and base_character must exist. " + BATCH_RULE;

// Each variant exports to <unity_dir>/<name>/, and Windows folder names ignore case.
const uniqueNames = (variants: Array<{ name: string }>) =>
  new Set(variants.map((v) => v.name.toLowerCase())).size === variants.length;

export const VariantSchema = z.object({
  name: CHARACTER_NAME,
  recipe: RecipeSchema,
  injuries: z.enum(INJURY_CHOICES).optional()
    .describe("This variant's choice for skin overlays and skin conditions in Unity; it overrides the batch's injuries"),
  export_base_unchanged: z.boolean().optional()
    .describe("true: export the base exactly as saved, a control patient (an empty recipe needs this)"),
}).superRefine((v, ctx) => {
  // F-79: an empty recipe exported an unchanged copy of the base and reported OK.
  const steps = recipeStepCount(v.recipe);
  if (steps === 0 && v.export_base_unchanged !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["recipe"],
      message: `Variant ${v.name} has an empty recipe: it would export the base unchanged. Give it recipe steps, or ` +
        "set export_base_unchanged: true for a control patient.",
    });
  }
  if (steps > 0 && v.export_base_unchanged === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["export_base_unchanged"],
      message: `Variant ${v.name} has export_base_unchanged: true and recipe steps: leave out one or the other.`,
    });
  }
});
export type BatchVariant = z.output<typeof VariantSchema>;

export const BatchSchema = z.object({
  base_character: z.string().describe("Absolute path to a saved .ccAvatar base (see save_character)"),
  unity_dir: z.string()
    .describe("Absolute folder inside the Assets folder of an existing Unity project (its ProjectSettings\\ProjectVersion.txt must exist)"),
  variants: z.array(VariantSchema).min(1).max(50)
    .refine(uniqueNames, "Variant names must be unique, ignoring case: each variant exports to <unity_dir>/<name>/"),
  sub_d_level: z.number().int().min(0).max(2).default(0)
    .describe("Subdivision level of the exported FBX (0 = base mesh, best for Quest). Above 0 the triangle budget is not checked, because the scene stats count the base mesh"),
  texture_size: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).default(2048),
  injuries: z.enum(INJURY_CHOICES).optional()
    .describe("How skin overlays and skin conditions reach Unity for every variant that has them (a variant's own injuries wins): 'bake', 'separate' or 'omit'. An FBX cannot carry them. Ask the user; there is no default."),
  continue_after: z.string().regex(STOP_ID_PATTERN).optional()
    .describe("Only to go on after a batch stopped on a CC5 question: the id its reply gives. Pass the same settings, the stopped variant first and unchanged, then the variants not started."),
  layer_answer: z.enum(LAYER_ANSWERS).optional()
    .describe(`Only with continue_after, after the batch stopped on CC5's 'Replace / Material Only' question: the button the user picked. It answers that question ${LAYER_SCOPE}; there is no standing answer. ${CANCEL_NOT_CARRIED}`),
});
export type BatchInput = z.input<typeof BatchSchema>;
export type BatchParsed = z.output<typeof BatchSchema>;

/** The settings a continuation must repeat unchanged (with the stopped variant itself). */
const SETTING_KEYS = ["base_character", "unity_dir", "sub_d_level", "texture_size", "injuries"] as const;
export type BatchSettings = Pick<BatchParsed, (typeof SETTING_KEYS)[number]>;

export type ManifestVariant = {
  name: string;
  ok: boolean;
  steps: StepResult[];
  /** When this run started the variant (ISO time). */
  created?: string;
  /** The base character it was made from. */
  base?: string;
  fbx?: string;
  budget_pass?: boolean;
  budget?: string[];
  /** WARNING notes from the export: settings CC5 did not apply. Such a variant is not ok. */
  notes?: string[];
  error?: string;
  /** The batch stopped in this variant on a CC5 question or window (D1). */
  stopped?: true;
  /** F-34: what its content loads changed besides what they were for, as '<step>: <line>'. Such a variant is not ok. */
  checks?: string[];
  /** Information that does not make the variant fail (F-77). */
  info?: string[];
  /** What the export did with skin overlays and skin conditions (F-75). */
  injuries?: string[];
  /** A control patient: the base exported as saved (F-79). */
  export_base_unchanged?: true;
  /** The FBX of an earlier run, kept when this run did not export the variant again (F-80). */
  earlier_export?: { created?: string; fbx: string };
};

export type Manifest = {
  created: string;
  base: string;
  unity_dir: string;
  /** Set when the client cancelled the run: says which variants never started. */
  cancelled?: string;
  /** Set when a CC5 question or a missing injuries choice stopped the run: where, and which variants never started. */
  stopped?: string;
  variants: ManifestVariant[];
};

/** Where a stopped variant goes on: the scene clear, after the base load, in the recipe, or at the export. */
export type BatchPhase = "scene" | "base" | "recipe" | "export";
export type DoneOutcome = Extract<JobOutcome, { done: true }>;

/** continue_after: finish the first variant from where the batch stopped. */
export interface BatchResume {
  variant: string;
  phase: BatchPhase;
  /** The variant's steps so far, without the WAIT step (and with the step its job finished after the answer). */
  steps: StepResult[];
  /** Phase recipe: what is left of the recipe. */
  remaining?: Recipe;
  /** Phase base: the base load that finished after the answer. Phase export: the export that finished. */
  awaited?: DoneOutcome;
}

/**
 * Where a batch stopped (D1), as recordStop keeps it for continue_after. ran: CC5 started (or queued) the step and it
 * finishes after the answer, so it is not run again; jobId: a command waits in the question and the continuation waits
 * for that job. The wording follows jobId; the resume follows phase and ran.
 */
export interface BatchStopDetail {
  variant: string;
  phase: BatchPhase;
  step: string;
  ran: boolean;
  jobId?: string;
  question?: CC5Dialog;
  /** The job whose question the stopped job is queued behind: then it is not the user's layer question. */
  blockedBy?: string;
  waitMs: number;
  asset?: string;
  /** The button the batch clicked in an earlier question of the stopped job (RB-3). */
  answered?: string;
  /** This variant's steps, including the WAIT step. */
  steps: StepResult[];
  remaining?: Recipe;
  /** A finished export whose budget check was blocked: the continuation reuses it. */
  exported?: DoneOutcome;
  notStarted: string[];
  text: string;
  settings: BatchSettings;
  variantDef: BatchVariant;
}

export interface BatchOptions {
  /** Aborted when the client cancels the tool call: the batch then sends CC5 nothing more and stops. */
  signal?: AbortSignal;
  /** Called after every recipe step and variant, e.g. to send a progress notification. */
  onProgress?: (message: string) => void;
  /** Whether a file exists (default fs.existsSync): the bases are checked before any CC5 call (F-81). */
  fileExists?: (p: string) => boolean;
  /** The user's answer to "Replace / Material Only" earlier in this batch (D3): it answers the identical question. */
  layerAnswer?: LayerAnswer;
  /** continue_after: finish the first variant from where the batch stopped. */
  resume?: BatchResume;
  /** Called when the batch stops on a CC5 question or window; returns the continue_after id. */
  onStop?: (detail: BatchStopDetail) => string;
}

/** Where a variant stopped on a CC5 window: the part of BatchStopDetail the variant itself knows. */
type VariantStop = Omit<BatchStopDetail, "variant" | "steps" | "notStarted" | "settings" | "variantDef">;
/** Why a variant could not finish: a CC5 window (continue_after goes on), or an export that needs an injuries choice. */
type Halt = { stop: VariantStop } | { needsInjuries: InjuryReport | undefined };

/** undo_history_cleared (F-86) is typed here, so the batch reads it with or without src/types.ts knowing it. */
type ExportResult = {
  success?: boolean; error?: string; fbx?: string; folder?: string; notes?: string[];
  needs_choice?: boolean; injuries?: InjuryReport; undo_history_cleared?: boolean;
};

/** Manifests whose run exported at least once with CC5 clearing its undo history (F-86); never written to the file. */
const exportsClearedUndo = new WeakSet<Manifest>();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const listOrNone = (names: string[]): string => (names.length ? names.join(", ") : "none");
/** A stop text on one line: the timed-out call's stop adds the open window's description on lines of its own. */
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, " ").trim();

/** A stop with its optional fields only when they are set. */
function variantStop(s: VariantStop): Halt {
  return {
    stop: {
      phase: s.phase, step: s.step, ran: s.ran, waitMs: s.waitMs, text: oneLine(s.text),
      ...(s.jobId ? { jobId: s.jobId } : {}),
      ...(s.question ? { question: s.question } : {}),
      ...(s.blockedBy ? { blockedBy: s.blockedBy } : {}),
      ...(s.asset ? { asset: s.asset } : {}),
      ...(s.answered ? { answered: s.answered } : {}),
      ...(s.remaining ? { remaining: s.remaining } : {}),
      ...(s.exported ? { exported: s.exported } : {}),
    },
  };
}

/**
 * F-75: what an FBX cannot carry. Only 'pale' leaves the skin shader's pallor offsets; the other conditions are skin
 * tints the FBX writes as its material colour (DEC-2, Chad 2026-10-06: named on every export, no choice needed).
 */
function hasInjuries(recipe: Recipe): boolean {
  const condition = recipe.skin_condition;
  return (recipe.overlays ?? []).some((o) => o.strength > 0) ||
    (recipe.textures ?? []).some((t) => t.channel === "diffuse_blend") ||
    (condition?.condition === "pale" && condition.amount > 0);
}

/**
 * The manifest in `file`, or null when there is none (F-80). Throws when it cannot be read, is not JSON, or has no
 * variants list of named entries. Entries of a manifest written before F-80 take the run's created and base.
 */
export function readManifest(file: string): Manifest | null {
  if (!fs.existsSync(file)) return null;
  // RB-5: a manifest edited by hand may start with a UTF-8 byte-order mark (Windows PowerShell 5's UTF8), which
  // JSON.parse refuses.
  const text = fs.readFileSync(file, "utf8");
  const raw: unknown = JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
  const variants = isRecord(raw) ? raw.variants : undefined;
  if (!isRecord(raw) || !Array.isArray(variants) || !variants.every((v) => isRecord(v) && typeof v.name === "string")) {
    throw new Error("not a batch manifest (no variants list)");
  }
  const run: Record<string, unknown> = raw;
  return {
    ...run,
    variants: variants.map((v: Record<string, unknown>) => ({ created: run.created, base: run.base, ...v })),
  } as unknown as Manifest;
}

/**
 * F-80: one manifest per folder across batches. `current` (this run) replaces the earlier entries of the variants it
 * ran (names ignore case, as Windows folders do); the others are kept, in their order, before this run's entries. An
 * entry this run did not export keeps the way to its last FBX (earlier_export). Top-level fields of the earlier file
 * survive (a hand-written note), except its run's cancelled and stopped notes.
 */
export function mergeManifest(earlier: Manifest | null, current: Manifest): Manifest {
  if (!earlier) return current;
  const key = (name: string) => name.toLowerCase();
  const before = new Map(earlier.variants.map((v) => [key(v.name), v] as const));
  const ran = new Set(current.variants.map((v) => key(v.name)));
  const kept = earlier.variants.filter((v) => !ran.has(key(v.name)));
  const replaced = current.variants.map((v): ManifestVariant => {
    const old = before.get(key(v.name));
    if (!old || v.fbx) return v;
    const last = old.fbx ? { created: old.created, fbx: old.fbx } : old.earlier_export;
    return last ? { ...v, earlier_export: last } : v;
  });
  const top: Partial<Manifest> = { ...earlier };
  delete top.cancelled;
  delete top.stopped;
  return { ...top, ...current, variants: [...kept, ...replaced] };
}

export async function runBatch(bridge: CC5Bridge, input: BatchInput, writeManifest: (m: Manifest) => void,
  opts: BatchOptions = {}): Promise<Manifest> {
  const { signal, onProgress, layerAnswer, resume, onStop } = opts;
  const fileExists = opts.fileExists ?? fs.existsSync;
  const parsed = BatchSchema.parse(input);
  // F-81: variant 1's scene clear deletes the characters in the scene, so a base that is not there stops the batch here.
  if (!fileExists(parsed.base_character)) throw new Error(`base_character not found: ${parsed.base_character}`);
  for (const v of parsed.variants) {
    const fileError = checkRecipeFiles(v.recipe, fileExists);
    if (fileError) throw new Error(`Variant ${v.name}: ${fileError}`);
  }
  if (resume && resume.variant.toLowerCase() !== parsed.variants[0].name.toLowerCase()) {
    throw new Error(`The batch goes on with variant ${resume.variant}, so that variant must come first (not ${parsed.variants[0].name}).`);
  }
  const manifest: Manifest = { created: new Date().toISOString(), base: parsed.base_character, unity_dir: parsed.unity_dir, variants: [] };
  const settings: BatchSettings = {
    base_character: parsed.base_character, unity_dir: parsed.unity_dir, sub_d_level: parsed.sub_d_level,
    texture_size: parsed.texture_size, injuries: parsed.injuries,
  };
  const names = parsed.variants.map((v) => v.name);
  const cancelBefore = (index: number) => {
    const notStarted = names.slice(index);
    manifest.cancelled = `Cancelled by the client. ${notStarted.length ? `Not started: ${notStarted.join(", ")}` : "Every variant was started"}.`;
  };

  /** One variant up to its verdict in `entry`: where it stopped, or undefined once it finished. Throws on a failure. */
  const runVariant = async (v: BatchVariant, entry: ManifestVariant, label: string, r0?: BatchResume): Promise<Halt | undefined> => {
    // a. An empty scene with the base loaded. A continuation that stopped later goes on with the scene as it is.
    if (!r0 || r0.phase === "scene") {
      try {
        // load_asset is additive and recipe steps act on avatars[0], so the scene must be empty first.
        for (const a of (await bridge.getAvatars()) ?? []) {
          signal?.throwIfAborted();
          const d = await bridge.deleteAvatar(a.name);
          if (d?.success === false) throw new Error(`could not remove existing avatar ${a.name}: ${d.error ?? "failed"}`);
        }
      } catch (e) {
        // D1: behind a window nobody answered, each of these calls waited 30 s and failed, variant after variant.
        const info = signal?.aborted ? null : await dialogStopFromError(bridge, e);
        if (info) {
          return variantStop({ phase: "scene", step: "scene clear", ran: info.ran, jobId: info.jobId, question: info.question,
            waitMs: STEP_JOB_WAIT_MS, text: info.text });
        }
        throw e;
      }
      // A job, not a direct call: a dressed base can take longer than the bridge's 30 s limit for direct calls.
      const loaded = await runJobStep(bridge, "load_asset", { file_path: parsed.base_character }, { waitMs: BASE_LOAD_WAIT_MS, signal });
      if (loaded.stopped) {
        return variantStop({ phase: "base", step: "base load", ran: true, jobId: loaded.stopped.job_id,
          question: loaded.stopped.question, blockedBy: loaded.stopped.blocked_by, waitMs: BASE_LOAD_WAIT_MS,
          text: loaded.error ?? "CC5 is waiting for an answer" });
      }
      // The open-dialog guard failed the load: it never ran, so the continuation starts again with the scene clear.
      if (loaded.success === false && isBlockedByDialog(loaded.error)) {
        return variantStop({ phase: "scene", step: "base load", ran: false, waitMs: BASE_LOAD_WAIT_MS, text: loaded.error ?? "" });
      }
      if (loaded.success === false) throw new Error(`base load failed: ${loaded.error}`);
    } else if (r0.phase === "base") {
      // The base load waited in a question and finished after the answer.
      const loadedBase = r0.awaited;
      const result: Record<string, unknown> = loadedBase && isRecord(loadedBase.result) ? loadedBase.result : {};
      if (!loadedBase || loadedBase.failed || result.success === false) {
        throw new Error(`base load failed: ${typeof result.error === "string" ? result.error : "failed"}`);
      }
    }

    // b. The recipe, or what is left of it.
    const recipeOptions = {
      signal, layerAnswer, fileExists,
      onStep: (s: StepResult) => onProgress?.(`${label}: ${s.stopped ? "WAIT" : s.ok ? "OK" : "FAIL"} ${s.step}`),
    };
    let applied: Recipe | undefined;
    let segment: StepResult[] = [];
    let steps: StepResult[];
    if (r0?.phase === "export") {
      steps = r0.steps;
    } else if (r0?.phase === "recipe") {
      applied = r0.remaining ?? {};
      segment = await applyRecipe(bridge, applied, recipeOptions);
      // The whole variant's steps: a preset's skin-colour CHECK before the stop is no surprise when skin_rgb ran after it.
      steps = supersedeChecks([...r0.steps, ...segment]);
    } else {
      applied = v.recipe;
      segment = await applyRecipe(bridge, applied, recipeOptions);
      steps = segment;
    }
    entry.steps = steps;
    const last = segment[segment.length - 1];
    if (applied && last?.stopped) {
      return variantStop({ phase: "recipe", step: last.step, ran: last.stopped.ran, jobId: last.stopped.job_id,
        question: last.stopped.question, blockedBy: last.stopped.blocked_by, waitMs: last.stopped.wait_ms,
        asset: last.stopped.asset, answered: last.stopped.answered, text: last.detail,
        remaining: remainingRecipe(applied, segment) });
    }
    signal?.throwIfAborted();

    // c. The export (a continuation that stopped at it uses the export that finished after the answer).
    const injuries = v.injuries ?? parsed.injuries;
    const out: JobOutcome = r0?.phase === "export" && r0.awaited
      ? r0.awaited
      : await runJob(bridge, "export_for_unity", {
        unity_dir: parsed.unity_dir, character_name: v.name,
        sub_d_level: parsed.sub_d_level, texture_size: parsed.texture_size,
        include_current_pose: Boolean(v.recipe.pose_file),
        ...(injuries ? { injuries } : {}),
      }, { waitMs: EXPORT_WAIT_MS, signal });
    if (!out.done) {
      if (out.dialog) {
        return variantStop({ phase: "export", step: "export", ran: true, jobId: out.job_id, question: out.question,
          blockedBy: out.blocked_by, waitMs: EXPORT_WAIT_MS, text: out.dialog });
      }
      throw new Error(`export still running in CC5 as job ${out.job_id}`);
    }
    const r = (isRecord(out.result) ? out.result : {}) as ExportResult;
    if (r.undo_history_cleared === true) exportsClearedUndo.add(manifest);
    // F-75: refused before anything was exported; the user chooses how the injuries reach Unity.
    if (r.needs_choice) return { needsInjuries: r.injuries };
    const failed = out.failed || !r.success;
    if (failed && isBlockedByDialog(r.error)) {
      return variantStop({ phase: "export", step: "export", ran: false, waitMs: EXPORT_WAIT_MS, text: r.error ?? "" });
    }
    const allWarnings = warningNotes(r);
    // Injuries that did not reach the export are reported as such, not as settings CC5 did not apply; nor is a CC5
    // timeline that could not be set back after the export (X-2: the FBX is right, only the scene's timeline is not).
    const timelineLeft = allWarnings.some((n) => n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
    const warnings = allWarnings.filter((n) => !n.startsWith(INJURY_WARNING_PREFIX) && !n.startsWith(TIMELINE_NOT_RESTORED_PREFIX));
    if (warnings.length) entry.notes = warnings;
    if (timelineLeft) entry.info = [TIMELINE_LEFT_LINE];
    if (failed) throw new Error(r.error ?? "export failed");
    entry.fbx = r.fbx;
    entry.injuries = injuryLines(r.injuries);

    // d. The Quest budget, read from the scene the export was made from.
    signal?.throwIfAborted();
    let stats: MeshStatsResult;
    try {
      stats = await bridge.getMeshStats();
    } catch (e) {
      // The export finished: the continuation keeps it and only reads the stats again.
      const info = signal?.aborted ? null : await dialogStopFromError(bridge, e);
      if (info) {
        return variantStop({ phase: "export", step: "budget check", ran: false, waitMs: STEP_JOB_WAIT_MS, text: info.text,
          exported: out });
      }
      throw e;
    }
    if (!stats.success) throw new Error(`mesh stats failed: ${stats.error ?? "unknown error"}`);
    const textures = r.folder && fs.existsSync(r.folder) ? scanTextures(r.folder) : [];
    const budget = evaluateExportBudget(stats, textures, QUEST_DEFAULTS, parsed.sub_d_level);
    entry.budget_pass = budget.pass;
    entry.budget = budget.lines;

    // e. The verdict. Only the steps' own CHECK lines count: lines a later step set again are superseded already, and
    // each step's lines are capped only now (RB-2).
    const checks = steps.flatMap((s) => capChecks(s.checks ?? []).map((l) => `${s.step}: ${l}`));
    if (checks.length) entry.checks = checks;
    if (!v.recipe.expression?.length) entry.info = [NEUTRAL_FACE, ...(entry.info ?? [])];
    // The report's failed lines, else (a report without them) the injury WARNING notes themselves: nothing is dropped.
    const reported = r.injuries && Array.isArray(r.injuries.failed) ? r.injuries.failed : [];
    const injuriesFailed = reported.length ? reported
      : allWarnings.filter((n) => n.startsWith(INJURY_WARNING_PREFIX)).map((n) => n.slice(INJURY_WARNING_PREFIX.length));
    entry.ok = steps.every((s) => s.ok) && !warnings.length && !checks.length && !injuriesFailed.length;
    const problems = [
      ...(warnings.length ? [`exported without some of its settings: ${warnings.join("; ")}`] : []),
      ...(injuriesFailed.length ? [`injuries not carried: ${injuriesFailed.join("; ")}`] : []),
      ...(checks.length ? [checksProblem(checks)] : []),
    ];
    if (problems.length) entry.error = problems.join("; ");
    return undefined;
  };

  for (const [index, v] of parsed.variants.entries()) {
    if (signal?.aborted) {
      cancelBefore(index);
      writeManifest(manifest);
      break;
    }
    const label = `${v.name} (${index + 1}/${parsed.variants.length})`;
    const entry: ManifestVariant = {
      name: v.name, ok: false, steps: [], created: new Date().toISOString(), base: parsed.base_character,
      ...(v.export_base_unchanged ? { export_base_unchanged: true as const } : {}),
    };
    let halt: Halt | undefined;
    try {
      halt = await runVariant(v, entry, label, index === 0 ? resume : undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      entry.error = signal?.aborted
        ? `cancelled before this variant finished${e === signal.reason ? "" : ` (${message})`}`
        : message;
    }
    if (halt) {
      // D1 and F-75: nothing more goes to CC5 until the user has answered.
      const notStarted = names.slice(index + 1);
      if ("stop" in halt) {
        const s = halt.stop;
        const id = onStop?.({ ...s, variant: v.name, steps: entry.steps, notStarted, settings, variantDef: v });
        entry.stopped = true;
        entry.error = `stopped: ${s.text}; ${entry.fbx ? "exported, but the Quest budget was not checked" : "not exported"}`;
        manifest.stopped = `Stopped at ${v.name} (${s.step}): ` +
          (s.jobId ? "CC5 is waiting for an answer nobody has given yet" : "it could not run while CC5 shows a window nobody has answered") +
          `, so nothing more was sent to CC5. Not started: ${listOrNone(notStarted)}.` + (id ? ` continue_after: "${id}".` : "");
      } else {
        entry.error = injuryQuestion(halt.needsInjuries, INJURIES_AGAIN);
        manifest.stopped = `Stopped at ${v.name}: it has skin overlays or a skin condition and no injuries choice was ` +
          `given, so it was not exported. Not started: ${listOrNone(notStarted)}.`;
      }
      manifest.variants.push(entry);
      writeManifest(manifest);
      onProgress?.(`${label}: stopped`);
      break;
    }
    if (signal?.aborted) cancelBefore(index + 1);
    manifest.variants.push(entry);
    writeManifest(manifest);
    onProgress?.(`${label}: ${entry.ok ? "done" : "FAILED"}`);
    if (signal?.aborted) break;
  }
  return manifest;
}

type RunContext = { bridge: CC5Bridge; signal?: AbortSignal; report: (message: string) => void };
type Continuation = { id: string; build: Build; stop: BuildStop; data: BatchStopDetail };

/** continue_after: the stop it names, or why the batch cannot go on from it. No CC5 call. */
function findContinuation(input: BatchParsed, id: string): Continuation | string {
  const found = findStop("batch", id);
  if (!found) {
    return `continue_after ${id} is not where the last batch stopped (or the MCP server restarted): run the variants ` +
      "not finished as a new batch. Nothing was sent to CC5.";
  }
  const data = found.stop.data as BatchStopDetail;
  const v = data.variant;
  if (input.variants[0].name.toLowerCase() !== v.toLowerCase()) {
    return `continue_after ${id} belongs to variant ${v}: list it first, then the variants not started ` +
      `(${listOrNone(data.notStarted)}). Nothing was sent to CC5.`;
  }
  // The variant goes on from where it stopped: a changed recipe would export a patient nobody asked for.
  if (!isDeepStrictEqual(input.variants[0], data.variantDef)) {
    return `continue_after ${id} finishes variant ${v} as it was when the batch stopped, and its recipe or settings ` +
      "differ now: pass it unchanged, or run it as a new batch without continue_after. Nothing was sent to CC5.";
  }
  const differ = SETTING_KEYS.filter((k) => input[k] !== data.settings[k]);
  if (differ.length) {
    return `continue_after ${id} goes on with the batch settings it stopped with; ${differ.join(", ")} ` +
      `${differ.length === 1 ? "differs" : "differ"} now. Nothing was sent to CC5.`;
  }
  return { id, build: found.build, stop: found.stop, data };
}

/**
 * The reply once the batch has run: one line per variant of this run, then how to go on. manifestError: why the
 * last write of patients_manifest.json failed (RB-4), so the reply says the file does not show this run.
 */
function summarize(input: BatchParsed, m: Manifest, manifestPath: string, earlier: Manifest | null,
  recorded: BuildStop | undefined, replaced: BuildStop | undefined, manifestError?: string): ToolResult {
  const lines = m.variants.map((e) => `${e.stopped ? "WAIT" : e.ok ? "OK  " : "FAIL"} ${e.name}` +
    (e.export_base_unchanged ? " (the base, unchanged on purpose)" : "") +
    (e.error ? `: ${e.error}` : "") +
    (e.budget_pass === false ? " (over Quest budget)" : "") +
    (e.budget && e.budget_pass === undefined ? ` (triangle budget not checked: sub_d_level ${input.sub_d_level})` : ""));
  // TS-5: a variant whose FBX was written (and kept) is exported, also when it is not OK: CHECK lines, settings CC5
  // did not apply, injuries that did not reach it, or a budget check a window blocked. The OK count comes apart.
  const exported = m.variants.filter((e) => e.fbx !== undefined || e.ok).length;
  const okCount = m.variants.filter((e) => e.ok).length;
  const counted = `${exported}/${m.variants.length} variants exported` +
    (okCount === exported ? "." : ` (${okCount} OK: see the lines below).`);
  const earlierListed = mergeManifest(earlier, m).variants.length - m.variants.length;
  const parts: string[] = [];
  if (m.cancelled) parts.push(m.cancelled);
  if (m.stopped) parts.push(m.stopped);
  parts.push(`${counted} Manifest: ${manifestPath}` +
    (earlierListed > 0 ? ` The manifest also lists ${earlierListed} earlier variant(s).` : ""), ...lines);
  if (manifestError !== undefined) parts.push(`${MANIFEST_FILE} could not be written (${manifestError}): it does not show this run.`);
  const neutral = m.variants.filter((e) => e.info?.includes(NEUTRAL_FACE)).length;
  if (neutral > 0) {
    parts.push(`${neutral} variant(s) have no expression step and were exported with a neutral face (a .ccAvatar does ` +
      "not keep the facial expression).");
  }
  const unchecked = m.variants.filter((e) => e.fbx !== undefined && isDeepStrictEqual(e.injuries, NO_INJURY_REPORT));
  if (unchecked.length) {
    parts.push(`Skin overlays and skin conditions were not checked for ${unchecked.map((e) => e.name).join(", ")}: the ` +
      "installed CC5 plugin is older than that check (reinstall it with install-plugin.ps1).");
  }
  const timelineLeft = m.variants.filter((e) => e.info?.includes(TIMELINE_LEFT_LINE)).map((e) => e.name);
  if (timelineLeft.length) parts.push(timelineLine(timelineLeft));
  if (recorded) {
    const d = recorded.data as BatchStopDetail;
    parts.push("To go on after the answer: call batch_generate_patients again with the same base_character, unity_dir, " +
      `sub_d_level, texture_size and injuries, continue_after "${recorded.id}", and these variants: ${d.variant} first ` +
      "and unchanged (it is finished from where it stopped; its recipe is not run again), then " +
      `${d.notStarted.length ? d.notStarted.join(", ") : "nothing else"}.`);
    if (recorded.layer) parts.push(LAYER_STOP_TEXT);
  } else if (m.stopped) {
    // F-75: no continue_after; the fix is a parameter, so the variants not finished run again.
    const unfinished = input.variants.slice(Math.max(0, m.variants.length - 1)).map((v) => v.name);
    parts.push("To go on: ask the user how skin overlays and skin conditions should reach Unity for these patients " +
      "('bake', 'separate' or 'omit'; there is no default), then run batch_generate_patients again with injuries (or a " +
      `variant's own injuries) and the variants not finished: ${unfinished.join(", ")}.`);
  }
  if (exportsClearedUndo.has(m)) parts.push(UNDO_CLEARED);
  if (replaced) {
    parts.push(`Note: the earlier ${replaced.kind} that stopped at ${replaced.step} (continue_after "${replaced.id}") ` +
      "was not continued; that stop is forgotten.");
  }
  const text = parts.join("\n");
  return m.cancelled || m.stopped || manifestError !== undefined || m.variants.some((e) => !e.ok)
    ? errorResult(text)
    : { content: [{ type: "text" as const, text }] };
}

/**
 * The batch inside the scene lock: take the user's layer answer, wait for the command that waited in the question,
 * refuse while CC5 shows a window, check the scene a continuation finds, then run and report.
 */
async function runLocked(ctx: RunContext, input: BatchParsed, manifestPath: string, earlier: Manifest | null,
  cont?: Continuation): Promise<ToolResult> {
  const { bridge, signal, report } = ctx;
  // 1. D3: taken inside the lock, so a call the lock refused never stores an answer.
  if (cont && input.layer_answer !== undefined) {
    const refusal = carryLayerAnswer(cont.build, cont.stop, input.layer_answer);
    if (refusal) return errorResult(refusal);
  }

  // 2. The command that waited in the question finishes after the answer: wait for it first, so a progress window
  // of its own is waited out, not refused.
  let awaited: DoneOutcome | undefined;
  const jobId = cont?.data.jobId;
  if (cont && jobId) {
    const { id, data } = cont;
    report(`${data.variant}: waiting for job ${jobId} (after the answer)`);
    let out: JobOutcome;
    try {
      out = await awaitJob(bridge, jobId, {
        waitMs: data.waitMs, signal, onDialog: layerDialogHandler(bridge, cont.build.layerAnswer),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === lostJobMessage(jobId)) {
        finishBuild(cont.build);
        return errorResult(`${message} The batch stop is forgotten: run ${data.variant} and the variants not started ` +
          `(${listOrNone(data.notStarted)}) as a new batch.`);
      }
      return bridgeErrorResult(err);
    }
    // RB-3: a button this wait clicked stays with the stop. Every refusal from here on keeps the stop, and the retry's
    // wait reads a job that names no button any more, so the step that finishes after the answer takes it from here.
    if (out.answered !== undefined) cont.stop.answered = out.answered;
    if (!out.done) {
      if (out.dialog) {
        return errorResult(`${out.dialog}\nAnswer it first, then call batch_generate_patients with continue_after ` +
          `"${id}" again. Nothing else was sent to CC5.`);
      }
      if (signal?.aborted) {
        return errorResult(`Cancelled by the client: nothing else was sent to CC5; continue_after "${id}" still works.`);
      }
      return errorResult(`Variant ${data.variant}: ${data.step} is still running in CC5 (job ${jobId}). Wait for it ` +
        `(job_status "${jobId}"), then call batch_generate_patients with continue_after "${id}" again. Nothing else ` +
        "was sent to CC5.");
    }
    awaited = out;
  }

  // 3. D1: a batch does not start, or go on, while CC5 shows a window: each call would wait 30 s behind it and fail.
  const open = await openDialog(bridge);
  if (open?.dialog) {
    const again = cont
      ? `call batch_generate_patients with continue_after "${cont.id}" again.`
      : "run batch_generate_patients again.";
    return errorResult(`${formatDialog(open.dialog, open.waiting_job)}\n` + (open.dialog.progress
      ? `Nothing was sent to CC5: a batch does not start while CC5 is busy. When that window has closed, ${again}`
      : `Nothing was sent to CC5: a batch does not start while a CC5 dialog is open. Once it is answered or closed, ${again}`));
  }

  // 4. A scene changed during the pause is never exported as the stopped patient. A variant whose own base step has
  // not run yet is rebuilt from that file (the base step comes first and deletes every character), so its scene,
  // possibly emptied by that step before a window stopped it, does not matter.
  const rebuildsFromBase = cont?.data.phase === "recipe" && cont.data.remaining?.base !== undefined;
  if (cont && cont.data.phase !== "scene" && !rebuildsFromBase) {
    let count: number;
    try {
      count = ((await bridge.getAvatars()) ?? []).length;
    } catch (err) {
      return bridgeErrorResult(err);
    }
    if (count !== 1) {
      finishBuild(cont.build);
      const v = cont.data.variant;
      return errorResult(`The scene holds ${count} characters now, not just variant ${v}: it changed while the batch ` +
        `was stopped, so ${v} cannot be finished from where it stopped. Run ${v} and the variants not started ` +
        `(${listOrNone(cont.data.notStarted)}) as a new batch, without continue_after. Nothing was changed in CC5.`);
    }
  }

  // 5. Where the stopped variant goes on.
  let resume: BatchResume | undefined;
  if (cont) {
    const d = cont.data;
    const steps = d.steps.filter((s) => !s.stopped);
    if (d.phase === "recipe" && d.ran) {
      steps.push(awaited
        ? stepFromJob(`${d.step} (after the answer)`, awaited, d.asset, cont.stop.answered)
        : { step: `${d.step} (after the answer)`, ok: false, detail: UNKNOWN_JOB });
    }
    const resumeAwaited = d.phase === "export" ? d.exported ?? awaited : d.phase === "base" ? awaited : undefined;
    resume = {
      variant: d.variant,
      phase: d.phase === "base" && !awaited ? "scene" : d.phase,
      steps,
      ...(d.remaining ? { remaining: d.remaining } : {}),
      ...(resumeAwaited ? { awaited: resumeAwaited } : {}),
    };
    cont.build.stop = undefined;
  }

  // 6. Run. A new batch replaces a stop the last run left: that one can no longer be continued.
  const build = cont ? cont.build : startBuild("batch");
  const replaced = cont ? undefined : build.replaced;
  const stopped: { stop?: BuildStop } = {};
  // RB-4: why the last write of the manifest failed (Unity or a scanner holding the file, a full disk), if it did.
  let manifestError: string | undefined;
  const writeManifest = (man: Manifest) => {
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(mergeManifest(earlier, man), null, 2));
      manifestError = undefined;
    } catch (e) {
      manifestError = e instanceof Error ? e.message : String(e);
    }
  };
  let m: Manifest;
  try {
    fs.mkdirSync(input.unity_dir, { recursive: true });
    m = await runBatch(bridge, input, writeManifest, {
      signal, onProgress: report, resume, fileExists: fs.existsSync, layerAnswer: build.layerAnswer,
      onStop: (d) => {
        const stop = recordStop(build, {
          step: d.step, ran: d.ran, text: d.text, waitMs: d.waitMs, data: d,
          ...(d.jobId ? { jobId: d.jobId } : {}),
          ...(d.question ? { question: d.question } : {}),
          ...(d.blockedBy ? { blockedBy: d.blockedBy } : {}),
          ...(d.asset ? { asset: d.asset } : {}),
          ...(d.answered ? { answered: d.answered } : {}),
        });
        stopped.stop = stop;
        return stop.id;
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // RB-4: a stop recorded before the error is kept: CC5 still waits in its question, and continue_after finishes it.
    const stop = stopped.stop;
    if (stop) {
      return errorResult(`${message}\nThe batch had stopped at ${stop.step} before that: ${stop.text}\nAfter the answer, ` +
        `call batch_generate_patients with continue_after "${stop.id}".`);
    }
    finishBuild(build);
    return errorResult(message);
  }
  if (!stopped.stop) finishBuild(build);
  return summarize(input, m, manifestPath, earlier, stopped.stop, replaced, manifestError);
}

export function registerBatchTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "batch_generate_patients",
    DESCRIPTION,
    BatchSchema.shape,
    async (rawInput, extra) => {
      // Checks that need no CC5 call, all synchronous: no other handler runs before claimScene, and a refused call
      // leaves CC5, the folder and the manifest as they were.
      const checked = BatchSchema.safeParse(rawInput);
      if (!checked.success) return errorResult(`Invalid batch: ${checked.error.issues.map((i) => i.message).join("; ")}`);
      const input = checked.data;
      if (!isLocalAbsolute(input.unity_dir)) {
        return errorResult(`unity_dir must be a local absolute folder inside a Unity project's Assets folder: ${input.unity_dir}`);
      }
      const folderError = unityFolderError(input.unity_dir);
      if (folderError) return errorResult(`${folderError}. Nothing was sent to CC5.`);
      if (!isLocalAbsolute(input.base_character) || path.extname(input.base_character).toLowerCase() !== ".ccavatar") {
        return errorResult("base_character must be a local absolute .ccAvatar path (no network/UNC paths)");
      }
      if (!fs.existsSync(input.base_character)) {
        return errorResult(`base_character not found: ${input.base_character}. Nothing was sent to CC5.`);
      }
      for (const v of input.variants) {
        const fileError = checkRecipeFiles(v.recipe, fs.existsSync);
        if (fileError) return errorResult(`Variant ${v.name}: ${fileError}`);
      }
      if (input.layer_answer !== undefined && input.continue_after === undefined) return errorResult(LAYER_WITHOUT_CONTINUE);
      let cont: Continuation | undefined;
      if (input.continue_after !== undefined) {
        const found = findContinuation(input, input.continue_after);
        if (typeof found === "string") return errorResult(found);
        cont = found;
      }
      // F-75: an FBX cannot carry overlays or pallor, and there is no default for how they reach Unity.
      const unchosen = input.variants.filter((v) => hasInjuries(v.recipe) && !(v.injuries ?? input.injuries));
      if (unchosen.length) {
        return errorResult(`Choose injuries ('bake', 'separate' or 'omit') for this batch or for variants ` +
          `${unchosen.map((v) => v.name).join(", ")}: they add skin overlays, a diffuse_blend texture or a pale skin ` +
          "condition, which an FBX cannot carry. Ask the user, then run the batch again. Nothing was sent to CC5.");
      }
      // F-80: the batch adds to the folder's manifest, so one it cannot read is not overwritten.
      const manifestPath = path.join(input.unity_dir, MANIFEST_FILE);
      let earlier: Manifest | null;
      try {
        earlier = readManifest(manifestPath);
      } catch (e) {
        return errorResult(`${manifestPath} exists but cannot be read (${e instanceof Error ? e.message : String(e)}): ` +
          "move or fix it first, so its entries are not lost. Nothing was sent to CC5.");
      }
      const release = claimScene(`batch_generate_patients (progress in ${manifestPath})`);
      if (typeof release === "string") return errorResult(release);
      try {
        return await runLocked({ bridge, signal: extra?.signal, report: progressReporter(extra) }, input, manifestPath,
          earlier, cont);
      } finally {
        release();
      }
    }
  );
}
