/**
 * Start a bridge job and poll until it finishes or the wait budget runs out.
 * Long CC5 operations (exports, batches) run as jobs so no HTTP request times out mid-operation.
 */

import { BridgeHttpError, type CC5Bridge } from "./cc5-bridge.js";
import type { CC5Dialog, JobStatus } from "./types.js";
import { bridgeErrorResult, errorResult, type ToolResult } from "./util.js";

/**
 * A finished job (with the button the wait clicked, if it answered a CC5 question), or one that has not finished:
 * still running when the wait ended, or waiting on a CC5 question (`dialog` is the ready-to-show text, `question`
 * the dialog itself, `blocked_by` the job whose question it is queued behind). `answered` on a job that has not
 * finished: the button the wait clicked in an earlier question of this job (RB-3).
 */
export type JobOutcome =
  | { done: true; failed: boolean; result: unknown; answered?: string }
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
  return {
    done: false,
    job_id: jobId,
    dialog: all.length ? `${job.dialog_message} (${all.join("; ")})` : job.dialog_message,
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
      return { done: true, failed: job.status === "failed", result: job.result, ...(answered !== undefined ? { answered } : {}) };
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
 * returns it as soon as the job reports one), else the usual "still running" note plus any extra hint.
 */
export function pendingResult(out: { job_id: string; dialog?: string }, extra = ""): ToolResult {
  if (out.dialog) return errorResult(out.dialog);
  return { content: [{ type: "text" as const, text: `${formatPending(out.job_id)}${extra ? ` ${extra}` : ""}` }] };
}

export function formatPending(jobId: string): string {
  return `Still running in CC5 (job ${jobId}). Call job_status with job_id "${jobId}" to get the result. Do not start the same operation again.`;
}

export type JobResult = { success?: boolean; error?: string };

/** A step's job result: the job's own fields (path, target, changes, notes, ...) plus how the step ended. */
export type StepOutcome = JobResult & { stopped?: StepStop; answered?: string; [key: string]: unknown };

/**
 * One step of a multi-step run (recipe, batch) as a job: a job that failed, or is still running when the wait
 * ends, becomes {success: false, error}. A slow load then cannot hit the bridge's 30 s limit for direct calls,
 * which answers "still running" while CC5 goes on to finish the step. A job that stopped on a CC5 question (also
 * one CC5 still reported when the wait ran out) carries `stopped` (its id, the question, the job it is queued behind
 * and the button the run clicked before), so the run can stop there.
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
  const finished: StepOutcome = out.answered !== undefined ? { ...result, answered: out.answered } : { ...result };
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
