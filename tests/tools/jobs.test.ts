import { describe, it, expect, beforeEach } from "vitest";
import { registerJobTools } from "../../src/tools/jobs.js";
import { BridgeHttpError, BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerJobTools(server as any, bridge as any);
});

describe("job_status", () => {
  it("reports a running job", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "running" });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.content[0].text).toContain("Still running");
  });

  it("returns the finished result as JSON", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "x", status: "done", result: { success: true, fbx: "a.fbx" } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.content[0].text).toContain("a.fbx");
    expect(r.isError).toBeUndefined();
  });

  it("flags a failed job as an error", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "failed", result: { success: false, error: "disk full" } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("disk full");
  });

  it("flags a finished export that ran without some of its settings", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "a.fbx", notes: ["WARNING: SetOption2 failed, flags2 NOT applied: x"] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Finished with warnings \(export_for_unity\)/);
  });

  it("labels an import with warnings without making it an error (repeating it would import twice)", async () => {
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "import_fbx", status: "done",
      result: { success: true, notes: ["WARNING: 1 clothing mesh(es) did not import: Hood"] } });
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_3" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^Finished with warnings \(import_fbx\)/);
  });

  it("says the job was lost in a CC5 restart when the bridge no longer knows it", async () => {
    bridge.getJob.mockRejectedValue(new BridgeHttpError("Unknown job: cmd_0f3a9b2c_12", 404));
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_0f3a9b2c_12" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(
      "Job cmd_0f3a9b2c_12 not found. CC5 was probably restarted and the job's result is lost. Check the output folder, then run the operation again.");
  });

  it("asks whether CC5 is running when it cannot be reached", async () => {
    bridge.getJob.mockRejectedValue(new BridgeUnreachableError("fetch failed"));
    const r = await server.getRegisteredTool("job_status")({ job_id: "cmd_0f3a9b2c_12" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Is CC5 running");
  });
});
