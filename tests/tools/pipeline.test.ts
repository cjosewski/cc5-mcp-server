import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerPipelineTools, IMPORT_CHARACTER_DISABLED } from "../../src/tools/pipeline.js";
import { createMockBridge, mockJobs } from "../helpers/mock-bridge.js";
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

// apply_pose, save_character, replace_mesh_from_obj and load_substance_textures run as bridge jobs:
// past 30 s a direct call answers "still running" while CC5 goes on, so the tool would report a failure.
describe("apply_pose", () => {
  it("rejects traversal without calling CC5", async () => {
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "C:/a/../b.rlMotion" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("rejects a network (UNC) path without calling CC5", async () => {
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "//fileserver/share/Supine.rlMotion" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("applies a pose as a job", async () => {
    const started = mockJobs(bridge, { apply_pose: { success: true, method: "LoadFile" } });
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "C:/Poses/Supine.rlMotion" });
    expect(started).toEqual([{ action: "apply_pose", params: { file_path: "C:/Poses/Supine.rlMotion" } }]);
    expect(r.content[0].text).toBe("Applied pose Supine.rlMotion (LoadFile)");
  });

  it("returns the job id when the pose outlasts the wait", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_3" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_3", action: "apply_pose", status: "running" });
    vi.useFakeTimers();
    try {
      const pending = server.getRegisteredTool("apply_pose")({ file_path: "C:/Poses/Supine.rlMotion" });
      await vi.advanceTimersByTimeAsync(30_000);
      const r = await pending;
      expect(r.content[0].text).toContain('job_status with job_id "cmd_ab12cd34_3"');
      expect(r.isError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed pose as an error", async () => {
    mockJobs(bridge, { apply_pose: { success: false, error: "No avatar in scene" } });
    const r = await server.getRegisteredTool("apply_pose")({ file_path: "C:/Poses/Supine.rlMotion" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Failed: No avatar in scene");
  });
});

describe("save_character", () => {
  it("requires .ccAvatar", async () => {
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/a/b.fbx" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("saves the character as a job", async () => {
    const started = mockJobs(bridge, { save_character: { success: true, path: "C:/Bases/Male.ccAvatar" } });
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/Bases/Male.ccAvatar" });
    expect(started).toEqual([{ action: "save_character", params: { output_path: "C:/Bases/Male.ccAvatar" } }]);
    expect(r.content[0].text).toContain("Saved C:/Bases/Male.ccAvatar");
  });
});

describe("export_obj", () => {
  it("requires .obj", async () => {
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.fbx" });
    expect(r.isError).toBe(true);
  });

  it("exports", async () => {
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)", notes: [] });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.content[0].text).toBe("Exported C:/x/a.obj");
    expect(r.isError).toBeUndefined();
  });

  it("flags an OBJ written with the weaker call form, naming the form and what was dropped", async () => {
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path)",
      notes: ["WARNING: CC5 rejected (avatar, path, option) and (avatar, path) was used instead, so the OBJ options (bind pose, Y-up axis, body and clothing parts) were NOT applied"] });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("with (avatar, path)");
    expect(r.content[0].text).toContain("bind pose, Y-up axis");
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
  // Live CC5 5.13 (Task 18): LoadFbxFile opens CC5's own "Import Settings" (frame rate) dialog for some files, and
  // the job waits inside it until someone answers in CC5.
  it("says the import can wait for CC5's own import dialog", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "import_fbx")?.[1] as string;
    expect(description).toContain("Import Settings");
  });

  // Chad's ruling (2026-10-03): a whole-character import crashed CC5 5.13, so kind 'character' is switched off.
  it("refuses kind 'character' at once with the do-it-in-CC5 message, and sends CC5 nothing", async () => {
    for (const file_path of ["C:/a/Patient.fbx", "C:/a/b.obj"]) {
      const r = await server.getRegisteredTool("import_fbx")({ file_path, kind: "character" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(IMPORT_CHARACTER_DISABLED);
    }
    expect(IMPORT_CHARACTER_DISABLED).toContain("use File > Import in Character Creator 5");
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("says in its description that a whole character is imported by hand in CC5", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "import_fbx")?.[1] as string;
    expect(description).toContain("'character' is switched off");
    expect(description).toContain("File > Import in Character Creator 5");
    expect(description).not.toContain("Create Asset(s)");
  });

  it("asks to answer CC5's import dialog when the import is still running", async () => {
    vi.useFakeTimers();
    try {
      bridge.startJob.mockResolvedValue({ job_id: "cmd_7" });
      bridge.getJob.mockResolvedValue({ job_id: "cmd_7", action: "import_fbx", status: "running" });
      const pending = server.getRegisteredTool("import_fbx")({ file_path: "C:/a/Stretcher.fbx", kind: "prop" });
      await vi.advanceTimersByTimeAsync(30_000);
      const r = await pending;
      expect(r.content[0].text).toContain("cmd_7");
      expect(r.content[0].text).toContain("answer_cc5_dialog");
      expect(r.content[0].text).not.toContain("Create Asset(s)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects non-FBX", async () => {
    const r = await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/b.obj", kind: "prop" });
    expect(r.isError).toBe(true);
  });

  it("imports clothing as a job", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "import_fbx", status: "done", result: { success: true } });
    const r = await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/jacket.fbx", kind: "clothing" });
    expect(r.content[0].text).toBe("Imported jacket.fbx as clothing");
  });

  it("prints the meshes that did not import, and says not to import again", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "import_fbx", status: "done", result: {
      success: true, signature: "LoadClotheFromFbx(avatar, path, WStringVector)", failed_meshes: ["Jacket_Hood"],
      notes: ["WARNING: 1 clothing mesh(es) did not import: Jacket_Hood"] } });
    const r = await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/jacket.fbx", kind: "clothing" });
    expect(r.content[0].text).toContain("did not import: Jacket_Hood");
    expect(r.content[0].text).toContain("check the scene before importing again");
    expect(r.isError).toBeUndefined();
  });

  it("names the call form when CC5 rejected the import option", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_4", action: "import_fbx", status: "done", result: {
      success: true, signature: "LoadFbxFile(path)",
      notes: ["WARNING: CC5 rejected LoadFbxFile(path, option) and LoadFbxFile(path) was used instead, so CC5's default import option was used instead of EImportFbxOption_Prop"] } });
    const r = await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/stretcher.fbx", kind: "prop" });
    expect(r.content[0].text).toContain("(LoadFbxFile(path))");
    expect(r.content[0].text).toContain("default import option");
  });
});

describe("replace_mesh_from_obj", () => {
  it("passes mesh and path to a job", async () => {
    const started = mockJobs(bridge, { replace_mesh_from_obj: { success: true, mesh: "CC_Base_Body" } });
    const r = await server.getRegisteredTool("replace_mesh_from_obj")({ mesh_name: "CC_Base_Body", obj_path: "C:/s/body.obj" });
    expect(started).toEqual([{ action: "replace_mesh_from_obj", params: { mesh_name: "CC_Base_Body", obj_path: "C:/s/body.obj" } }]);
    expect(r.content[0].text).toBe("Replaced CC_Base_Body with body.obj");
  });
});

describe("load_texture", () => {
  it("rejects non-image files", async () => {
    const r = await server.getRegisteredTool("load_texture")({ mesh_name: "m", material_name: "x", channel: "diffuse", image_path: "C:/a/b.exe" });
    expect(r.isError).toBe(true);
  });

  it("loads into the channel", async () => {
    bridge.loadTexture.mockResolvedValue({ success: true });
    await server.getRegisteredTool("load_texture")({ mesh_name: "CC_Base_Body", material_name: "Std_Skin_Body", channel: "normal", image_path: "C:/t/n.png" });
    expect(bridge.loadTexture).toHaveBeenCalledWith("CC_Base_Body", "Std_Skin_Body", "normal", "C:/t/n.png");
  });
});

describe("load_substance_textures", () => {
  it("runs the import as a job", async () => {
    const started = mockJobs(bridge, { load_substance_textures: { success: true, signature: "(avatar, folder)" } });
    const r = await server.getRegisteredTool("load_substance_textures")({ folder: "C:/SP/export" });
    expect(started).toEqual([{ action: "load_substance_textures", params: { folder: "C:/SP/export" } }]);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("Applied Substance textures from C:/SP/export");
  });
});

describe("export_textures", () => {
  it("tells the agent to save the character before the session's first FBX export", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "export_textures")?.[1] as string;
    expect(description).toContain("save_character");
    expect(description).toContain("first FBX export");
  });

  it("runs as a job and reports the folder", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_5" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_5", action: "export_textures", status: "done",
      result: { success: true, folder: "C:/SP/P1", files: [{ path: "C:/SP/P1/P1.fbx", bytes: 10 }] } });
    const r = await server.getRegisteredTool("export_textures")({ output_dir: "C:/SP", character_name: "P1" });
    expect(bridge.startJob).toHaveBeenCalledWith("export_textures", { output_dir: "C:/SP", character_name: "P1" });
    expect(r.content[0].text).toContain("C:/SP/P1");
  });

  it("flags an export CC5 made without some of its settings", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_5" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_5", action: "export_textures", status: "done",
      result: { success: true, folder: "C:/SP/P1", files: [], notes: ["WARNING: EnableExportMotion failed: x"] } });
    const r = await server.getRegisteredTool("export_textures")({ output_dir: "C:/SP", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("WARNING: EnableExportMotion failed: x");
  });

  it("rejects a network (UNC) folder without starting a job", async () => {
    const r = await server.getRegisteredTool("export_textures")({ output_dir: "//fileserver/share/SP", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });
});

describe("import_fbx target (F-50)", () => {
  it("sends the character to dress for a clothing import", async () => {
    const started = mockJobs(bridge, { import_fbx: { success: true, signature: "LoadClotheFromFbx", notes: [] } });
    await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/Top.fbx", kind: "clothing", target: "Camila" });
    expect(started[0].params).toEqual({ file_path: "C:/a/Top.fbx", kind: "clothing", target: "Camila" });
  });

  it("refuses a target for a prop and sends CC5 nothing", async () => {
    const r = await server.getRegisteredTool("import_fbx")({ file_path: "C:/a/Box.fbx", kind: "prop", target: "Kevin" });
    expect(r.isError).toBe(true);
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("points to the dialog tools and the prop tools in its description", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "import_fbx")?.[1] as string;
    expect(description).toContain("answer_cc5_dialog");
    expect(description).toContain("set_object_transform");
    expect(description).toContain("delete_object");
  });
});
