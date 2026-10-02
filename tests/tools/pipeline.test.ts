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

describe("export_obj", () => {
  it("requires .obj", async () => {
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.fbx" });
    expect(r.isError).toBe(true);
  });

  it("exports", async () => {
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)" });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.content[0].text).toContain("a.obj");
  });
});

describe("export_goz", () => {
  it("runs as a job and reports the folder", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_2" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_2", action: "export_goz", status: "done",
      result: { success: true, folder: "C:/GoZ/P1", files: [{ path: "C:/GoZ/P1/Body.GoZ", bytes: 10 }] } });
    const r = await server.getRegisteredTool("export_goz")({ output_dir: "C:/GoZ/P1", pose: "tpose" });
    expect(bridge.startJob).toHaveBeenCalledWith("export_goz", { output_dir: "C:/GoZ/P1", pose: "tpose" });
    expect(r.content[0].text).toContain("C:/GoZ/P1");
  });

  it("warns when the pose was not applied", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_3" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_3", action: "export_goz", status: "done",
      result: { success: true, folder: "C:/GoZ/P1", files: [], pose_applied: false } });
    const r = await server.getRegisteredTool("export_goz")({ output_dir: "C:/GoZ/P1", pose: "apose" });
    expect(r.content[0].text).toContain("WARNING");
  });

  it("rejects a network (UNC) folder without starting a job", async () => {
    const r = await server.getRegisteredTool("export_goz")({ output_dir: "//fileserver/share/GoZ", pose: "tpose" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("reports a failed job as an error", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "export_goz", status: "failed",
      result: { success: false, error: "No avatar in scene" } });
    const r = await server.getRegisteredTool("export_goz")({ output_dir: "C:/GoZ/P1", pose: "tpose" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("No avatar in scene");
  });
});

describe("import_fbx", () => {
  it("rejects non-FBX", async () => {
    const r = await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/b.obj", kind: "prop" });
    expect(r.isError).toBe(true);
  });

  it("imports clothing as a job", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "import_fbx", status: "done", result: { success: true } });
    const r = await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/jacket.fbx", kind: "clothing" });
    expect(r.content[0].text).toContain("jacket.fbx");
  });
});

describe("replace_mesh_from_obj", () => {
  it("passes mesh and path", async () => {
    bridge.replaceMeshFromObj.mockResolvedValue({ success: true });
    await server.getRegisteredTool("replace_mesh_from_obj")({ mesh_name: "CC_Base_Body", obj_path: "C:/s/body.obj" });
    expect(bridge.replaceMeshFromObj).toHaveBeenCalledWith("CC_Base_Body", "C:/s/body.obj");
  });
});
