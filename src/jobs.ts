/**
 * Start a bridge job and poll until it finishes or the wait budget runs out.
 * Long CC5 operations (exports, batches) run as jobs so no HTTP request times out mid-operation.
 */

import { BridgeHttpError, type CC5Bridge } from "./cc5-bridge.js";

export type JobOutcome =
  | { done: true; failed: boolean; result: unknown }
  | { done: false; job_id: string };

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

/**
 * Once the job is queued its id is the only handle on it, so a failed poll (the 35 s request timeout,
 * a reset connection) never loses it: polling continues until the wait budget is spent and the id is
 * handed back. Only a 404 (CC5 no longer knows the job) ends the wait early. When `signal` aborts,
 * nothing new is started and the wait stops; a job already queued keeps running in CC5.
 */
export async function runJob(
  bridge: Pick<CC5Bridge, "startJob" | "getJob">,
  action: string,
  params: Record<string, unknown>,
  opts: { waitMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<JobOutcome> {
  const waitMs = opts.waitMs ?? 25_000;
  const pollMs = opts.pollMs ?? 1_000;
  opts.signal?.throwIfAborted();
  const { job_id } = await bridge.startJob(action, params);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && !opts.signal?.aborted) {
    try {
      const job = await bridge.getJob(job_id);
      if (job.status === "done" || job.status === "failed") {
        return { done: true, failed: job.status === "failed", result: job.result };
      }
    } catch (err) {
      if (isUnknownJob(err)) throw new Error(lostJobMessage(job_id));
      console.error(`[CC5 Bridge] polling job ${job_id} failed; polling again:`, err);
    }
    await wait(pollMs, opts.signal);
  }
  return { done: false, job_id };
}

export function formatPending(jobId: string): string {
  return `Still running in CC5 (job ${jobId}). Call job_status with job_id "${jobId}" to get the result. Do not start the same operation again.`;
}
