import { describe, it, expect, vi } from "vitest";
import { runJob } from "../src/jobs.js";

function bridgeWith(statuses: Array<Record<string, unknown>>) {
  return {
    startJob: vi.fn().mockResolvedValue({ job_id: "cmd_1" }),
    getJob: vi.fn().mockImplementation(() => Promise.resolve(statuses.shift())),
  };
}

describe("runJob", () => {
  it("returns the result once the job is done", async () => {
    const b = bridgeWith([{ status: "running" }, { status: "done", result: { success: true } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "export_for_unity", {}, { waitMs: 1000, pollMs: 1 });
    expect(out).toEqual({ done: true, failed: false, result: { success: true } });
  });

  it("reports failure", async () => {
    const b = bridgeWith([{ status: "failed", result: { success: false, error: "x" } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "a", {}, { waitMs: 1000, pollMs: 1 });
    expect(out).toMatchObject({ done: true, failed: true });
  });

  it("hands back the job id when it outlasts the wait", async () => {
    const b = { startJob: vi.fn().mockResolvedValue({ job_id: "cmd_7" }), getJob: vi.fn().mockResolvedValue({ status: "running" }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "a", {}, { waitMs: 5, pollMs: 1 });
    expect(out).toEqual({ done: false, job_id: "cmd_7" });
  });
});
