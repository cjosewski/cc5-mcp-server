/**
 * Start a bridge job and poll until it finishes or the wait budget runs out.
 * Long CC5 operations (exports, batches) run as jobs so no HTTP request times out mid-operation.
 */

import { BridgeHttpError, type CC5Bridge } from "./cc5-bridge.js";
import type { CC5Dialog, JobStatus } from "./types.js";
import { bridgeErrorResult, errorResult, type ToolResult } from "./util.js";
import { formatDialog, isAnsweredOnlyInCC5 } from "./tools/dialog.js";
import { SKINGEN_QUESTION_RULE } from "./prompts/content-rules.js";

/** The buttons answer_cc5_dialog clicked while a job waited in a CC5 dialog, as its status lists them (F-98). */
export type JobAnswers = NonNullable<JobStatus["answers"]>;

/**
 * A finished job (with the button the wait clicked, if it answered a CC5 question, and `answers`, every button
 * answer_cc5_dialog clicked while it waited: F-98, a Cancel means CC5 did not do what was asked), or one that has not
 * finished: still running when the wait ended, or waiting on a CC5 question (`dialog` is the ready-to-show text,
 * `question` the dialog itself, `blocked_by` the job whose question it is queued behind). `answered` on a job that
 * has not finished: the button the wait clicked in an earlier question of this job (RB-3).
 */
export type JobOutcome =
  | { done: true; failed: boolean; result: unknown; answered?: string; answers?: JobAnswers }
  | { done: false; job_id: string; dialog?: string; question?: CC5Dialog; blocked_by?: string; answered?: string };

/** What the wait does about a CC5 question the job reports: it clicked a button, it waits on, or it stops. */
export type DialogDecision = { kind: "answered"; button: string } | { kind: "wait" } | { kind: "stop"; note?: string };

export type JobWaitOptions = {
  waitMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  /** Called while the job reports a CC5 question. Without it (or when it throws) the wait stops at the question. */
  onDialog?: (job: JobStatus) => Promise<DialogDecision>;
};

/**
 * The job a step stopped on, with the question it waits on or the job it is queued behind, and the button the run
 * clicked in an earlier question of that job (RB-3).
 */
export type StepStop = { job_id: string; question?: CC5Dialog; blocked_by?: string; answered?: string };

/**
 * RB-1 (D1): the note on a wait that ran out while the job's last poll still reported a CC5 question. The run stops
 * there instead of going on: the question may still be open in CC5 (or a newer window that followed it).
 */
export const STILL_ASKING_NOTE = "CC5 still reported this question when the wait ended; it may be a newer window";

/** Job ids carry the bridge's per-start nonce (cmd_<8 hex>_<n>); plain cmd_<n> is an older plugin's id. */
export const JOB_ID_PATTERN = /^cmd_(?:[0-9a-f]{8}_)?\d+$/;

/** True when the bridge says it does not know the job (HTTP 404): CC5 restarted and its job table is gone. */
export function isUnknownJob(err: unknown): boolean {
  return err instanceof BridgeHttpError && err.status === 404;
}

export function lostJobMessage(jobId: string): string {
  return `Job ${jobId} not found. CC5 was probably restarted and the job's result is lost. Check the output folder, then run the operation again.`;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Queue `action` as a bridge job and return its id. When `signal` has aborted, nothing is sent to CC5. */
export async function startJob(
  bridge: Pick<CC5Bridge, "startJob">,
  action: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return (await bridge.startJob(action, params)).job_id;
}

/** What a plugin older than batch F (server.py _waiting_dialog_error) tells the agent to do with every window. */
const ANSWER_WITH_TOOL = "answer it with answer_cc5_dialog";

/**
 * The text for job `jobId` waiting in a CC5 window, or queued behind one (`job.blocked_by`): the plugin's
 * dialog_message, except where it says to answer with answer_cc5_dialog a window that tool cannot answer (F-94: no
 * buttons, such as SkinGen's About box; F-99: buttons the bridge cannot read; review #8: text it could not read).
 * That window is worded as get_cc5_dialog words it, to answer or close in CC5 (review #3, #7, #19). A plugin from
 * batch F on words such a window itself, and its text is kept.
 */
export function jobDialogMessage(
  jobId: string,
  job: Pick<JobStatus, "dialog" | "dialog_message" | "blocked_by">,
): string | undefined {
  const { dialog, dialog_message: message, blocked_by: blockedBy } = job;
  if (typeof message !== "string" || !message.includes(ANSWER_WITH_TOOL) || !dialog || !isAnsweredOnlyInCC5(dialog)) {
    return message;
  }
  if (!blockedBy) return formatDialog(dialog, jobId);
  return `Job ${jobId} has not started: it is queued behind job ${blockedBy}, which waits in this window:\n` +
    `${formatDialog(dialog)}\nJob ${jobId} runs once that window has closed; read its result with ` +
    `job_status("${jobId}").`;
}

/** F-91: the words of the question CC5 asks before a content load ends a SkinGen session (SKINGEN_QUESTION). */
const SKINGEN_SESSION_WORDS = "deactivate the current skingen session";

/**
 * F-91: the text of a reply about a job waiting in a CC5 window (pendingResult: load_asset and every job tool;
 * job_status), with SKINGEN_QUESTION_RULE on its own line when that window is CC5's question before a content load
 * ends a SkinGen session: its words are in the dialog's title or text, or in the waiting text (a job status without
 * the dialog), with case and line breaks ignored. get_cc5_dialog adds the same line (formatDialog). A window the user
 * answers or closes in CC5 gets none (isAnsweredOnlyInCC5: no MCP tool can click its OK), and a text that has the rule
 * keeps it once. A recipe's or batch's WAIT line (runJobStep) is left as it was.
 */
export function withSkinGenRule(text: string, question?: CC5Dialog | null): string {
  // The job's record is JSON from the plugin: a text that is not one is shown as it came, never an exception.
  if (typeof text !== "string" || text.includes(SKINGEN_QUESTION_RULE)) return text;
  const asked = [question?.title, question?.text, text].some((t) => typeof t === "string" &&
    t.replace(/\s+/g, " ").toLowerCase().includes(SKINGEN_SESSION_WORDS));
  if (!asked || (question && isAnsweredOnlyInCC5(question))) return text;
  return `${text}\n${SKINGEN_QUESTION_RULE}`;
}

/**
 * The wait's stop at the question `job` reports: its text with the notes (why the wait stopped there, and the button
 * the run clicked in this job before, unless a note names that button already), the question, the job it is queued
 * behind, and that button.
 */
function stopAt(jobId: string, job: JobStatus, notes: string[], answered?: string): JobOutcome {
  const all = [...notes];
  if (answered !== undefined && !all.some((n) => n.includes(`'${answered}'`))) {
    all.push(`this run already answered 'Replace / Material Only' in this job with '${answered}'`);
  }
  const message = jobDialogMessage(jobId, job);
  return {
    done: false,
    job_id: jobId,
    dialog: all.length ? `${message} (${all.join("; ")})` : message,
    ...(job.dialog ? { question: job.dialog } : {}),
    ...(job.blocked_by ? { blocked_by: job.blocked_by } : {}),
    ...(answered !== undefined ? { answered } : {}),
  };
}

/**
 * Poll a job until it finishes, the wait budget runs out or `signal` aborts. Once the job is queued its id is the
 * only handle on it, so a failed poll (the 35 s request timeout, a reset connection) never loses it: polling goes on
 * until the budget is spent and the id is handed back. Only a 404 (CC5 no longer knows the job) ends the wait early.
 * A job waiting on a CC5 question (e.g. "Replace / Material Only") cannot finish without an answer: `onDialog`
 * decides whether the wait answered it, waits on, or stops and hands the question back. When the budget runs out
 * while the last poll that read the job still reported a question, the wait hands that question back as a stop
 * (RB-1, D1): a run must not go on while CC5 may still be asking. Every outcome that is not done carries the button
 * the wait clicked in this job, if any (RB-3).
 */
export async function awaitJob(
  bridge: Pick<CC5Bridge, "getJob">,
  jobId: string,
  opts: JobWaitOptions = {},
): Promise<JobOutcome> {
  const waitMs = opts.waitMs ?? 25_000;
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = Date.now() + waitMs;
  let answered: string | undefined;
  // The last status that reported a question, until a poll reads the job without one; a failed poll changes nothing.
  let asking: JobStatus | undefined;
  while (Date.now() < deadline && !opts.signal?.aborted) {
    let job: JobStatus | undefined = undefined;
    try {
      job = await bridge.getJob(jobId);
    } catch (err) {
      if (isUnknownJob(err)) throw new Error(lostJobMessage(jobId));
      console.error(`[CC5 Bridge] polling job ${jobId} failed; polling again:`, err);
    }
    if (job && (job.status === "done" || job.status === "failed")) {
      return {
        done: true, failed: job.status === "failed", result: job.result,
        ...(answered !== undefined ? { answered } : {}),
        ...(Array.isArray(job.answers) && job.answers.length ? { answers: job.answers } : {}),
      };
    }
    if (job) asking = job.dialog_message ? job : undefined;
    if (job?.dialog_message) {
      let decision: DialogDecision;
      try {
        decision = opts.onDialog ? await opts.onDialog(job) : { kind: "stop" };
      } catch (err) {
        console.error(`[CC5 Bridge] answering the question job ${jobId} waits on failed; stopping:`, err);
        decision = { kind: "stop" };
      }
      if (decision.kind === "stop") return stopAt(jobId, job, decision.note ? [decision.note] : [], answered);
      if (decision.kind === "answered") answered = decision.button;
    }
    await wait(pollMs, opts.signal);
  }
  if (asking && !opts.signal?.aborted) return stopAt(jobId, asking, [STILL_ASKING_NOTE], answered);
  return { done: false, job_id: jobId, ...(answered !== undefined ? { answered } : {}) };
}

/**
 * Start a job and wait for it (see awaitJob). When `signal` aborts, nothing new is started and the wait stops;
 * a job already queued keeps running in CC5.
 */
export async function runJob(
  bridge: Pick<CC5Bridge, "startJob" | "getJob">,
  action: string,
  params: Record<string, unknown>,
  opts: JobWaitOptions = {},
): Promise<JobOutcome> {
  return awaitJob(bridge, await startJob(bridge, action, params, opts.signal), opts);
}

/**
 * What a job tool says when its job has not finished: CC5's question when the job waits on a CC5 dialog (runJob
 * returns it as soon as the job reports one; a window the user answers or closes in CC5 is worded by
 * jobDialogMessage; CC5's question before a content load ends a SkinGen session gets its rule, F-91:
 * withSkinGenRule), else the usual "still running" note plus any extra hint.
 */
export function pendingResult(out: { job_id: string; dialog?: string; question?: CC5Dialog }, extra = ""): ToolResult {
  if (out.dialog) return errorResult(withSkinGenRule(out.dialog, out.question));
  return { content: [{ type: "text" as const, text: `${formatPending(out.job_id)}${extra ? ` ${extra}` : ""}` }] };
}

export function formatPending(jobId: string): string {
  return `Still running in CC5 (job ${jobId}). Call job_status with job_id "${jobId}" to get the result. Do not start the same operation again.`;
}

export type JobResult = { success?: boolean; error?: string };

/**
 * A step's job result: the job's own fields (path, target, changes, notes, ...) plus how the step ended, and on a
 * finished job the buttons answer_cc5_dialog clicked while it waited (`answers`, F-98).
 */
export type StepOutcome = JobResult & { stopped?: StepStop; answered?: string; answers?: JobAnswers; [key: string]: unknown };

/**
 * One step of a multi-step run (recipe, batch) as a job: a job that failed, or is still running when the wait
 * ends, becomes {success: false, error}. A slow load then cannot hit the bridge's 30 s limit for direct calls,
 * which answers "still running" while CC5 goes on to finish the step. A job that stopped on a CC5 question (also
 * one CC5 still reported when the wait ran out) carries `stopped` (its id, the question, the job it is queued behind
 * and the button the run clicked before), so the run can stop there. A finished job keeps its status's `answers`.
 */
export async function runJobStep(
  bridge: Pick<CC5Bridge, "startJob" | "getJob">,
  action: string,
  params: Record<string, unknown>,
  opts: JobWaitOptions = {},
): Promise<StepOutcome> {
  const out = await runJob(bridge, action, params, opts);
  if (!out.done) {
    if (out.dialog) {
      return {
        success: false,
        error: out.dialog,
        stopped: {
          job_id: out.job_id,
          ...(out.question ? { question: out.question } : {}),
          ...(out.blocked_by ? { blocked_by: out.blocked_by } : {}),
          ...(out.answered !== undefined ? { answered: out.answered } : {}),
        },
      };
    }
    return {
      success: false,
      error: `still running in CC5 as job ${out.job_id} (check it with job_status)`,
      ...(out.answered !== undefined ? { answered: out.answered } : {}),
    };
  }
  const raw = out.result;
  const result = (typeof raw === "object" && raw !== null ? raw : {}) as StepOutcome;
  const finished: StepOutcome = {
    ...result,
    ...(out.answered !== undefined ? { answered: out.answered } : {}),
    ...(out.answers ? { answers: out.answers } : {}),
  };
  return out.failed ? { ...finished, success: false, error: result.error ?? "failed" } : finished;
}

/** A tool that runs one action as a job: pending returns the job id, a failure is an error result. */
export async function runJobTool<R extends JobResult>(
  bridge: Pick<CC5Bridge, "startJob" | "getJob">,
  action: string,
  params: Record<string, unknown>,
  formatOk: (result: R) => string,
): Promise<ToolResult> {
  try {
    const out = await runJob(bridge, action, params);
    if (!out.done) return pendingResult(out);
    const result = (out.result ?? {}) as R;
    if (out.failed || result.success === false) return errorResult(`Failed: ${result.error ?? "unknown error"}`);
    return { content: [{ type: "text" as const, text: formatOk(result) }] };
  } catch (err) {
    return bridgeErrorResult(err);
  }
}
