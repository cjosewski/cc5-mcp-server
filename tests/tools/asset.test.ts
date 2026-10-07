/**
 * Unit tests for registerAssetTools.
 * Asset tools include path validation (path traversal + extension checks)
 * before forwarding to the bridge. load_asset runs as a bridge job; bridge errors become error results.
 */

import fs from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CANCELLED_LOAD, registerAssetTools } from "../../src/tools/asset.js";
import { CANCELLED_CHANGED, CANCELLED_NOTHING, CANCELLED_UNSURE } from "../../src/recipe.js";
import { CC5Bridge } from "../../src/cc5-bridge.js";
import { createMockBridge, mockJobs, SUCCESS, FAILURE } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import {
  FIT_RULE, NOT_A_CHECK, PICK_RULE, PRESET_RULE, SKINGEN_QUESTION, SKINGEN_QUESTION_RULE,
} from "../../src/prompts/content-rules.js";

import { createMockServer } from "../helpers/mock-server.js";

// ── setup ─────────────────────────────────────────────────────────────────────

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAssetTools(server as any, bridge as any);
});

// ── registration ──────────────────────────────────────────────────────────────

describe("registerAssetTools – registration", () => {
  it("registers exactly 2 tools", () => {
    expect(server.tool).toHaveBeenCalledTimes(2);
  });

  it("registers load_asset", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "load_asset",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers export_fbx", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "export_fbx",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });
});

// ── load_asset – happy paths ──────────────────────────────────────────────────

describe("load_asset handler – success cases", () => {
  it("returns success message with the file path on success", async () => {
    mockJobs(bridge, { load_asset: { success: true, path: "C:/Assets/MyChar.iAvatar" } });
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/Assets/MyChar.iAvatar" });
    expect(result.content[0].text).toBe("Asset loaded: C:/Assets/MyChar.iAvatar");
    expect(result.content).toHaveLength(1);  // scene content has no change report
    expect(result.isError).toBeUndefined();
  });

  it("returns failure message when bridge returns failure result", async () => {
    mockJobs(bridge, { load_asset: FAILURE });
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/Assets/file.iAvatar" });
    expect(result.content[0].text).toBe("Failed to load asset: operation failed");
    expect(result.isError).toBe(true);
  });

  it("starts a load_asset job with the file path instead of the direct 30 s call", async () => {
    const started = mockJobs(bridge);
    const handler = server.getRegisteredTool("load_asset");
    await handler({ file_path: "C:/Assets/Clothing.iClothes" });
    expect(started).toEqual([{ action: "load_asset", params: { file_path: "C:/Assets/Clothing.iClothes" } }]);
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });

  it("passes target through and names the character the content was applied to", async () => {
    const started = mockJobs(bridge, { load_asset: { success: true, path: "C:/e/Green.ccEye", target: "Kevin" } });
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/e/Green.ccEye", target: "Kevin" });
    expect(started).toEqual([{ action: "load_asset", params: { file_path: "C:/e/Green.ccEye", target: "Kevin" } }]);
    // The first line; the NOT CHECKED lines follow in the same text block (F-95).
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text.split("\n")[0]).toBe("Asset loaded: C:/e/Green.ccEye (applied to Kevin)");
  });

  it("returns content with type 'text'", async () => {
    mockJobs(bridge);
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/some.ccm" });
    expect(result.content[0].type).toBe("text");
  });

  it("returns bridge error text when starting the job throws (does not propagate)", async () => {
    bridge.startJob.mockRejectedValue(new Error("CC5 not connected"));
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/file.iAvatar" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CC5 bridge error: CC5 not connected");
  });
});

// F-34: every character-content load is compared before and after in the plugin; load_asset shows the report.
describe("load_asset – what the load changed (F-34)", () => {
  const PANTS = "C:/c/US_Army_Uniform_Pants.ccCloth";
  const changes = (facts: unknown[]) => ({ complete: true, target: "Kevin", target_is_first: true, elapsed_ms: 300,
    compared: { worn: 2, morphs: 10, materials: 30 }, skipped: 0, truncated: false, facts });
  const BOXERS = [{ kind: "worn_added", group: "clothing", id: "13", name: "Pants" },
    { kind: "worn_removed", group: "clothing", id: "11", name: "Boxers" }];

  // F-95 (live): in two text blocks, Claude Code showed "... (applied to Kevin)Compared before and after: ...".
  it("puts the report after the unchanged first line, in the same text block; CHECK lines are not an error", async () => {
    mockJobs(bridge, { load_asset: { success: true, path: PANTS, target: "Kevin", changes: changes(BOXERS) } });
    const result = await server.getRegisteredTool("load_asset")({ file_path: PANTS });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe([
      `Asset loaded: ${PANTS} (applied to Kevin)`,
      "Compared before and after: 2 worn items, 10 shaping morphs, 30 materials (0.3 s).",
      "CHECK removed Boxers (clothing): CC5 may have swapped it out for this item",
      "Applied: added Pants (clothing)",
      "NOT CHECKED: how it sits on the character (skin or scalp showing through, floating items): run check_fit",
    ].join("\n"));
  });

  it("reports a failed load as an error, with the CHECK lines of what it changed anyway", async () => {
    mockJobs(bridge, { load_asset: { success: false, error: "boom (CC5 reported an error, but it changed 1 thing)",
      changes: changes([BOXERS[1]]) } });
    const result = await server.getRegisteredTool("load_asset")({ file_path: PANTS });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const lines = result.content[0].text.split("\n");
    expect(lines[0]).toBe("Failed to load asset: boom (CC5 reported an error, but it changed 1 thing)");
    expect(lines).toContain("CHECK removed Boxers (clothing): CC5 may have swapped it out for this item");
  });

  it("returns CC5's question as an error when the load waits on one", async () => {
    const question = 'CC5 is waiting for an answer to "The target object layer already exists. Do you want to replace ' +
      'the object, or the material only?" (the "Character Creator 5" window). Buttons: Replace, Material Only, Cancel. ' +
      "The command is still running as job cmd_ab12cd34_4: answer it with answer_cc5_dialog (ask the user when it is a " +
      'real choice), then check its result with job_status("cmd_ab12cd34_4").';
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_4" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_4", action: "load_asset", status: "running",
      dialog: { title: "Character Creator 5", text: "The target object layer already exists.", buttons: ["Replace", "Material Only", "Cancel"] },
      dialog_message: question });
    const result = await server.getRegisteredTool("load_asset")({ file_path: "C:/e/Eyes_02.ccEye" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(question);
    expect(bridge.getJob).toHaveBeenCalledTimes(1);
  });

  // F-91 (live 2026-10-07): a content load during a SkinGen session asked this. get_cc5_dialog gave the rule (a plain
  // confirmation for a load the user asked for: answer OK and say so); load_asset's reply did not.
  it("gives the SkinGen session rule on its own line after CC5's question to end the session", async () => {
    const question = `CC5 is waiting for an answer to "${SKINGEN_QUESTION}" (the "Character Creator 5" window). ` +
      "Buttons: OK, Cancel. The command is still running as job cmd_ab12cd34_6: answer it with answer_cc5_dialog (ask " +
      'the user when it is a real choice), then check its result with job_status("cmd_ab12cd34_6").';
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_6" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_6", action: "load_asset", status: "running",
      dialog: { title: "Character Creator 5", text: SKINGEN_QUESTION, buttons: ["OK", "Cancel"], text_read: true },
      dialog_message: question });
    const result = await server.getRegisteredTool("load_asset")({ file_path: "C:/Props/Box.iProp" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: `${question}\n${SKINGEN_QUESTION_RULE}` }]);
  });

  // F-92 precaution (cc5_api.load_asset): a .ccProject replaces the scene, so the plugin clears CC5's selection first
  // and names what was selected, or warns that it could not; the reply showed neither.
  it("shows the plugin's notes on a project load", async () => {
    const PROJECT = "C:/p/Scene.ccProject";
    const cleared = "CC5's selection (Pants) was cleared before the project load: a project replaces the scene, and " +
      "deleting a character while one of its worn items is selected can crash CC5 (F-92).";
    mockJobs(bridge, { load_asset: { success: true, path: PROJECT, notes: [cleared] } });
    const result = await server.getRegisteredTool("load_asset")({ file_path: PROJECT });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: `Asset loaded: ${PROJECT}\n${cleared}` }]);

    const warning = "WARNING: CC5's selection could not be cleared before the project load (SWIG): a project replaces " +
      "the scene, and deleting a character while one of its worn items is selected can crash CC5 (F-92).";
    mockJobs(bridge, { load_asset: { success: false, error: "LoadFile failed", notes: [warning] } });
    const failed = await server.getRegisteredTool("load_asset")({ file_path: PROJECT });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe(`Failed to load asset: LoadFile failed\n${warning}`);
  });

  it("says how to get the result of a load that is still running", async () => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_5" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_5", action: "load_asset", status: "running" });
    vi.useFakeTimers();
    try {
      const pending = server.getRegisteredTool("load_asset")({ file_path: "C:/a/Dressed.ccAvatar" });
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Still running in CC5 (job cmd_ab12cd34_5). Call job_status with job_id ' +
        '"cmd_ab12cd34_5" to get the result. Do not start the same operation again.');
    } finally {
      vi.useRealTimers();
    }
  });

  // F-97 (live): _Blue1 Eyes reported "CHECK opacity on CC_Base_Eye/Std_Cornea_R: 1 -> 0.8", its own setting.
  it("reports an eye preset's own cornea opacity as applied, not as a CHECK line", async () => {
    const BLUE = "C:/Templates/Eye/_Blue1 Eyes.ccEye";
    const cornea = (side: string) => ({ kind: "material", mesh: "CC_Base_Eye", material: `Std_Cornea_${side}`,
      field: "opacity", before: 1, after: 0.8 });
    mockJobs(bridge, { load_asset: { success: true, path: BLUE, target: "Kevin", changes: changes([cornea("R"), cornea("L")]) } });
    const result = await server.getRegisteredTool("load_asset")({ file_path: BLUE });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.split("\n").slice(0, 4)).toEqual([
      `Asset loaded: ${BLUE} (applied to Kevin)`,
      "Compared before and after: 2 worn items, 10 shaping morphs, 30 materials (0.3 s).",
      "Applied: opacity on CC_Base_Eye/Std_Cornea_R: 0.8",
      "Applied: opacity on CC_Base_Eye/Std_Cornea_L: 0.8",
    ]);
    expect(result.content[0].text).not.toMatch(/^CHECK /m);
  });

  // F-91 (live 2026-10-07): a SkinGen preset starts a SkinGen session that hides hair, brows and clothing until a later
  // content load or a delete ends it; a content load during it can ask to end it (batch F review #13: seen for a prop
  // load, and a prop delete ended it without a question).
  it("says a SkinGen preset started a SkinGen session and how to answer a later load's question", async () => {
    const CORDIAL = "C:/Templates/Makeup/Full Makeup/Cordial.ccSkinGenPreset";
    mockJobs(bridge, { load_asset: { success: true, path: CORDIAL, target: "Kevin", changes: changes([]) } });
    const result = await server.getRegisteredTool("load_asset")({ file_path: CORDIAL });
    expect(result.isError).toBeUndefined();
    const lines = result.content[0].text.split("\n");
    expect(lines[2]).toBe("NOTE: this SkinGen preset started a SkinGen session in CC5: the viewport hides hair, brows " +
      "and clothing (they stay worn and are exported) until a later content load or a delete ends it (live: a prop " +
      "delete ended it without a question). A content load during the session can ask \"Applying this content will " +
      "deactivate the current SkinGen session. Would you like to continue?\" (seen for a prop load): for a load the " +
      "user asked for, answer OK and say so.");
    expect(lines[3]).toMatch(/^NOT CHECKED: what CC5 shows but cannot report \(hair, brows or clothing hidden/);
  });

  it("names makeup presets and gives the pick-list, before/after, fit and captures rules", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "load_asset")?.[1] as string;
    expect(description).toContain(".ccSkinGenPreset (makeup and SkinGen presets)");
    expect(description).toContain(".ccSkin, .ccSkinGenPreset, .ccTeeth");
    expect(description).toContain("Runs as a background job; if CC5 asks a question (e.g. Replace / Material Only), the reply shows it.");
    for (const rule of [PICK_RULE, PRESET_RULE, FIT_RULE, NOT_A_CHECK]) expect(description).toContain(rule);
    expect(description.length).toBeLessThan(2000);
    for (const call of server.tool.mock.calls) expect((call[1] as string).length).toBeLessThan(2000);
  });
});

// F-98 (batch F review #8, #28): CC5 reports a load done after answer_cc5_dialog clicked Cancel in its question (live:
// the user's Cancel in an eye preset's Replace / Material Only applied nothing). The job's status lists that answer;
// load_asset's reply read "Asset loaded: ... (applied to Kevin)", and a SkinGen preset's claimed a SkinGen session.
describe("load_asset – a load answered Cancel in CC5 (F-98)", () => {
  const HAZEL = "C:/Templates/Eye/_Hazel1 Eyes.ccEye";
  const CORDIAL = "C:/Templates/Makeup/Full Makeup/Cordial.ccSkinGenPreset";
  const CANCEL = [{ button: "Cancel", title: "Character Creator 5" }];
  const changes = (facts: unknown[]) => ({ complete: true, target: "Kevin", target_is_first: true, elapsed_ms: 300,
    compared: { worn: 2, morphs: 10, materials: 30 }, skipped: 0, truncated: false, facts });
  const COMPARED = "Compared before and after: 2 worn items, 10 shaping morphs, 30 materials (0.3 s).";
  const LOOK = "NOT CHECKED: what CC5 shows but cannot report (hair, brows or clothing hidden in the viewport, makeup " +
    "or skin layers): capture the face (frame_camera face) and the whole body (home) and compare them with captures " +
    "from before the load";
  /** The load's job finished while load_asset waited, after answer_cc5_dialog clicked `answers` in its question. */
  const finished = (result: unknown, answers: unknown = CANCEL) => {
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_7" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_7", action: "load_asset", status: "done", result, answers });
  };
  const load = (file_path: string) => server.getRegisteredTool("load_asset")({ file_path });

  it("says the load was cancelled in CC5 and applied nothing, never that it loaded; the reply is an error", async () => {
    finished({ success: true, path: HAZEL, target: "Kevin", changes: changes([]) });
    const result = await load(HAZEL);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: [
      `Asset load cancelled: ${HAZEL} for Kevin (${CANCELLED_NOTHING})`, COMPARED, LOOK].join("\n") }]);
  });

  it("claims no SkinGen session for a SkinGen preset answered Cancel", async () => {
    finished({ success: true, path: CORDIAL, target: "Kevin", changes: changes([]) });
    const result = await load(CORDIAL);
    expect(result.content[0].text).toBe([`Asset load cancelled: ${CORDIAL} for Kevin (${CANCELLED_NOTHING})`, COMPARED,
      LOOK].join("\n"));
    expect(result.content[0].text).not.toContain("SkinGen session");
  });

  it("says what CC5 still changed, or that CC5 may not have done it when nothing was compared", async () => {
    const socks = { kind: "worn_added", group: "clothing", id: "21", name: "Socks" };
    finished({ success: true, path: HAZEL, target: "Kevin", changes: changes([socks]) });
    expect((await load(HAZEL)).content[0].text).toBe([`Asset load cancelled: ${HAZEL} for Kevin (${CANCELLED_CHANGED})`,
      COMPARED, "CHECK added Socks (clothing), which this eye load was not for", LOOK].join("\n"));
    // A plugin from before the change report sends no comparison.
    finished({ success: true, path: HAZEL, target: "Kevin" });
    const unsure = await load(HAZEL);
    expect(unsure.isError).toBe(true);
    expect(unsure.content[0].text.split("\n")[0]).toBe(`Asset load cancelled: ${HAZEL} for Kevin (${CANCELLED_UNSURE})`);
    // The words a recipe gives a step answered Cancel (recipe.ts), so a load reads the same in both.
    expect(CANCELLED_LOAD).toEqual({ changed: CANCELLED_CHANGED, nothing: CANCELLED_NOTHING, unsure: CANCELLED_UNSURE });
  });

  it("keeps the loaded reply when the answers hold no Cancel", async () => {
    finished({ success: true, path: HAZEL, target: "Kevin", changes: changes([]) },
      [{ button: "Replace", title: "Character Creator 5" }]);
    const result = await load(HAZEL);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe([`Asset loaded: ${HAZEL} (applied to Kevin)`, COMPARED, LOOK].join("\n"));
  });
});

// ── load_asset – allowed extensions ──────────────────────────────────────────

describe("load_asset handler – extension validation", () => {
  const allowedExtensions = [
    { ext: ".iAvatar", path: "C:/file.iAvatar" },
    { ext: ".ccm", path: "C:/file.ccm" },
    { ext: ".iClothes", path: "C:/file.iClothes" },
    { ext: ".iHair", path: "C:/file.iHair" },
    { ext: ".iProp", path: "C:/file.iProp" },
    { ext: ".ccFBX", path: "C:/file.ccFBX" },
    { ext: ".iClothing", path: "C:/file.iClothing" },
    { ext: ".iShoe", path: "C:/file.iShoe" },
    { ext: ".iAccessory", path: "C:/file.iAccessory" },
    { ext: ".iBody", path: "C:/file.iBody" },
    { ext: ".iSkin", path: "C:/file.iSkin" },
    { ext: ".ccavatar", path: "C:/file.ccavatar" },
    { ext: ".ccproject", path: "C:/file.ccproject" },
  ];

  for (const { ext, path } of allowedExtensions) {
    it(`accepts ${ext} extension`, async () => {
      const started = mockJobs(bridge);
      const handler = server.getRegisteredTool("load_asset");
      const result = await handler({ file_path: path });
      expect(result.content[0].text).toContain("Asset loaded:");
      expect(started).toEqual([{ action: "load_asset", params: { file_path: path } }]);
    });
  }

  it("accepts .rlHair hairstyles and passes target through", async () => {
    const started = mockJobs(bridge, { load_asset: { success: true, path: "C:/h/Buzz Cut.rlHair", target: "Kevin" } });
    const result = await server.getRegisteredTool("load_asset")({ file_path: "C:/h/Buzz Cut.rlHair", target: "Kevin" });
    expect(started).toEqual([{ action: "load_asset", params: { file_path: "C:/h/Buzz Cut.rlHair", target: "Kevin" } }]);
    expect(result.content[0].text.split("\n")[0]).toBe("Asset loaded: C:/h/Buzz Cut.rlHair (applied to Kevin)");
  });

  it("rejects other .rl files (.rlHairElement)", async () => {
    const result = await server.getRegisteredTool("load_asset")({ file_path: "C:/h/Buzz Cut.rlHairElement" });
    expect(result.content[0].text).toContain("Disallowed file extension");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("rejects disallowed extension (.txt)", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/bad/file.txt" });
    expect(result.content[0].text).toContain("Disallowed file extension");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("rejects disallowed extension (.exe)", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/evil.exe" });
    expect(result.content[0].text).toContain("Disallowed file extension");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("rejects disallowed extension (.fbx) — FBX is export-only", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/model.fbx" });
    expect(result.content[0].text).toContain("Disallowed file extension");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
  });
});

// ── load_asset – path traversal ───────────────────────────────────────────────

describe("load_asset handler – path traversal prevention", () => {
  it("rejects paths containing '..'", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "C:/safe/../../../etc/passwd.iAvatar" });
    expect(result.content[0].text).toContain("Path traversal");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("rejects relative path traversal at the start", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const result = await handler({ file_path: "../../../secret.iAvatar" });
    expect(result.content[0].text).toContain("Path traversal");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
  });
});

// ── export_fbx – happy paths ──────────────────────────────────────────────────

describe("export_fbx handler – success cases", () => {
  it("returns success message with the output path on success", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/Export/character.fbx" });
    expect(result.content[0].text).toBe("FBX exported to: C:/Export/character.fbx (target=default)");
  });

  it("returns failure message when bridge returns failure result", async () => {
    bridge.exportFbx.mockResolvedValue(FAILURE);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/Export/character.fbx" });
    expect(result.content[0].text).toBe("Export failed: operation failed");
  });

  it("calls bridge.exportFbx with the output path", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    await handler({ output_path: "C:/out/model.fbx" });
    expect(bridge.exportFbx).toHaveBeenCalledWith("C:/out/model.fbx", 0, {});
  });

  it("returns content with type 'text'", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out.fbx" });
    expect(result.content[0].type).toBe("text");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.exportFbx.mockRejectedValue(new Error("disk full"));
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out.fbx" });
    expect(result.content[0].text).toContain("CC5 bridge error: disk full");
  });
});

// ── export_fbx – CC5 dialog options pass-through ─────────────────────────────

describe("export_fbx handler – dialog options forwarding", () => {
  it("forwards the recommended Unreal options to the bridge", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    await handler({
      output_path: "C:/out/char.fbx",
      target_tool: "UE5",
      export_motion: true,
      embed_textures: true,
      fps: 30,
      sub_d_level: 0,
    });
    expect(bridge.exportFbx).toHaveBeenCalledWith("C:/out/char.fbx", 0, {
      target_tool: "UE5",
      export_motion: true,
      embed_textures: true,
      fps: 30,
      sub_d_level: 0,
    });
  });

  it("forwards motion_range, texture_size and convert_image_format", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    await handler({
      output_path: "C:/out/char.fbx",
      motion_range: [0, 100],
      texture_size: 2048,
      convert_image_format: true,
    });
    expect(bridge.exportFbx).toHaveBeenCalledWith("C:/out/char.fbx", 0, {
      motion_range: [0, 100],
      texture_size: 2048,
      convert_image_format: true,
    });
  });

  it("says a sub_d_level above the character's highest subdivision level is refused", () => {
    const shape = server.tool.mock.calls.find((c) => c[0] === "export_fbx")?.[2] as Record<string, { description?: string }>;
    expect(shape.sub_d_level.description).toContain(
      "It must not exceed the character's highest subdivision level (0 without HD data); higher values are refused.");
  });

  it("tells the agent to save the character before the session's first FBX export", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "export_fbx")?.[1] as string;
    expect(description).toContain("save_character");
    expect(description).toContain("first FBX export");
  });

  it("says Convert Image Format is refused, because CC5 5.13 crashes after a scripted export with it", () => {
    const shape = server.tool.mock.calls.find((c) => c[0] === "export_fbx")?.[2] as Record<string, { description?: string }>;
    expect(shape.convert_image_format.description).toContain("refuses");
    expect(shape.convert_image_format.description).toContain("crashes");
    expect(shape.include_current_pose.description).toContain("1-frame motion_range");
  });

  it("accepts a bare filename and forwards it unchanged (default dir resolved server-side)", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "character.fbx", embed_textures: true });
    expect(bridge.exportFbx).toHaveBeenCalledWith("character.fbx", 0, { embed_textures: true });
    expect(result.content[0].text).toContain("FBX exported to: character.fbx");
  });

  it("omits unset optional params from the forwarded extra object", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    await handler({ output_path: "C:/out/char.fbx", export_motion: false });
    expect(bridge.exportFbx).toHaveBeenCalledWith("C:/out/char.fbx", 0, { export_motion: false });
  });
});

// ── export_fbx – extension validation ────────────────────────────────────────

describe("export_fbx handler – extension validation", () => {
  it("accepts .fbx extension (lowercase)", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out/char.fbx" });
    expect(result.content[0].text).toBe("FBX exported to: C:/out/char.fbx (target=default)");
  });

  it("rejects non-.fbx extension (.obj)", async () => {
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out/char.obj" });
    expect(result.content[0].text).toContain("Export path must end with .fbx");
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });

  it("rejects .gltf extension", async () => {
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out/char.gltf" });
    expect(result.content[0].text).toContain("Export path must end with .fbx");
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });

  it("rejects no extension", async () => {
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/out/character" });
    expect(result.content[0].text).toContain("Export path must end with .fbx");
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });
});

// ── export_fbx – path traversal ───────────────────────────────────────────────

describe("export_fbx handler – path traversal prevention", () => {
  it("rejects paths containing '..'", async () => {
    const handler = server.getRegisteredTool("export_fbx");
    const result = await handler({ output_path: "C:/safe/../../etc/out.fbx" });
    expect(result.content[0].text).toContain("Path traversal");
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });
});

describe("asset validation failures carry isError", () => {
  it("load_asset rejects a bad path with isError", async () => {
    const r = await server.getRegisteredTool("load_asset")({ file_path: "C:/a/../b.iAvatar" });
    expect(r.isError).toBe(true);
    expect(bridge.loadAsset).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("export_fbx rejects a bad path with isError", async () => {
    const r = await server.getRegisteredTool("export_fbx")({ output_path: "C:/out/char.obj" });
    expect(r.isError).toBe(true);
    expect(bridge.exportFbx).not.toHaveBeenCalled();
  });
});

describe("export_fbx Blender target", () => {
  it("schema accepts target_tool Blender", () => {
    const call = server.tool.mock.calls.find((c) => c[0] === "export_fbx")!;
    const shape = call[2] as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(shape.target_tool.safeParse("Blender").success).toBe(true);
  });
});

// F-89 (live CC5 5.13, corrects F-86): an FBX export does not clear CC5's undo history (morph and skin changes undo
// across exports), so the reply says nothing about it, also for a result from a plugin installed before the fix that
// still sends undo_history_cleared.
describe("export_fbx and CC5's undo history (F-89)", () => {
  it("replies with the export's own lines only", async () => {
    bridge.exportFbx.mockResolvedValue({ success: true, target_tool: "Unity", notes: ["target_tool=Unity preset applied"],
      undo_history_cleared: true });
    const r = await server.getRegisteredTool("export_fbx")({ output_path: "C:/out/char.fbx" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("FBX exported to: C:/out/char.fbx (target=Unity)\nNotes: target_tool=Unity preset applied");
  });

  it("says nothing about it for a plain result either", async () => {
    bridge.exportFbx.mockResolvedValue(SUCCESS);
    const r = await server.getRegisteredTool("export_fbx")({ output_path: "C:/out/char.fbx" });
    expect(r.content[0].text).toBe("FBX exported to: C:/out/char.fbx (target=default)");
    expect(r.content[0].text).not.toContain("undo history");
  });
});

// P-5: a failed export_fbx comes back as HTTP 400, and only its `error` survives that: the tool shows CC5's text whole.
describe("a failed export_fbx through the real bridge client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows CC5's error text whole, and nothing about CC5's undo history", async () => {
    const error = "ExportFbxFile reported an error status";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error,
      notes: ["CC5's timeline was 0 frames long"] }), { status: 400 })));
    const live = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAssetTools(live as any, new CC5Bridge("http://127.0.0.1:5101"));
    const r = await live.getRegisteredTool("export_fbx")({ output_path: "C:/out/char.fbx" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(error);
    expect(r.content[0].text).not.toContain("undo history");
  });
});

describe("load_asset points to the right tool for files it refuses (F-21)", () => {
  it("names the tool for images, FBX and OBJ", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const text = async (file_path: string) => (await handler({ file_path })).content[0].text as string;
    expect(await text("C:/a/overlay.png")).toBe(
      "Disallowed file extension: .png (an image goes in with load_texture (a material map) or apply_skin_overlay (a skin overlay))");
    expect(await text("C:/a/box.fbx")).toBe("Disallowed file extension: .fbx (a prop or clothing FBX goes in with " +
      "import_fbx; save first, CC5 can crash on an FBX import early in a session)");
    expect(await text("C:/a/head.obj")).toContain("replace_mesh_from_obj");
    expect(bridge.loadAsset).not.toHaveBeenCalled();
  });

  it("gives the same hints as the plugin (cc5_api._LOAD_ASSET_HINTS), which answers when TypeScript lets a file by", async () => {
    const handler = server.getRegisteredTool("load_asset");
    const plugin = fs.readFileSync(new URL("../../cc5-plugin/cc5_api.py", import.meta.url), "utf-8");
    for (const file_path of ["C:/a/overlay.png", "C:/a/box.fbx", "C:/a/head.obj"]) {
      const text = (await handler({ file_path })).content[0].text as string;
      const hint = text.slice(text.indexOf(" (") + 2, -1);
      expect(plugin).toContain(`"${hint}"`);
    }
  });
});
