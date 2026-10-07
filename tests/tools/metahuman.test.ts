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

// F-84 (live CC5 5.13): no CC5 command bakes the skin; the tool used to open SkinGen's About box and call it the
// Skin Editor.
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

  it("says the bake is done by hand and that CC5 5.13 has no command to open", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "bake_skin_textures")?.[1] as string;
    expect(description).toBe(BAKE_SKIN_DESCRIPTION);
    expect(description).toBe("Open CC5's skin bake command (Bake / Apply Skin / Skin Editor) if CC5 has one; CC5 has no " +
      "bake API, so the bake itself is done by hand in CC5. CC5 5.13 has no such command: the tool then opens nothing " +
      "and returns the manual steps.");
  });

  it("runs as a job and, without a bake command, gives the manual step and the commands it looked at", async () => {
    // A job keeps the whole failed result: a failed direct call would bring back the error text alone.
    const started = mockJobs(bridge, { bake_skin_textures: { success: false, manual_step_required: true,
      error: MISSING, instructions: MANUAL, notes: [], candidates_inspected: SKINGEN } });
    const r = await bake()({ resolution: 4096 });
    expect(started).toEqual([{ action: "bake_skin_textures", params: { resolution: 4096 } }]);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe([
      `No skin bake command found: ${MISSING}`,
      `Manual step: ${MANUAL}`,
      "Commands looked at: About (qtSkinGenAboutAction), Online Manual (qtSkinGenOnlineManualAction), Video Tutorial " +
        "(qtSkinGenVideoTutorialAction), Remove SkinGen Data (qtSkinGenRemoveDataAction)",
    ].join("\n"));
    expect(r.content[0].text).not.toContain("Skin bake initiated");
  });

  it("names the command CC5 opened, then the manual step, the commands looked at and the notes", async () => {
    const opened = "CC5 opened 'Bake Skin Textures'. Set the texture size to 2048 there and run the bake: the plugin " +
      "cannot press it.";
    mockJobs(bridge, { bake_skin_textures: { success: true, resolution: 2048, triggered_action: "Bake Skin Textures",
      manual_step_required: true, instructions: opened,
      notes: ["Triggered QAction: text='Bake Skin Textures' objectName='qtBakeSkinAction'"],
      candidates_inspected: [{ text: "Bake Skin Textures", objectName: "qtBakeSkinAction" }, { text: "Skin Layers", objectName: "" }] } });
    const r = await bake()({ resolution: 2048 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe([
      "Opened in CC5: Bake Skin Textures",
      `Manual step: ${opened}`,
      "Commands looked at: Bake Skin Textures (qtBakeSkinAction), Skin Layers",
      "Notes: Triggered QAction: text='Bake Skin Textures' objectName='qtBakeSkinAction'",
    ].join("\n"));
  });

  it("leaves out the commands line when it looked at none", () => {
    expect(bakeSkinReply({ success: false, error: "QApplication.instance() returned None", instructions: MANUAL,
      notes: [], candidates_inspected: [] }))
      .toBe(`No skin bake command found: QApplication.instance() returned None\nManual step: ${MANUAL}`);
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
