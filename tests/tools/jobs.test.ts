import { describe, it, expect, beforeEach } from "vitest";
import { registerJobTools } from "../../src/tools/jobs.js";
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
  });
});
