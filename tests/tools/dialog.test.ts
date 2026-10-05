import { describe, it, expect, beforeEach } from "vitest";
import { registerDialogTools, formatDialog } from "../../src/tools/dialog.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

const LAYER = {
  title: "Character Creator 5",
  text: "The target object layer already exists.\nDo you want to replace the object, or the material only?",
  buttons: ["Replace", "Material Only", "Cancel"],
};

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerDialogTools(server as any, bridge as any);
});

describe("formatDialog", () => {
  it("says when no dialog is open", () => {
    expect(formatDialog(null)).toBe("No CC5 dialog is open.");
  });

  it("shows the title, question, buttons and waiting job", () => {
    expect(formatDialog(LAYER, "cmd_12")).toBe(
      'CC5 dialog "Character Creator 5":\n' + LAYER.text + "\nButtons: Replace, Material Only, Cancel\n" +
      "Job cmd_12 is waiting on this answer; read its result with job_status after answering.");
  });

  it("names an untitled dialog without buttons", () => {
    expect(formatDialog({ title: "", text: "", buttons: [] })).toBe('CC5 dialog "(untitled)":\nButtons: none found');
  });
});

describe("dialog tools", () => {
  it("registers get_cc5_dialog and answer_cc5_dialog", () => {
    expect(server.tool).toHaveBeenCalledTimes(2);
    expect(server.getRegisteredTool("get_cc5_dialog")).toBeTypeOf("function");
    expect(server.getRegisteredTool("answer_cc5_dialog")).toBeTypeOf("function");
  });

  it("get_cc5_dialog shows the open dialog", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_3" });
    const result = await server.getRegisteredTool("get_cc5_dialog")({});
    expect(result.content[0].text).toContain("Buttons: Replace, Material Only, Cancel");
    expect(result.content[0].text).toContain("Job cmd_3 is waiting");
  });

  it("answer_cc5_dialog clicks the named button", async () => {
    bridge.answerDialog.mockResolvedValue({ success: true, clicked: "Material Only", dialog: LAYER });
    const result = await server.getRegisteredTool("answer_cc5_dialog")({ button: "material only" });
    expect(bridge.answerDialog).toHaveBeenCalledWith("material only");
    expect(result.content[0].text).toBe('Clicked "Material Only" in CC5\'s "Character Creator 5".');
  });

  it("answer_cc5_dialog passes the expected question on", async () => {
    bridge.answerDialog.mockResolvedValue({ success: true, clicked: "Replace", dialog: LAYER });
    await server.getRegisteredTool("answer_cc5_dialog")({ button: "Replace", expect: "layer already exists" });
    expect(bridge.answerDialog).toHaveBeenCalledWith("Replace", "layer already exists");
  });

  it("answer_cc5_dialog reports a refusal as an error", async () => {
    bridge.answerDialog.mockResolvedValue({ success: false, error: "No CC5 dialog is open" });
    const result = await server.getRegisteredTool("answer_cc5_dialog")({ button: "OK" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Failed: No CC5 dialog is open");
  });

  it("tells the agent the answering rules", () => {
    const description = server.tool.mock.calls.find((c: unknown[]) => c[0] === "answer_cc5_dialog")?.[1] as string;
    expect(description).toContain("plain confirmation");
    expect(description).toContain("real choice");
    expect(description).toContain("Unsaved project data found");
  });
});

describe("recovery prompt answered by the plugin (F-52)", () => {
  it("get_cc5_dialog reports each automatic answer, so it is never silent", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null, recovery_policy: "cancel",
      recovery_answered: [{ time: "2026-10-05 16:01:00", button: "Cancel", text: "Unsaved project data found." }] });
    const r = await server.getRegisteredTool("get_cc5_dialog")({});
    expect(r.content[0].text).toBe("No CC5 dialog is open.\nCC5's \"Unsaved project data found\" prompt was answered "
      + "Cancel at 2026-10-05 16:01:00 (the auto-saved changes were discarded).");
  });
});
