import { describe, it, expect, beforeEach } from "vitest";
import { registerUnityTools, isInUnityAssets, isLocalAbsolute } from "../../src/tools/unity.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerUnityTools(server as any, bridge as any);
});

describe("isInUnityAssets", () => {
  it("accepts a folder under Assets", () => expect(isInUnityAssets("D:/Proj/Assets/Chars")).toBe(true));
  it("rejects a folder outside Assets", () => expect(isInUnityAssets("D:/Proj/Exports")).toBe(false));
});

describe("isLocalAbsolute", () => {
  it("accepts a local drive path", () => expect(isLocalAbsolute("D:/Proj/Assets/Chars")).toBe(true));
  it("rejects UNC, device and NT-prefixed paths", () => {
    for (const p of ["//host/share/Assets", String.raw`\\host\share\Assets`, String.raw`\\?\UNC\host\share\Assets`, String.raw`\??\UNC\host\share`]) {
      expect(isLocalAbsolute(p)).toBe(false);
    }
  });
});

describe("export_for_unity", () => {
  const handler = () => server.getRegisteredTool("export_for_unity");

  it("refuses a folder outside Assets without calling CC5", async () => {
    const r = await handler()({ unity_dir: "D:/Exports", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("refuses a network (UNC) folder without calling CC5", async () => {
    const r = await handler()({ unity_dir: "//fileserver/share/Game/Assets/Characters", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("runs the export as a job and lists files", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_1" });
    bridge.getJob.mockResolvedValue({
      job_id: "cmd_1", action: "export_for_unity", status: "done",
      result: { success: true, fbx: "D:/P/Assets/C/P1/P1.fbx", folder: "D:/P/Assets/C/P1", files: [{ path: "x.png", bytes: 1048576 }], notes: [] },
    });
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1" });
    expect(bridge.startJob).toHaveBeenCalledWith("export_for_unity", expect.objectContaining({ character_name: "P1" }));
    expect(r.content[0].text).toContain("P1.fbx");
    expect(r.isError).toBeUndefined();
  });

  it("returns the job id when the export outlasts the wait", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_9" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_9", action: "export_for_unity", status: "running" });
    const r = await handler()({ unity_dir: "D:/P/Assets/C", character_name: "P1", wait_seconds: 0 });
    expect(r.content[0].text).toContain("cmd_9");
  });
});
