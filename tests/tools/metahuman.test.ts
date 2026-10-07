import { describe, it, expect, beforeEach } from "vitest";
import { BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { registerMetaHumanTools, BAKE_SKIN_DESCRIPTION, bakeSkinReply } from "../../src/tools/metahuman.js";
import { createMockBridge, mockJobs } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMetaHumanTools(server as any, bridge as any);
});

describe("export_head_metahuman validation failures carry isError", () => {
  it("rejects a relative output_dir", async () => {
    const r = await server.getRegisteredTool("export_head_metahuman")({ output_dir: "rel/dir", character_name: "P1", gender: "Female" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("absolute");
  });

  it("rejects a bad character_name", async () => {
    const r = await server.getRegisteredTool("export_head_metahuman")({ output_dir: "D:/out", character_name: "a/b", gender: "Female" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("invalid characters");
  });
});

// F-84 (live CC5 5.13): the tool used to open SkinGen's About box and call it the Skin Editor. F-87 (live): CC5 5.13's
// bake command is "Bake All &Skin Textures" (qtBakeAllSkinTextureAction, Character menu), disabled in every state tried.
describe("bake_skin_textures", () => {
  const bake = () => server.getRegisteredTool("bake_skin_textures");
  const MANUAL = "Bake the skin by hand in Character Creator 5: open the character's skin editor (SkinGen), set the " +
    "texture size to 4096 and bake.";
  const MISSING = "CC5 has no Bake / Apply Skin / Skin Editor command the plugin can run, so nothing was opened";
  const SKINGEN = [
    { text: "About", objectName: "qtSkinGenAboutAction" },
    { text: "Online Manual", objectName: "qtSkinGenOnlineManualAction" },
    { text: "Video Tutorial", objectName: "qtSkinGenVideoTutorialAction" },
    { text: "Remove SkinGen Data", objectName: "qtSkinGenRemoveDataAction" },
  ];
  const SKINGEN_LOOKED_AT = "About (qtSkinGenAboutAction), Online Manual (qtSkinGenOnlineManualAction), Video Tutorial " +
    "(qtSkinGenVideoTutorialAction), Remove SkinGen Data (qtSkinGenRemoveDataAction)";
  const BAKE_ALL = { text: "Bake All Skin Textures", objectName: "qtBakeAllSkinTextureAction" };

  it("names CC5 5.13's bake command and says the resolution cannot be passed to it and its result is not checked", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "bake_skin_textures")?.[1] as string;
    expect(description).toBe(BAKE_SKIN_DESCRIPTION);
    expect(description).toBe("Trigger CC5's own skin bake command if one is enabled (Bake, else Apply Skin, else Skin " +
      "Editor; CC5 5.13 has \"Bake All Skin Textures\" in the Character menu). CC5 has no bake API: the resolution " +
      "cannot be passed to the command and its result is not checked, so check it with captures and get_cc5_dialog. " +
      "A disabled command is not run: the tool names it and returns the manual steps, as it does when CC5 has none.");
    expect(description).not.toContain("no such command");
  });

  it("runs as a job and, without a bake command, gives the plugin's answer, the manual step and the commands it looked at", async () => {
    // A job keeps the whole failed result: a failed direct call would bring back the error text alone.
    const started = mockJobs(bridge, { bake_skin_textures: { success: false, manual_step_required: true,
      error: MISSING, instructions: MANUAL, notes: [], candidates_inspected: SKINGEN, disabled_candidates: [] } });
    const r = await bake()({ resolution: 4096 });
    expect(started).toEqual([{ action: "bake_skin_textures", params: { resolution: 4096 } }]);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe([
      MISSING,
      `Manual step: ${MANUAL}`,
      `Commands looked at: ${SKINGEN_LOOKED_AT}`,
    ].join("\n"));
    expect(r.content[0].text).not.toContain("Skin bake initiated");
  });

  // F-87 (live 2026-10-07): the reply began "No skin bake command found:" and then named the disabled commands.
  it("names a disabled bake command and when CC5 enables it, never saying none was found (F-87)", async () => {
    const disabled = "CC5's \"Bake All Skin Textures\" command is disabled right now, so nothing was run. CC5 enables " +
      "it once the character has SkinGen layers applied in the Appearance Editor.";
    mockJobs(bridge, { bake_skin_textures: { success: false, manual_step_required: true, error: disabled,
      instructions: MANUAL, notes: [], candidates_inspected: [...SKINGEN, BAKE_ALL], disabled_candidates: [BAKE_ALL] } });
    const r = await bake()({ resolution: 4096 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe([
      disabled,
      `Manual step: ${MANUAL}`,
      `Commands looked at: ${SKINGEN_LOOKED_AT}, Bake All Skin Textures (qtBakeAllSkinTextureAction)`,
    ].join("\n"));
    expect(r.content[0].text).not.toContain("No skin bake command");
  });

  it("does not say none was found when the command it found failed to trigger (F-87)", async () => {
    const bakeSkin = { text: "Bake Skin Textures", objectName: "" };
    mockJobs(bridge, { bake_skin_textures: { success: false, manual_step_required: true,
      error: "wrapped C/C++ object of type QAction has been deleted", instructions: MANUAL, notes: [],
      candidates_inspected: [bakeSkin], disabled_candidates: [] } });
    const r = await bake()({ resolution: 512 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe([
      "No skin bake command was run: wrapped C/C++ object of type QAction has been deleted",
      `Manual step: ${MANUAL}`,
      "Commands looked at: Bake Skin Textures",
    ].join("\n"));
    expect(r.content[0].text).not.toContain("found");
  });

  // F-87 (live): "Commands looked at" left out the disabled Substance bake the first line named. An older plugin lists
  // only skin-related actions, at most 20, so a command it names can be missing from that list.
  it("lists every command the reply names among the commands looked at", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ text: `Skin Layer ${i}`, objectName: "" }));
    const disabled = "CC5's \"Bake All Skin Textures\" command is disabled right now, so nothing was run";
    expect(bakeSkinReply({ success: false, manual_step_required: true, error: disabled, instructions: MANUAL, notes: [],
      candidates_inspected: twenty, disabled_candidates: [BAKE_ALL] }).split("\n").at(-1))
      .toBe(`Commands looked at: ${twenty.map((c) => c.text).join(", ")}, Bake All Skin Textures (qtBakeAllSkinTextureAction)`);
    const opened = bakeSkinReply({ success: true, triggered_action: "Skin Editor", command_kind: "skin_editor",
      manual_step_required: true, instructions: "CC5 opened 'Skin Editor'.", notes: [], candidates_inspected: twenty,
      disabled_candidates: [BAKE_ALL] }).split("\n");
    expect(opened[2]).toBe("Disabled in CC5 right now, so not run: Bake All Skin Textures (qtBakeAllSkinTextureAction)");
    expect(opened[3]).toBe(`Commands looked at: ${twenty.map((c) => c.text).join(", ")}, Bake All Skin Textures ` +
      "(qtBakeAllSkinTextureAction), Skin Editor");
    // A command already listed, by its text or its objectName, is not listed twice.
    const byName = bakeSkinReply({ success: true, triggered_action: "qtBakeAllSkinTextureAction", command_kind: "bake",
      manual_step_required: true, instructions: "Check it.", notes: [], candidates_inspected: [BAKE_ALL],
      disabled_candidates: [] }).split("\n");
    expect(byName[2]).toBe("Commands looked at: Bake All Skin Textures (qtBakeAllSkinTextureAction)");
  });

  it("says CC5 was asked to run its bake command and claims no result (F-87)", async () => {
    const check = "This bridge has not yet seen CC5's \"Bake All Skin Textures\" command run and could not pass the " +
      "texture size (4096) to it: check what it did with captures and get_cc5_dialog.";
    const note = "Triggered QAction: text='Bake All &Skin Textures' objectName='qtBakeAllSkinTextureAction'";
    mockJobs(bridge, { bake_skin_textures: { success: true, resolution: 4096, triggered_action: "Bake All Skin Textures",
      command_kind: "bake", manual_step_required: true, instructions: check, notes: [note],
      candidates_inspected: [...SKINGEN, BAKE_ALL], disabled_candidates: [] } });
    const r = await bake()({ resolution: 4096 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe([
      "Asked CC5 to run: Bake All Skin Textures",
      check,
      `Commands looked at: ${SKINGEN_LOOKED_AT}, Bake All Skin Textures (qtBakeAllSkinTextureAction)`,
      `Notes: ${note}`,
    ].join("\n"));
    expect(r.content[0].text).not.toContain("Opened");
    expect(r.content[0].text).not.toContain("Manual step");
  });

  it("names the panel CC5 opened, then the manual step, a disabled bake command, the commands looked at and the notes", async () => {
    const opened = "CC5 opened 'Skin Editor'. Set the texture size to 2048 there and run the bake: the plugin cannot " +
      "press it.";
    mockJobs(bridge, { bake_skin_textures: { success: true, resolution: 2048, triggered_action: "Skin Editor",
      command_kind: "skin_editor", manual_step_required: true, instructions: opened,
      notes: ["Triggered QAction: text='Skin Editor' objectName='qtSkinEditorAction'"],
      candidates_inspected: [BAKE_ALL, { text: "Skin Editor", objectName: "qtSkinEditorAction" }, { text: "Skin Layers", objectName: "" }],
      disabled_candidates: [BAKE_ALL] } });
    const r = await bake()({ resolution: 2048 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe([
      "Opened in CC5: Skin Editor",
      `Manual step: ${opened}`,
      "Disabled in CC5 right now, so not run: Bake All Skin Textures (qtBakeAllSkinTextureAction)",
      "Commands looked at: Bake All Skin Textures (qtBakeAllSkinTextureAction), Skin Editor (qtSkinEditorAction), " +
        "Skin Layers",
      "Notes: Triggered QAction: text='Skin Editor' objectName='qtSkinEditorAction'",
    ].join("\n"));
  });

  it("leaves out the commands line when it looked at none", () => {
    expect(bakeSkinReply({ success: false, error: "QApplication.instance() returned None", instructions: MANUAL,
      notes: [], candidates_inspected: [] }))
      .toBe(`No skin bake command was run: QApplication.instance() returned None\nManual step: ${MANUAL}`);
  });

  it("shows CC5's question when the command it opened waits for an answer", async () => {
    const message = 'CC5 is waiting for an answer to "Bake the skin now?" (the "Skin Editor" window). Buttons: Bake, ' +
      'Cancel. The command is still running as job cmd_ab12cd34_5: answer it with answer_cc5_dialog (ask the user when ' +
      'it is a real choice), then check its result with job_status("cmd_ab12cd34_5").';
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_5" });
    bridge.getJob.mockResolvedValue({ job_id: "cmd_ab12cd34_5", action: "bake_skin_textures", status: "running",
      dialog: { title: "Skin Editor", text: "Bake the skin now?", buttons: ["Bake", "Cancel"] }, dialog_message: message });
    const r = await bake()({ resolution: 4096 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(message);
  });

  it("shows the open-window guard's text as CC5 wrote it when the job never reached the bake", async () => {
    // The guard failed the job before it ran: no manual step and no commands looked at, so not "no bake command".
    const guard = 'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool ' +
      "can close it), then try again.";
    mockJobs(bridge, { bake_skin_textures: { success: false, error: guard } });
    const r = await bake()({ resolution: 4096 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(guard);
    expect(bakeSkinReply({ success: false })).toBe("unknown error");
  });

  it("says when CC5 cannot be reached", async () => {
    bridge.startJob.mockRejectedValue(new BridgeUnreachableError("fetch failed (ECONNREFUSED)"));
    const r = await bake()({ resolution: 4096 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Is CC5 running");
  });
});
