import { describe, it, expect, vi } from "vitest";
import { runJob, JOB_ID_PATTERN } from "../src/jobs.js";
import { BridgeHttpError, BridgeUnreachableError } from "../src/cc5-bridge.js";

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

  it("keeps polling after a failed status poll instead of losing the job", async () => {
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_ab12cd34_4" }),
      getJob: vi.fn()
        .mockRejectedValueOnce(new BridgeUnreachableError("No reply from CC5 within 35s."))
        .mockResolvedValueOnce({ status: "done", result: { success: true, fbx: "a.fbx" } }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "export_for_unity", {}, { waitMs: 1000, pollMs: 1 });
    expect(out).toEqual({ done: true, failed: false, result: { success: true, fbx: "a.fbx" } });
    expect(b.getJob).toHaveBeenCalledTimes(2);
  });

  it("returns the job id when every poll fails until the wait runs out", async () => {
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_ab12cd34_5" }),
      getJob: vi.fn().mockRejectedValue(new BridgeUnreachableError("fetch failed (read ECONNRESET)")),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "export_for_unity", {}, { waitMs: 20, pollMs: 1 });
    expect(out).toEqual({ done: false, job_id: "cmd_ab12cd34_5" });
  });

  it("says the job was lost when CC5 no longer knows it (404)", async () => {
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_ab12cd34_6" }),
      getJob: vi.fn().mockRejectedValue(new BridgeHttpError("Unknown job: cmd_ab12cd34_6", 404)),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runJob(b as any, "export_for_unity", {}, { waitMs: 1000, pollMs: 1 }))
      .rejects.toThrow("Job cmd_ab12cd34_6 not found. CC5 was probably restarted");
    expect(b.getJob).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when already cancelled, and stops waiting (keeping the id) when cancelled later", async () => {
    const idle = { startJob: vi.fn(), getJob: vi.fn() };
    const cancelled = new AbortController();
    cancelled.abort();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runJob(idle as any, "a", {}, { signal: cancelled.signal })).rejects.toBeDefined();
    expect(idle.startJob).not.toHaveBeenCalled();

    const ac = new AbortController();
    const b = {
      startJob: vi.fn().mockResolvedValue({ job_id: "cmd_ab12cd34_8" }),
      getJob: vi.fn().mockImplementation(async () => { ac.abort(); return { status: "running" }; }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await runJob(b as any, "a", {}, { waitMs: 60_000, pollMs: 60_000, signal: ac.signal });
    expect(out).toEqual({ done: false, job_id: "cmd_ab12cd34_8" });
    expect(b.getJob).toHaveBeenCalledTimes(1);
  });
});

describe("JOB_ID_PATTERN", () => {
  it("accepts ids with the bridge's per-start nonce and older plain ids", () => {
    expect(JOB_ID_PATTERN.test("cmd_0f3a9b2c_12")).toBe(true);
    expect(JOB_ID_PATTERN.test("cmd_12")).toBe(true);
    expect(JOB_ID_PATTERN.test("cmd_xyz_12")).toBe(false);
    expect(JOB_ID_PATTERN.test("cmd_0f3a9b2c_12\n")).toBe(false);
  });
});
