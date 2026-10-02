import { describe, it, expect, beforeEach } from "vitest";
import { registerPipelineTools } from "../../src/tools/pipeline.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPipelineTools(server as any, bridge as any);
});

describe("apply_pose", () => {
  it("rejects traversal without calling CC5", async () => {
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "C:/a/../b.rlMotion" });
    expect(r.isError).toBe(true);
    expect(bridge.applyPose).not.toHaveBeenCalled();
  });

  it("rejects a network (UNC) path without calling CC5", async () => {
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "//fileserver/share/Supine.rlMotion" });
    expect(r.isError).toBe(true);
    expect(bridge.applyPose).not.toHaveBeenCalled();
  });

  it("applies a pose", async () => {
    bridge.applyPose.mockResolvedValue({ success: true, method: "LoadFile" });
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "C:/Poses/Supine.rlMotion" });
    expect(r.content[0].text).toContain("Supine.rlMotion");
  });
});

describe("save_character", () => {
  it("requires .ccAvatar", async () => {
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/a/b.fbx" });
    expect(r.isError).toBe(true);
  });

  it("saves the character", async () => {
    bridge.saveCharacter.mockResolvedValue({ success: true, path: "C:/Bases/Male.ccAvatar" });
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/Bases/Male.ccAvatar" });
    expect(bridge.saveCharacter).toHaveBeenCalledWith("C:/Bases/Male.ccAvatar");
    expect(r.content[0].text).toContain("Saved C:/Bases/Male.ccAvatar");
  });
});
