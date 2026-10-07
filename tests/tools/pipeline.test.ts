import fs from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerPipelineTools, IMPORT_CHARACTER_DISABLED, IMAGE_TYPES_TEXT, EXPORT_OBJ_DESCRIPTION, EXPORT_GOZ_DESCRIPTION,
  REPLACE_MESH_DESCRIPTION, REPLACE_MESH_ANIMATION_RULE, OBJ_Y_UP, OBJ_NEUTRAL_FACE, OBJ_EXPRESSION_PREFIX,
  REPLACE_RETRY_MS,
} from "../../src/tools/pipeline.js";
import { RecipeSchema } from "../../src/recipe.js";
import { BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { TIMELINE_LEFT_LINE, TIMELINE_NOT_RESTORED_PREFIX, TIMELINE_USABLE_LINE } from "../../src/tools/unity.js";
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

  // F-77: a .ccAvatar keeps neither the facial expression nor the pose (the pose is not read back: static text).
  const NOT_KEPT = "A .ccAvatar keeps neither the facial expression nor the pose: after loading it the face is neutral and " +
    "the body is back in its default pose; re-apply them with set_expression and apply_pose, or with expression and " +
    "pose_file steps in each batch variant.";

  it("says nothing more for a neutral face", async () => {
    mockJobs(bridge, { save_character: { success: true, path: "C:/Bases/Male.ccAvatar", expression_not_saved: [] } });
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/Bases/Male.ccAvatar" });
    expect(r.content[0].text).toBe("Saved C:/Bases/Male.ccAvatar");
  });

  it("lists the expression the .ccAvatar did not keep, as an expression step a batch variant can use", async () => {
    const sliders = [{ name: "Brow_Raise_Inner_L", weight: 0.6 }, { name: "Mouth_Frown_L", weight: 0.4 }];
    mockJobs(bridge, { save_character: { success: true, path: "C:/Bases/Male.ccAvatar", expression_not_saved: sliders } });
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/Bases/Male.ccAvatar" });
    const text = r.content[0].text;
    expect(r.isError).toBeUndefined();
    expect(text).toBe("Saved C:/Bases/Male.ccAvatar\nNot saved: the facial expression (2 sliders: Brow_Raise_Inner_L 0.6, "
      + "Mouth_Frown_L 0.4). A .ccAvatar keeps neither the facial expression nor the pose: to keep this expression, give each "
      + `batch variant this expression step: ${JSON.stringify(sliders)}`);
    const step = JSON.parse(text.slice(text.indexOf("expression step: ") + "expression step: ".length));
    expect(RecipeSchema.shape.expression.parse(step)).toEqual(sliders);
  });

  it("says one slider, not one sliders", async () => {
    mockJobs(bridge, { save_character: { success: true, path: "C:/a.ccAvatar", expression_not_saved: [{ name: "A", weight: 1 }] } });
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/a.ccAvatar" });
    expect(r.content[0].text).toContain("(1 slider: A 1)");
  });

  it("says what a .ccAvatar does not keep when the plugin could not read the expression (or is older)", async () => {
    mockJobs(bridge, { save_character: { success: true, path: "C:/Bases/Male.ccAvatar",
      notes: ["Could not read the facial expression; a .ccAvatar keeps neither the facial expression nor the pose in any case."] } });
    const r = await server.getRegisteredTool("save_character")({ output_path: "C:/Bases/Male.ccAvatar" });
    expect(r.content[0].text).toBe(`Saved C:/Bases/Male.ccAvatar\n${NOT_KEPT}`);
  });

  it("says in its description that a .ccAvatar keeps neither the expression nor the pose", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "save_character")?.[1] as string;
    expect(description).toContain(NOT_KEPT);
  });
});

// F-83 (live CC5 5.13): CC5 reads an OBJ as the mesh in the character's current pose, and export_obj writes the T-pose.
const TPOSE_NOTE = "The OBJ is in CC5's T-pose (arms horizontal). Sculpt it without changing the pose; " +
  "replace_mesh_from_obj removes the character's pose to read it back.";
const POSE_REMOVED = "The character's pose was removed so that CC5 reads the OBJ in the T-pose; it stands in a T-pose " +
  "now. Apply a pose again with apply_pose if needed.";
// F-88 (live CC5 5.13): the OBJ carries the facial expression, and a replace with it set baked it into the mesh.
const EXPRESSION_NOTE = `${OBJ_EXPRESSION_PREFIX}Brow_Compress_L 0.6, Brow_Compress_R 0.6, Eye_Squint_L 0.3 and 3 more ` +
  "(this reply lists every slider with its weight). Do not bring this OBJ back with replace_mesh_from_obj, not even " +
  "after reset_expression: the expression is part of this OBJ, and the replace would make it part of the mesh without " +
  "noticing (its check would pass). For a round trip, run reset_expression, export again with export_obj and edit that " +
  "OBJ; after the replace, set the expression again with these weights.";
// Review #5: the note and the refusal name three sliders; the result's expression_weights hold every one (the six
// sliders of the live F-88 case), which the reply gives as one line to set the expression again.
const EXPRESSION_WEIGHTS = { Brow_Compress_L: 0.6, Brow_Compress_R: 0.6, Eye_Squint_L: 0.3, Eye_Squint_R: 0.3,
  Mouth_Frown_L: 0.4, Mouth_Frown_R: 0.4 };
const SET_AGAIN = "To set the expression again: set_expression with Brow_Compress_L 0.6, Brow_Compress_R 0.6, " +
  "Eye_Squint_L 0.3, Eye_Squint_R 0.3, Mouth_Frown_L 0.4, Mouth_Frown_R 0.4";
const description = (tool: string) => server.tool.mock.calls.find((c) => c[0] === tool)?.[1] as string;

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

  it("passes on the plugin's note that the OBJ is in CC5's T-pose", async () => {
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)", notes: [TPOSE_NOTE] });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`Exported C:/x/a.obj\n${TPOSE_NOTE}`);
  });

  it("says the OBJ is in CC5's T-pose, that the pose stays while sculpting, and that the round trip needs Y-up and a neutral face", () => {
    expect(description("export_obj")).toBe(EXPORT_OBJ_DESCRIPTION);
    expect(EXPORT_OBJ_DESCRIPTION).toBe("Export the current character as OBJ in CC5's T-pose (arms horizontal), for " +
      "sculpting in ZBrush or Blender. Keep the pose while sculpting, then bring the mesh back with replace_mesh_from_obj, " +
      "which needs a Y-up OBJ (export with y_up true, and save Y-up from the sculpting tool) and a neutral face " +
      "(reset_expression before export_obj; set the expression again after the replace).");
    // F-88: the same clause in replace_mesh_from_obj's description.
    expect(OBJ_NEUTRAL_FACE).toBe("a neutral face (reset_expression before export_obj; set the expression again after the replace)");
  });

  // F-88: the export ran as asked; the OBJ may be wanted for other uses, but replace_mesh_from_obj refuses it.
  it("passes on the plugin's note on the expression the OBJ carries, as a result", async () => {
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)",
      notes: [TPOSE_NOTE, EXPRESSION_NOTE] });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`Exported C:/x/a.obj\n${TPOSE_NOTE}\n${EXPRESSION_NOTE}`);
    expect(r.content[0].text).not.toContain("not as asked");
  });

  it("ends with every slider's weight, as one line to set the expression again (review #5)", async () => {
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)",
      notes: [TPOSE_NOTE, EXPRESSION_NOTE], expression_weights: EXPRESSION_WEIGHTS });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`Exported C:/x/a.obj\n${TPOSE_NOTE}\n${EXPRESSION_NOTE}\n${SET_AGAIN}`);
  });

  it("gives that line after the expression note when a weaker call form was used, and adds none for no weights", async () => {
    const formWarning = "WARNING: CC5 rejected (avatar, path, option) and (avatar, path) was used instead, so the OBJ " +
      "options (Y-up axis, body and clothing parts, materials) were NOT applied, and the OBJ may not be in CC5's T-pose";
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path)",
      notes: [formWarning, EXPRESSION_NOTE], expression_weights: EXPRESSION_WEIGHTS });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Exported C:/x/a.obj with (avatar, path), not as asked:\n${formWarning}\n` +
      `Do not sculpt on this OBJ or bring it back with replace_mesh_from_obj.\n${EXPRESSION_NOTE}\n${SET_AGAIN}`);
    for (const expression_weights of [{}, { Brow_Compress_L: "0.6", Mouth_Frown_L: null }, [0.6], null]) {
      bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)",
        notes: [TPOSE_NOTE], expression_weights });
      const plain = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
      expect(plain.content[0].text).toBe(`Exported C:/x/a.obj\n${TPOSE_NOTE}`);
    }
  });

  it("shows CC5's float32 weights to 4 decimals at most, as set_expression does", async () => {
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)",
      notes: [], expression_weights: { Brow_Raise_Inner_L: 0.6000000238418579, Jaw_Open: 0.123456 } });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.content[0].text).toBe("Exported C:/x/a.obj\nTo set the expression again: set_expression with " +
      "Brow_Raise_Inner_L 0.6, Jaw_Open 0.1235");
  });

  it("passes on the plugin's note when it could not read the expression", async () => {
    const notRead = "Could not read the facial expression: the OBJ carries any expression the face shows, and " +
      "replace_mesh_from_obj refuses while the expression cannot be read.";
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)",
      notes: [TPOSE_NOTE, notRead] });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`Exported C:/x/a.obj\n${TPOSE_NOTE}\n${notRead}`);
  });

  it("keeps the expression note out of the options a weaker call form dropped", async () => {
    const formWarning = "WARNING: CC5 rejected (avatar, path, option) and (avatar, path) was used instead, so the OBJ " +
      "options (Y-up axis, body and clothing parts, materials) were NOT applied, and the OBJ may not be in CC5's T-pose";
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path)",
      notes: [formWarning, EXPRESSION_NOTE] });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Exported C:/x/a.obj with (avatar, path), not as asked:\n${formWarning}\n` +
      `Do not sculpt on this OBJ or bring it back with replace_mesh_from_obj.\n${EXPRESSION_NOTE}`);
  });

  it("tells the expression note apart by the plugin's prefix (cc5_pipeline.py)", () => {
    const plugin = fs.readFileSync(new URL("../../cc5-plugin/cc5_pipeline.py", import.meta.url), "utf-8");
    expect(/^OBJ_EXPRESSION_PREFIX = "([^"]*)"/m.exec(plugin)?.[1]).toBe(OBJ_EXPRESSION_PREFIX);
    expect(OBJ_EXPRESSION_PREFIX).toBe("WARNING: the OBJ carries the facial expression: ");
  });

  it("passes on the plugin's note that a Z-up OBJ cannot come back, as a result: the axis was asked for", async () => {
    const zUpNote = "The OBJ is Z-up (y_up false), in CC5's T-pose. replace_mesh_from_obj cannot bring it back, as it " +
      "reads only Y-up OBJs: for the round trip, export again with y_up true (the default).";
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path, option)", notes: [zUpNote] });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj", y_up: false });
    expect(bridge.exportObj).toHaveBeenCalledWith("C:/x/a.obj", false);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`Exported C:/x/a.obj\n${zUpNote}`);
  });

  // TS-8 (DT-3): replace_mesh_from_obj checks the OBJ against a Y-up T-pose export and refuses a Z-up OBJ.
  it("says in the y_up description that replace_mesh_from_obj needs a Y-up OBJ and refuses a Z-up one", () => {
    expect(OBJ_Y_UP).toBe("a Y-up OBJ (export with y_up true, and save Y-up from the sculpting tool)");
    const shape = server.tool.mock.calls.find((c) => c[0] === "export_obj")?.[2] as Record<string, { description?: string }>;
    expect(shape.y_up.description).toBe("Y-up axis. Keep true for ZBrush, Maya and Blender (Blender's OBJ importer " +
      "converts Y-up to Z-up); replace_mesh_from_obj needs a Y-up OBJ (export with y_up true, and save Y-up from the " +
      "sculpting tool). false only for a tool that expects Z-up OBJ: replace_mesh_from_obj refuses that OBJ");
  });

  it("flags an OBJ written with the weaker call form, naming the form and what was dropped", async () => {
    bridge.exportObj.mockResolvedValue({ success: true, path: "C:/x/a.obj", signature: "(avatar, path)",
      notes: ["WARNING: CC5 rejected (avatar, path, option) and (avatar, path) was used instead, so the OBJ options (Y-up axis, body and clothing parts, materials) were NOT applied, and the OBJ may not be in CC5's T-pose"] });
    const r = await server.getRegisteredTool("export_obj")({ output_path: "C:/x/a.obj" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("with (avatar, path)");
    expect(r.content[0].text).toContain("Y-up axis, body and clothing parts");
    expect(r.content[0].text).toContain("Do not sculpt on this OBJ or bring it back with replace_mesh_from_obj.");
  });
});

describe("export_goz", () => {
  it("says replace_mesh_from_obj needs CC5's T-pose and that ZBrush's GoZ T-pose is untested", () => {
    expect(description("export_goz")).toBe(EXPORT_GOZ_DESCRIPTION);
    expect(EXPORT_GOZ_DESCRIPTION).toContain("replace_mesh_from_obj needs the mesh in CC5's T-pose: export with pose " +
      "'tpose' (the default) and export the OBJ from ZBrush without changing the pose.");
    expect(EXPORT_GOZ_DESCRIPTION).toContain("Whether ZBrush's GoZ T-pose matches CC5's is untested: " +
      "replace_mesh_from_obj refuses a mismatch.");
  });

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
  const replace = () => server.getRegisteredTool("replace_mesh_from_obj")({ mesh_name: "CC_Base_Body", obj_path: "C:/s/body.obj" });

  it("passes mesh and path to a job", async () => {
    const started = mockJobs(bridge, { replace_mesh_from_obj: { success: true, mesh: "CC_Base_Body" } });
    const r = await replace();
    expect(started).toEqual([{ action: "replace_mesh_from_obj", params: { mesh_name: "CC_Base_Body", obj_path: "C:/s/body.obj" } }]);
    expect(r.content[0].text).toBe("Replaced CC_Base_Body with body.obj");
  });

  it("shows the check against the OBJ and that the pose was removed", async () => {
    mockJobs(bridge, { replace_mesh_from_obj: { success: true, mesh: "CC_Base_Body", pose_removed: true, check_max_cm: 0,
      notes: [POSE_REMOVED] } });
    const r = await replace();
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`Replaced CC_Base_Body with body.obj\nChecked: the mesh matches the OBJ (max 0.00 cm).\n${POSE_REMOVED}`);
  });

  it("shows the warning when the replace could not be checked", async () => {
    const warning = "WARNING: the new CC_Base_Body was not checked against body.obj: the T-pose export after the replace " +
      "failed (disk full). Look at the character in Character Creator 5; one undo takes the replace back.";
    mockJobs(bridge, { replace_mesh_from_obj: { success: true, mesh: "CC_Base_Body", pose_removed: false, check_max_cm: null,
      notes: [warning] } });
    const r = await replace();
    expect(r.content[0].text).toBe(`Replaced CC_Base_Body with body.obj\n${warning}`);
    expect(r.content[0].text).not.toContain("Checked:");
  });

  it("is an error naming why it undid the replace, after trying once more 3 s later (F-101)", async () => {
    const error = "CC5 did not read body.obj as expected (the mesh differs by up to 2.00 cm from the OBJ); the replace was undone.";
    const started = mockJobs(bridge, { replace_mesh_from_obj: { success: false, error } });
    vi.useFakeTimers();
    try {
      const pending = replace();
      await vi.advanceTimersByTimeAsync(REPLACE_RETRY_MS);
      const r = await pending;
      expect(started).toHaveLength(2);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(`First try: ${error} CC5 can still be busy for a moment after an undo of a texture ` +
        `load (F-101), so the replace ran once more 3 s later.\nFailed: ${error}`);
    } finally {
      vi.useRealTimers();
    }
  });

  // F-101 (live): right after an undo of a texture load, CC5 read the OBJ in the old pose (95.44 cm off) and the plugin
  // undid the replace; the same replace a few seconds later matched (0.00 cm).
  it("runs a replace CC5 read differently once more 3 s later, and says so (F-101)", async () => {
    const error = "CC5 did not read body.obj as expected (the mesh differs by up to 95.44 cm from the OBJ); the replace was undone.";
    let tries = 0;
    const started = mockJobs(bridge, {
      replace_mesh_from_obj: () => (++tries === 1 ? { success: false, error }
        : { success: true, mesh: "CC_Base_Body", pose_removed: true, check_max_cm: 0, notes: [POSE_REMOVED] }),
    });
    vi.useFakeTimers();
    try {
      const pending = replace();
      await vi.advanceTimersByTimeAsync(REPLACE_RETRY_MS - 1);
      expect(started).toHaveLength(1);  // the second try waits the full 3 s
      await vi.advanceTimersByTimeAsync(1);
      const r = await pending;
      expect(started).toHaveLength(2);
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe(`First try: ${error} CC5 can still be busy for a moment after an undo of a texture ` +
        `load (F-101), so the replace ran once more 3 s later.\nReplaced CC_Base_Body with body.obj\n` +
        `Checked: the mesh matches the OBJ (max 0.00 cm).\n${POSE_REMOVED}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries no replace again when undoing the first one failed (F-101)", async () => {
    const error = "CC5 did not read body.obj as expected (the mesh differs by up to 95.44 cm from the OBJ); undoing the " +
      "replace failed (SWIG): undo it in Character Creator 5.";
    const started = mockJobs(bridge, { replace_mesh_from_obj: { success: false, error } });
    const r = await replace();
    expect(started).toHaveLength(1);
    expect(r.content[0].text).toBe(`Failed: ${error}`);
  });

  it("says it needs a Y-up OBJ from export_obj and a neutral face, removes the pose, refuses an animation, a topology, pose or axis mismatch, and checks the result", () => {
    expect(description("replace_mesh_from_obj")).toBe(REPLACE_MESH_DESCRIPTION);
    expect(REPLACE_MESH_DESCRIPTION).toContain("an edited OBJ from export_obj (same topology, in CC5's T-pose)");
    // TS-8 (DT-3): the plugin refuses a Z-up OBJ naming the axis; F-88: it refuses while a facial expression is set.
    // The description says both before the call.
    expect(REPLACE_MESH_DESCRIPTION).toContain(`It needs ${OBJ_Y_UP} and ${OBJ_NEUTRAL_FACE}.`);
    expect(REPLACE_MESH_DESCRIPTION).toContain("CC5 reads the OBJ in the character's current pose, so the tool first " +
      "removes the character's pose");
    expect(REPLACE_MESH_DESCRIPTION).toContain(REPLACE_MESH_ANIMATION_RULE);
    expect(REPLACE_MESH_DESCRIPTION).toContain("an OBJ whose mesh has a different vertex count, another pose (an OBJ " +
      "from an older export_obj is in the bind pose) or another vertex order, and a Z-up OBJ (an export_obj with y_up false)");
    // P-3: a replace CC5 reported but did not apply is undone too.
    expect(REPLACE_MESH_DESCRIPTION).toContain("undoes the replace if CC5 read it differently or did not apply it");
    const shape = server.tool.mock.calls.find((c) => c[0] === "replace_mesh_from_obj")?.[2] as Record<string, { description?: string }>;
    expect(shape.obj_path.description).toBe("Absolute path to the edited .obj (from export_obj, sculpted in the same pose, saved Y-up)");
  });

  it("passes on the plugin's refusals of a Z-up OBJ, of a set facial expression and of a replace CC5 did not apply", async () => {
    for (const error of [
      "body.obj is a Z-up OBJ (export_obj with y_up false); replace_mesh_from_obj reads only Y-up OBJs: export it with " +
        "y_up true (the default), sculpt, then replace.",
      "Kevin's facial expression is set (Brow_Compress_L 0.6, Brow_Compress_R 0.6, Eye_Squint_L 0.3 and 3 more), so " +
        "nothing was replaced: an OBJ exported with the expression set carries it, and the replace would bake it into " +
        "the mesh. Run reset_expression, export the OBJ again with export_obj, make the edit on that OBJ, replace, then " +
        "set the expression again.",
      "CC5 did not apply body.obj to CC_Base_Body; nothing was changed (the replace was undone)",
    ]) {
      mockJobs(bridge, { replace_mesh_from_obj: { success: false, error } });
      const r = await replace();
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(`Failed: ${error}`);
    }
  });

  // Review #5: the refusal names three of the six sliders; the expression is to be set again after the round trip.
  it("ends a refusal over a set facial expression with every slider's weight, as one line (review #5)", async () => {
    const error = "Kevin's facial expression is set (Brow_Compress_L 0.6, Brow_Compress_R 0.6, Eye_Squint_L 0.3 and 3 " +
      "more; this reply lists every slider with its weight), so nothing was replaced: an OBJ exported with the " +
      "expression set carries it, and the replace would bake it into the mesh. If body.obj was exported while this " +
      "expression was set, run reset_expression, export the OBJ again with export_obj and make the edit on that OBJ. If " +
      "it was exported with a neutral face, run reset_expression and replace it again. After the replace, set the " +
      "expression again with the weights listed.";
    mockJobs(bridge, { replace_mesh_from_obj: { success: false, error, expression_weights: EXPRESSION_WEIGHTS } });
    const r = await replace();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`Failed: ${error}\n${SET_AGAIN}`);
  });

  it("still shows CC5's question, the job id of a slow replace and an unreachable CC5 as before", async () => {
    const question = 'CC5 is waiting for an answer to "Replace?" (the "Character Creator 5" window). Buttons: OK. ' +
      'The command is still running as job cmd_9: answer it with answer_cc5_dialog, then job_status("cmd_9").';
    bridge.startJob.mockResolvedValue({ job_id: "cmd_9" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_9", action: "replace_mesh_from_obj", status: "running", dialog_message: question });
    const asking = await replace();
    expect(asking.isError).toBe(true);
    expect(asking.content[0].text).toBe(question);
    bridge.getJob.mockResolvedValue({ job_id: "cmd_9", action: "replace_mesh_from_obj", status: "running" });
    vi.useFakeTimers();
    try {
      const pending = replace();
      await vi.advanceTimersByTimeAsync(30_000);
      const running = await pending;
      expect(running.isError).toBeUndefined();
      expect(running.content[0].text).toContain('job_status with job_id "cmd_9"');
    } finally {
      vi.useRealTimers();
    }
    bridge.startJob.mockRejectedValue(new BridgeUnreachableError("fetch failed"));
    expect((await replace()).content[0].text).toBe("CC5 bridge error: fetch failed. Is CC5 running with the MCP Bridge plugin?");
  });

  it("refuses an animation longer than the plugin's pose clip (DEC-9, cc5_pipeline.py)", () => {
    // The description says "longer than one frame": the plugin's POSE_CLIP_MAX_FRAMES must stay 1.
    const plugin = fs.readFileSync(new URL("../../cc5-plugin/cc5_pipeline.py", import.meta.url), "utf-8");
    expect(/^POSE_CLIP_MAX_FRAMES = (\d+)/m.exec(plugin)?.[1]).toBe("1");
    expect(REPLACE_MESH_ANIMATION_RULE).toContain("(a motion clip longer than one frame)");
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

  // F-66: CC5 shows a Diffuse Blend image only above 0, so diffuse_blend also sets the layer's strength.
  const blend = { mesh_name: "CC_Base_Body", material_name: "Std_Skin_Leg", channel: "diffuse_blend", image_path: "C:/t/overlay.png" };

  it("says other channels' loads as before", async () => {
    bridge.loadTexture.mockResolvedValue({ success: true });
    const r = await server.getRegisteredTool("load_texture")({ ...blend, channel: "normal" });
    expect(r.content[0].text).toBe("Loaded overlay.png into Std_Skin_Leg (normal)");
    expect(r.isError).toBeUndefined();
  });

  it("sends a diffuse_blend strength as the fifth argument and reports the strength set", async () => {
    bridge.loadTexture.mockResolvedValue({ success: true, strength: 0.3, read: 0.3, stale: false });
    const r = await server.getRegisteredTool("load_texture")({ ...blend, strength: 30 });
    expect(bridge.loadTexture).toHaveBeenCalledWith("CC_Base_Body", "Std_Skin_Leg", "diffuse_blend", "C:/t/overlay.png", 30);
    expect(r.content[0].text).toBe("Loaded overlay.png into Std_Skin_Leg (diffuse_blend) at 30%");
  });

  it("loads diffuse_blend at 100% by default, and says when CC5 reads the strength back only after it renders", async () => {
    bridge.loadTexture.mockResolvedValue({ success: true, strength: 1, read: 0, stale: true });
    const r = await server.getRegisteredTool("load_texture")(blend);
    expect(bridge.loadTexture).toHaveBeenCalledWith("CC_Base_Body", "Std_Skin_Leg", "diffuse_blend", "C:/t/overlay.png");
    expect(r.content[0].text).toBe("Loaded overlay.png into Std_Skin_Leg (diffuse_blend) at 100% "
      + "(CC5 reads the strength back only after it renders)");
  });

  // TS-7 (X-4): a plugin installed before F-66 sets no strength and reports none, so the layer may still be at 0.
  it("is an error that names no percentage when the installed plugin does not report the strength it set", async () => {
    bridge.loadTexture.mockResolvedValue({ success: true });
    const expected = "Loaded overlay.png into Std_Skin_Leg (diffuse_blend), but the installed CC5 plugin predates the " +
      "strength fix and did not set the layer's strength, so the image may not show (CC5 shows a Diffuse Blend image " +
      "only above 0). Reinstall the plugin with install-plugin.ps1.";
    for (const args of [{ ...blend, strength: 45 }, blend]) {
      const r = await server.getRegisteredTool("load_texture")(args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(expected);
      expect(r.content[0].text).not.toMatch(/\d%/);
    }
  });

  it("refuses a strength for another channel without calling CC5", async () => {
    const r = await server.getRegisteredTool("load_texture")({ ...blend, channel: "normal", strength: 30 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("strength is only for channel 'diffuse_blend'");
    expect(bridge.loadTexture).not.toHaveBeenCalled();
  });

  it("says what diffuse_blend does and points skin overlays to apply_skin_overlay", () => {
    const call = server.tool.mock.calls.find((c) => c[0] === "load_texture");
    expect(call?.[1]).toContain("For diffuse_blend (a layer blended over the diffuse) the tool also sets the layer's strength, "
      + "default 100: CC5 shows a Diffuse Blend image only above 0. For skin overlays use apply_skin_overlay.");
    const shape = call?.[2] as Record<string, { description?: string }>;
    expect(shape.strength.description).toBe("diffuse_blend only: blend strength 0-100 (default 100). CC5 shows a Diffuse Blend image only above 0");
  });
});

describe("IMAGE_TYPES_TEXT (F-68)", () => {
  it("names the image types from IMAGE_EXTENSIONS", () => {
    expect(IMAGE_TYPES_TEXT).toBe("PNG, JPG, JPEG, TGA, BMP, TIF or TIFF");
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
    expect(r.content[0].text).not.toContain("undo history");
  });

  // F-89 (live CC5 5.13, corrects F-86): an FBX export does not clear CC5's undo history, so the reply says nothing
  // about it, also for a result from a plugin installed before the fix that still sends undo_history_cleared.
  it("says nothing about CC5's undo history after the export", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_5" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_5", action: "export_textures", status: "done",
      result: { success: true, folder: "C:/SP/P1", files: [], undo_history_cleared: true } });
    const r = await server.getRegisteredTool("export_textures")({ output_dir: "C:/SP", character_name: "P1" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("Exported mesh and 0 files to C:/SP/P1");
  });

  it("says nothing about it after an export that ran and then failed a check", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_5" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_5", action: "export_textures", status: "done",
      result: { success: false, error: "CC5 reported success but did not write C:/SP/P1/P1.fbx",
        undo_history_cleared: true } });
    const r = await server.getRegisteredTool("export_textures")({ output_dir: "C:/SP", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Texture export failed: CC5 reported success but did not write C:/SP/P1/P1.fbx");
  });

  it("flags an export CC5 made without some of its settings", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_5" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_5", action: "export_textures", status: "done",
      result: { success: true, folder: "C:/SP/P1", files: [], notes: ["WARNING: EnableExportMotion failed: x"] } });
    const r = await server.getRegisteredTool("export_textures")({ output_dir: "C:/SP", character_name: "P1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("WARNING: EnableExportMotion failed: x");
  });

  // X-2: the F-82 guard set CC5's timeline to one frame for the export and could not set it back. The FBX is right;
  // only the scene's timeline is wrong, so that note is no export setting CC5 failed to apply.
  describe("a timeline CC5 could not set back after the export (X-2)", () => {
    const TIMELINE_NOTE = `${TIMELINE_NOT_RESTORED_PREFIX}it was set to one frame for this export and could not be set ` +
      "back (end time: boom); the FBX is usable: set the timeline's length in Character Creator 5";
    const exportWith = async (result: Record<string, unknown>) => {
      bridge.startJob.mockResolvedValue({ job_id: "cmd_5" });
      bridge.getJob.mockResolvedValue({ job_id: "cmd_5", action: "export_textures", status: "done", result });
      return server.getRegisteredTool("export_textures")({ output_dir: "C:/SP", character_name: "P1" });
    };

    it("is a line of its own after an export that worked, not an error", async () => {
      const r = await exportWith({ success: true, folder: "C:/SP/P1", files: [], notes: [TIMELINE_NOTE] });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toBe("Exported mesh and 0 files to C:/SP/P1\nThe FBX is usable; CC5's timeline was left " +
        "at one frame: set its length in Character Creator 5.");
      expect(r.content[0].text).toContain(TIMELINE_USABLE_LINE);
      expect(r.content[0].text).not.toContain("did not apply every export setting");
    });

    it("stays out of the export settings CC5 did not apply, and does not call that FBX usable", async () => {
      const r = await exportWith({ success: true, folder: "C:/SP/P1", files: [],
        notes: [TIMELINE_NOTE, "WARNING: EnableExportMotion failed: x"] });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("Exported mesh and 0 files to C:/SP/P1, but CC5 did not apply every export setting:\n" +
        "WARNING: EnableExportMotion failed: x\nCC5's timeline was left at one frame: set its length in Character " +
        "Creator 5.");
      expect(r.content[0].text).toContain(TIMELINE_LEFT_LINE);
      expect(r.content[0].text).not.toContain(TIMELINE_NOT_RESTORED_PREFIX);
      expect(r.content[0].text).not.toContain("usable");
    });

    it("is the plain timeline line beside a failed export, which it does not call usable", async () => {
      const r = await exportWith({ success: false, error: "ExportFbxFile reported an error status",
        notes: [TIMELINE_NOTE, "WARNING: SetTextureSize failed: y"] });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe("Texture export failed: ExportFbxFile reported an error status\n" +
        `WARNING: SetTextureSize failed: y\n${TIMELINE_LEFT_LINE}`);
      expect(r.content[0].text).not.toContain("usable");
    });
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
