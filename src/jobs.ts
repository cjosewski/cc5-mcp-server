/**
 * Start a bridge job and poll until it finishes or the wait budget runs out.
 * Long CC5 operations (exports, batches) run as jobs so no HTTP request times out mid-operation.
 */

import type { CC5Bridge } from "./cc5-bridge.js";

export type JobOutcome =
  | { done: true; failed: boolean; result: unknown }
  | { done: false; job_id: string };

export async function runJob(
  bridge: Pick<CC5Bridge, "startJob" | "getJob">,
  action: string,
  params: Record<string, unknown>,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<JobOutcome> {
  const waitMs = opts.waitMs ?? 25_000;
  const pollMs = opts.pollMs ?? 1_000;
  const { job_id } = await bridge.startJob(action, params);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const job = await bridge.getJob(job_id);
    if (job.status === "done" || job.status === "failed") {
      return { done: true, failed: job.status === "failed", result: job.result };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { done: false, job_id };
}

export function formatPending(jobId: string): string {
  return `Still running in CC5 (job ${jobId}). Call job_status with job_id "${jobId}" to get the result. Do not start the same operation again.`;
}
