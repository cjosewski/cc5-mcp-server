/**
 * One recipe or batch run at a time can stop on a CC5 question and be continued (Chad, 2026-10-06, D1): the run
 * sends CC5 nothing more until the question is answered, and its report gives a continue_after id. The state
 * lives in this module, as in scene-lock.ts, so an MCP restart forgets it and a continuation is then refused.
 *
 * D3: CC5's "Replace / Material Only" question has no standing answer. The user answers the first one in a run;
 * that button, passed back as layer_answer with continue_after, answers the identical question for the rest of
 * that run only (Build.layerAnswer). A Cancel is never carried: after a Cancel the run goes on without layer_answer,
 * and the next identical question goes to the user again (RB-6).
 */

import { BridgeHttpError, type CC5Bridge } from "./cc5-bridge.js";
import type { CC5Dialog, DialogResult, JobStatus } from "./types.js";
import type { DialogDecision } from "./jobs.js";
import { formatDialog } from "./tools/dialog.js";

/** A continue_after id: the job a stopped step waits in, or stop_<n> for a step that never started. */
export const STOP_ID_PATTERN = /^(cmd_(?:[0-9a-f]{8}_)?\d+|stop_\d+)$/;
/** Words of CC5's "The target object layer already exists ... Replace / Material Only / Cancel" question (F-28). */
export const LAYER_EXPECT = "target object layer already exists";
/** The buttons a run may carry to later identical questions. Cancel is not one of them: it rejects one item. */
export const LAYER_ANSWERS = ["Replace", "Material Only"] as const;
export type LayerAnswer = (typeof LAYER_ANSWERS)[number];
/** Clicks per job before the run stops: CC5 asking again after that means the click is not taking. */
export const MAX_LAYER_CLICKS_PER_JOB = 3;
/** How long a check for an open CC5 dialog may take; a busy CC5 must not hold a call for the full request timeout. */
export const DIALOG_CHECK_MS = 3_000;

export type BuildKind = "recipe" | "batch";

/**
 * The texts CC5 sends when a command could not run because a window was open: the open-dialog guard's
 * (server.py _modal_dialog_error: a question, the Welcome page, a progress window, a window with no buttons such as
 * SkinGen's About box, F-85) and a command waiting in the question it opened (server.py _waiting_dialog_error, 409).
 */
export function isBlockedByDialog(text?: string): boolean {
  return /^(CC5 is waiting for an answer to |CC5's Welcome \/ What's New page|CC5 is busy with |CC5 has a window open with no buttons: )/
    .test(text ?? "");
}

/** A direct call that never started because CC5's queue did not move for 30 s (server.py _execute_sync, 504). */
export function isNotStartedTimeout(err: unknown): boolean {
  return err instanceof BridgeHttpError && err.status === 504 &&
    err.message.includes("Timed out before CC5 started the command");
}

/** The job a 409 "waiting for an answer" text names (it ends with job_status("<id>")). */
export function jobIdFromWaitingText(text: string): string | undefined {
  return /job_status\("(cmd_(?:[0-9a-f]{8}_)?\d+)"\)/.exec(text)?.[1];
}

const norm = (s: string): string => s.replace(/&/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const LAYER_BUTTONS = ["replace", "material only", "cancel"];

/** CC5's "Replace / Material Only / Cancel" question, and nothing else (no progress window, no extra button). */
export function isLayerQuestion(d?: CC5Dialog | null): boolean {
  if (!d || d.progress) return false;
  if (!norm(`${d.title ?? ""} ${d.text ?? ""}`).includes(LAYER_EXPECT)) return false;
  const buttons = (Array.isArray(d.buttons) ? d.buttons : []).map((b) => norm(String(b)));
  return buttons.length === LAYER_BUTTONS.length && LAYER_BUTTONS.every((b) => buttons.includes(b));
}

/** The same question read from a 409 text, for when the waiting job's record cannot be read. */
export function isLayerWaitingText(text?: string): boolean {
  const t = (text ?? "").toLowerCase();
  return t.includes(LAYER_EXPECT) && t.includes("buttons: replace, material only, cancel");
}

/**
 * What a check for an open CC5 dialog found: the dialog, null when none is open, or "unknown" when the check itself
 * failed (no reply in DIALOG_CHECK_MS, an error, or a reply that is no dialog check). RB-1: a caller that must not go
 * on blind (layerDialogHandler after a click that failed) tells "unknown" apart from "none".
 */
export async function checkDialog(bridge: Pick<CC5Bridge, "getDialog">): Promise<DialogResult | null | "unknown"> {
  let r: DialogResult | undefined;
  try {
    r = await bridge.getDialog(DIALOG_CHECK_MS);
  } catch {
    return "unknown";
  }
  if (!r || r.success === false) return "unknown";
  return r.dialog ? r : null;
}

/**
 * The dialog CC5 has open, or null: none, the check failed (a busy or unreachable CC5 must not block a call that
 * then fails cleanly with CC5's own text), or it is the question `allowJob` waits in.
 */
export async function openDialog(
  bridge: Pick<CC5Bridge, "getDialog">,
  opts: { allowJob?: string } = {},
): Promise<DialogResult | null> {
  const r = await checkDialog(bridge);
  if (r === null || r === "unknown") return null;
  if (opts.allowJob && r.waiting_job === opts.allowJob) return null;
  return r;
}

/**
 * A step that could not go on because of a CC5 window. ran: CC5 started (or queued) the command and it finishes
 * after the answer; false: it never ran. jobId: the job to wait for. question: the step's own question, if known.
 */
export type DialogStopInfo = { ran: boolean; jobId?: string; question?: CC5Dialog; text: string };

/**
 * Whether a failed direct call (setSkinColor, getAvatars, ...) stopped on a CC5 window. Never throws.
 * - 409: the command opened a question and keeps running as the job its text names.
 * - 400 with the open-dialog guard's text: it never ran.
 * - 504 "Timed out before CC5 started the command": it never ran; a stop only when a window is open now (a busy
 *   queue is not a question), and that window is not this step's own question.
 */
export async function dialogStopFromError(
  bridge: Pick<CC5Bridge, "getJob" | "getDialog">,
  err: unknown,
): Promise<DialogStopInfo | null> {
  try {
    if (!(err instanceof BridgeHttpError)) return null;
    const msg = err.message;
    if (err.status === 409) {
      const jobId = jobIdFromWaitingText(msg);
      let question: CC5Dialog | undefined;
      if (jobId) {
        try {
          question = (await bridge.getJob(jobId))?.dialog;
        } catch {
          // The 409 text still says what CC5 asks.
        }
      }
      return { ran: true, ...(jobId ? { jobId } : {}), ...(question ? { question } : {}), text: msg };
    }
    if (err.status === 400 && isBlockedByDialog(msg)) return { ran: false, text: msg };
    if (isNotStartedTimeout(err)) {
      const d = await openDialog(bridge);
      return d?.dialog ? { ran: false, text: `${msg}\n${formatDialog(d.dialog, d.waiting_job)}` } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Where a run stopped. ran: CC5 started or queued the step, and it finishes after the answer; false: it never
 * started and must run again. jobId: the job to wait for before going on. text: the WAIT detail. layer: the
 * stopped command's own question is "Replace / Material Only", for the user to answer. answered: the button the run
 * clicked in an earlier question of that job (RB-3: the step that finishes after the answer names it). data: a
 * recipe's RecipeStopData, or the batch's resume state.
 */
export type BuildStop = {
  id: string;
  kind: BuildKind;
  step: string;
  ran: boolean;
  jobId?: string;
  question?: CC5Dialog;
  blockedBy?: string;
  text: string;
  layer: boolean;
  waitMs: number;
  asset?: string;
  answered?: string;
  data?: unknown;
};

/** One run (a recipe or a batch with its continuations). */
export type Build = { kind: BuildKind; layerAnswer?: LayerAnswer; stop?: BuildStop; replaced?: BuildStop };

let current: Build | undefined;
// Module-wide and never reset: a stop_<n> id never repeats in one MCP process, so an old id cannot match a newer stop.
let stopCounter = 0;

/** Start a run. A stop left by the run before cannot be continued any more: it is kept in `replaced` for the report. */
export function startBuild(kind: BuildKind): Build {
  const b: Build = { kind, ...(current?.stop ? { replaced: current.stop } : {}) };
  current = b;
  return b;
}

/** The current run and its stop, when `id` is where the last run of this kind stopped. */
export function findStop(kind: BuildKind, id: string): { build: Build; stop: BuildStop } | undefined {
  const b = current;
  if (!b || b.kind !== kind || !b.stop || b.stop.id !== id) return undefined;
  return { build: b, stop: b.stop };
}

export function currentStop(): BuildStop | undefined {
  return current?.stop;
}

/**
 * Record where `build` stopped. Only the stopped command's own question can be the user's layer question: a window
 * that blocked the step from outside, or a job queued behind another job's question, never is; nor is a question in
 * a job the run already answered with its layer answer (CC5 asking again is no fresh choice for the user).
 */
export function recordStop(build: Build, s: Omit<BuildStop, "id" | "kind" | "layer">): BuildStop {
  const id = s.jobId ?? `stop_${++stopCounter}`;
  const layer = Boolean(s.jobId) && !s.blockedBy && s.answered === undefined &&
    (isLayerQuestion(s.question) || (!s.question && isLayerWaitingText(s.text)));
  const stop: BuildStop = { ...s, id, kind: build.kind, layer };
  build.stop = stop;
  return stop;
}

export function finishBuild(build: Build): void {
  if (current === build) current = undefined;
}

/**
 * Take the user's button for the rest of this run (D3). Returns the refusal text, or null when it is taken (or
 * already is). Call it only inside the scene lock, so a call the lock refuses never stores an answer.
 */
export function carryLayerAnswer(build: Build, stop: BuildStop, answer: string): string | null {
  const canonical = LAYER_ANSWERS.find((a) => a.toLowerCase() === answer.toLowerCase());
  if (!canonical) {
    return "layer_answer must be 'Replace' or 'Material Only' (a Cancel is not carried to later questions). Nothing was sent to CC5.";
  }
  if (build.layerAnswer) {
    if (build.layerAnswer === canonical) return null;
    return `This run already answers 'Replace / Material Only' with '${build.layerAnswer}' (the user's first answer); ` +
      "it does not change within the run. Nothing was sent to CC5.";
  }
  if (!stop.layer) {
    return "layer_answer answers only CC5's 'Replace / Material Only' question, and this run stopped on a different one. " +
      "Go on without layer_answer. Nothing was sent to CC5.";
  }
  build.layerAnswer = canonical;
  return null;
}

/**
 * Click the run's answer in the question `job` waits in, when that is CC5's "Replace / Material Only" question.
 * Returns the button clicked, or null (no answer, another question, a queued job, or the click was refused).
 */
export async function answerLayerQuestion(
  bridge: Pick<CC5Bridge, "answerDialog">,
  job: JobStatus,
  answer?: string,
): Promise<string | null> {
  if (!answer || job.blocked_by || !isLayerQuestion(job.dialog)) return null;
  const wanted = norm(answer);
  if (!(job.dialog?.buttons ?? []).some((b) => norm(String(b)) === wanted)) return null;
  try {
    const r = await bridge.answerDialog(answer, LAYER_EXPECT);
    return r?.success ? r.clicked ?? answer : null;
  } catch {
    return null;
  }
}

/**
 * The wait's onDialog for a run that carries the user's answer: it answers CC5's "Replace / Material Only" question
 * with it and stops on every other question. A job's record can still show the question after the click (it lags
 * until the load pumps events again), so a repeat is clicked only when the live dialog is that question again,
 * waiting on the same job, and at most MAX_LAYER_CLICKS_PER_JOB times. A first click that failed waits only when a
 * dialog check worked and shows no such question for the job: when CC5 did not answer the check either, the click
 * may still be pending in a window nobody sees (RB-1), so the wait stops. Without an answer there is no handler.
 */
export function layerDialogHandler(
  bridge: Pick<CC5Bridge, "answerDialog" | "getDialog">,
  answer?: LayerAnswer,
): ((job: JobStatus) => Promise<DialogDecision>) | undefined {
  if (!answer) return undefined;
  const clicks = new Map<string, number>();
  const notClicked = `this run's answer '${answer}' could not be clicked; answer it in CC5 or with answer_cc5_dialog`;
  const unchecked = `this run's answer '${answer}' may not have been clicked, and CC5 did not answer a check for ` +
    "open dialogs; look at CC5 (get_cc5_dialog) before going on";
  return async (job: JobStatus): Promise<DialogDecision> => {
    if (job.blocked_by || !isLayerQuestion(job.dialog)) return { kind: "stop" };
    const count = clicks.get(job.job_id) ?? 0;
    if (count === 0) {
      const button = await answerLayerQuestion(bridge, job, answer);
      if (button !== null) {
        clicks.set(job.job_id, 1);
        return { kind: "answered", button };
      }
      const live = await checkDialog(bridge);
      if (live === "unknown") return { kind: "stop", note: unchecked };
      if (live && isLayerQuestion(live.dialog) && live.waiting_job === job.job_id) {
        return { kind: "stop", note: notClicked };
      }
      return { kind: "wait" };
    }
    // After a click that worked, a check that fails waits (CC5 may not serve its dialog lane while it finishes the
    // load): awaitJob stops at its deadline if the job still reports the question then.
    const live = await openDialog(bridge);
    if (!live || !isLayerQuestion(live.dialog) || live.waiting_job !== job.job_id) return { kind: "wait" };
    if (count < MAX_LAYER_CLICKS_PER_JOB) {
      const button = await answerLayerQuestion(bridge, { ...job, dialog: live.dialog ?? undefined }, answer);
      if (button !== null) {
        clicks.set(job.job_id, count + 1);
        return { kind: "answered", button };
      }
      return { kind: "stop", note: notClicked };
    }
    return {
      kind: "stop",
      note: `this run already answered it ${count} times with '${answer}'; CC5 is asking again or did not take that click`,
    };
  };
}
