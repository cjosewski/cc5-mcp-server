import fs from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { registerDialogTools, formatDialog, isAnsweredOnlyInCC5, isWindowToClose } from "../../src/tools/dialog.js";
import { SKINGEN_QUESTION_RULE } from "../../src/prompts/content-rules.js";
import type { CC5Dialog } from "../../src/types.js";
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
const WELCOME = "CC5's Welcome / What's New page (or another untitled CC5 window) is open - close it in Character " +
  "Creator 5 (tick \"Don't show this again\" so it stays closed).";
/** SkinGen's About box (F-85): its labels hold the licence serial, which the plugin redacts. */
const ABOUT = { title: "CCSkinGen", text: "SkinGen 2.0\nS/N : (serial)\nCopyright Reallusion", buttons: [] };
/** CC5's Export FBX dialog (F-99): one QQuickWidget, whose buttons are QML items the bridge cannot see. */
const EXPORT_FBX = { title: "Export FBX", text: "", buttons: [], buttons_unreadable: true };

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

  it("names an untitled dialog, and says when no MCP command waits on it", () => {
    expect(formatDialog({ title: "", text: "Apply the preset?", buttons: ["OK", "Cancel"] })).toBe(
      'CC5 dialog "(untitled)":\nApply the preset?\nButtons: OK, Cancel\n' +
      "No MCP command is waiting on this dialog: it may be the user's own, so ask the user before answering it.");
  });

  it("reports a command's progress window as CC5 being busy (F-56)", () => {
    expect(formatDialog({ title: "Exporting", text: "Exporting FBX...", buttons: ["Cancel"], progress: true }, null))
      .toBe('CC5 is busy: progress window "Exporting" (Exporting FBX...). It closes when the command finishes. ' +
        "Do not cancel it unless the user asks; they cancel it in CC5.");
  });
});

// F-94 (live): with CC5's Welcome / What's New page open, a recipe's pre-check said 'CC5 dialog "(untitled)": Buttons:
// none found' and to ask the user before answering it, while the queue guard named the page and said to close it.
describe("formatDialog words a window with no buttons as the queue guard does (F-94)", () => {
  it("an untitled window without text is the Welcome page; no 'then try again': the callers add their own", () => {
    expect(formatDialog({ title: "", text: "", buttons: [] })).toBe(WELCOME);
    expect(formatDialog({ title: "", text: "", buttons: [] }, null)).toBe(WELCOME);
  });

  it("names a titled window by its title only, never by its text", () => {
    const text = formatDialog(ABOUT, null);
    expect(text).toBe('CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP ' +
      "tool can close it).");
    expect(text).not.toContain("S/N");
    expect(text).not.toContain("Buttons");
  });

  it("names an untitled window by the first non-empty line of its text", () => {
    expect(formatDialog({ title: "", text: "\n   \n  SkinGen 2.0  \nS/N : (serial)", buttons: [] })).toBe(
      'CC5 has a window open with no buttons: "SkinGen 2.0" - close it in Character Creator 5 (no MCP tool can ' +
      "close it).");
  });

  it("cuts the name at 120 characters", () => {
    const named = (title: string) => formatDialog({ title, text: "", buttons: [] });
    expect(named("T".repeat(120))).toBe(`CC5 has a window open with no buttons: "${"T".repeat(120)}" - close it in ` +
      "Character Creator 5 (no MCP tool can close it).");
    expect(named("T".repeat(130))).toBe(`CC5 has a window open with no buttons: "${"T".repeat(117)}..." - close it in ` +
      "Character Creator 5 (no MCP tool can close it).");
  });

  it("says the job waits on that window, and to read job_status once it is closed", () => {
    expect(formatDialog(ABOUT, "cmd_ab12cd34_4")).toBe('CC5 has a window open with no buttons: "CCSkinGen" - close it ' +
      "in Character Creator 5 (no MCP tool can close it).\nJob cmd_ab12cd34_4 is waiting on this window; read its " +
      "result with job_status once it is closed.");
    expect(formatDialog({ title: "", text: "", buttons: [] }, "cmd_ab12cd34_4")).toBe(`${WELCOME}\nJob cmd_ab12cd34_4 ` +
      "is waiting on this window; read its result with job_status once it is closed.");
  });

  it("still reports a progress window without buttons as CC5 being busy", () => {
    expect(formatDialog({ title: "Loading", text: "", buttons: [], progress: true }, null)).toBe(
      'CC5 is busy: progress window "Loading". It closes when the command finishes. Do not cancel it unless the user ' +
      "asks; they cancel it in CC5.");
  });

  it("keeps the crash-recovery prompt a question when its buttons could not be read, as the guard does", () => {
    // Closing it decides about the user's unsaved work, so it is never worded as a window to close.
    const recovery = { title: "Character Creator 5", text: "Unsaved project data found. Would you like to update " +
      "your project with the unsaved changes?", buttons: [] };
    expect(formatDialog(recovery, null)).toBe(`CC5 dialog "Character Creator 5":\n${recovery.text}\nButtons: none ` +
      "found\nNo MCP command is waiting on this dialog: it may be the user's own, so ask the user before answering it.");
  });

  it("isWindowToClose: no buttons, not a progress window, not the crash-recovery prompt", () => {
    expect(isWindowToClose({ title: "", text: "", buttons: [] })).toBe(true);
    expect(isWindowToClose(ABOUT)).toBe(true);
    expect(isWindowToClose({ title: "", text: "Apply the preset?", buttons: ["OK", "Cancel"] })).toBe(false);
    expect(isWindowToClose({ title: "Loading", text: "", buttons: [], progress: true })).toBe(false);
    expect(isWindowToClose({ title: "UNSAVED PROJECT DATA FOUND", text: "", buttons: [] })).toBe(false);
  });

  it("get_cc5_dialog shows the Welcome page as a window to close in CC5", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: { title: "", text: "", buttons: [] }, waiting_job: null,
      recovery_policy: "cancel" });
    const result = await server.getRegisteredTool("get_cc5_dialog")({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(WELCOME);
  });
});

// F-99 (live): CC5's Export FBX dialog, opened by hand, was shown as 'CC5 dialog "Export FBX" ... Buttons: none found'
// with "ask the user before answering it", and the guard called it a window with no buttons: its buttons are QML items.
describe("formatDialog words a window whose buttons the bridge cannot read as the queue guard does (F-99)", () => {
  it("names it by its title, to answer or close in CC5, not as a question for answer_cc5_dialog", () => {
    const text = formatDialog(EXPORT_FBX, null);
    expect(text).toBe('CC5 has a window open whose buttons this bridge cannot read: "Export FBX" - answer or close it ' +
      "in Character Creator 5 (no MCP tool can click its buttons).");
    expect(text).not.toContain("Buttons: none found");
    expect(text).not.toContain("before answering it");
  });

  it("says the job waits on that window, and to read job_status once it is closed", () => {
    expect(formatDialog(EXPORT_FBX, "cmd_ab12cd34_5")).toBe('CC5 has a window open whose buttons this bridge cannot ' +
      'read: "Export FBX" - answer or close it in Character Creator 5 (no MCP tool can click its buttons).\nJob ' +
      "cmd_ab12cd34_5 is waiting on this window; read its result with job_status once it is closed.");
  });

  it("names an untitled one by its first line, and keeps that wording when the bridge listed a button anyway", () => {
    expect(formatDialog({ title: "", text: "Export settings\nPreset: Unity", buttons: [], buttons_unreadable: true }))
      .toBe('CC5 has a window open whose buttons this bridge cannot read: "Export settings" - answer or close it in ' +
        "Character Creator 5 (no MCP tool can click its buttons).");
    expect(formatDialog({ ...EXPORT_FBX, buttons: ["Help"] })).toBe(formatDialog(EXPORT_FBX));
  });

  it("is answered or closed in CC5: not a window to close, and no tool can answer it", () => {
    expect(isWindowToClose(EXPORT_FBX)).toBe(false);
    expect(isAnsweredOnlyInCC5(EXPORT_FBX)).toBe(true);
  });

  it("an untitled one without text is still CC5's Welcome / What's New page, which the guard names first", () => {
    const blank = { title: "", text: "", buttons: [], buttons_unreadable: true };
    expect(formatDialog(blank)).toBe(WELCOME);
    expect(isWindowToClose(blank)).toBe(true);
  });

  it("get_cc5_dialog shows it as a window to answer or close in CC5", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: EXPORT_FBX, waiting_job: null, recovery_policy: "cancel" });
    const result = await server.getRegisteredTool("get_cc5_dialog")({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(formatDialog(EXPORT_FBX));
  });
});

// Review #8: the guard asks the user to answer a window whose text could not be read; get_cc5_dialog called a titled
// one without readable buttons a window to close, and closing the crash-recovery prompt decides about unsaved work.
describe("formatDialog words a window whose text could not be read as the queue guard does (review #8)", () => {
  /** The crash-recovery prompt with neither its labels nor its buttons read: only its title is left. */
  const UNREAD = { title: "Character Creator 5", text: "", buttons: [], text_read: false };

  it("asks the user to answer it in CC5, never to close it", () => {
    expect(formatDialog(UNREAD, null)).toBe('CC5 is waiting for an answer to "Character Creator 5" - its text could ' +
      "not be read, so ask the user to answer it in CC5.");
    expect(isWindowToClose(UNREAD)).toBe(false);
    expect(isAnsweredOnlyInCC5(UNREAD)).toBe(true);
  });

  it("lists no buttons it did read (answer_cc5_dialog refuses such a dialog), and names the job waiting on it", () => {
    expect(formatDialog({ ...UNREAD, buttons: ["OK", "Cancel"] }, "cmd_ab12cd34_6")).toBe('CC5 is waiting for an ' +
      'answer to "Character Creator 5" - its text could not be read, so ask the user to answer it in CC5.\nJob ' +
      "cmd_ab12cd34_6 is waiting on this answer; read its result with job_status once the user has answered it.");
  });

  it("is never the Welcome page, even untitled, nor a window whose buttons the bridge cannot read", () => {
    expect(formatDialog({ title: "", text: "", buttons: [], text_read: false })).toBe('CC5 is waiting for an answer to ' +
      '"a dialog" - its text could not be read, so ask the user to answer it in CC5.');
    expect(formatDialog({ ...UNREAD, buttons_unreadable: true })).toBe(formatDialog(UNREAD));
    expect(isWindowToClose({ title: "", text: "", buttons: [], text_read: false })).toBe(false);
  });

  it("keeps a crash-recovery prompt named in its title a question, as the guard does", () => {
    const recovery = { title: "Unsaved project data found", text: "", buttons: ["OK", "Cancel"], text_read: false };
    expect(formatDialog(recovery)).toBe('CC5 dialog "Unsaved project data found":\nButtons: OK, Cancel\nNo MCP command ' +
      "is waiting on this dialog: it may be the user's own, so ask the user before answering it.");
    expect(isAnsweredOnlyInCC5(recovery)).toBe(false);
  });

  it("words a window whose text was read as before", () => {
    expect(formatDialog({ ...ABOUT, text_read: true })).toBe(formatDialog(ABOUT));
    expect(formatDialog({ ...LAYER, text_read: true }, "cmd_12")).toBe(formatDialog(LAYER, "cmd_12"));
  });
});

describe("isAnsweredOnlyInCC5", () => {
  it("is every window answer_cc5_dialog cannot answer, and no question, progress window or recovery prompt", () => {
    for (const d of [ABOUT, EXPORT_FBX, { title: "", text: "", buttons: [] }, { ...LAYER, text_read: false }]) {
      expect(isAnsweredOnlyInCC5(d)).toBe(true);
    }
    for (const d of [LAYER, { title: "Loading", text: "", buttons: [], progress: true },
      { title: "Character Creator 5", text: "Unsaved project data found.", buttons: [] }]) {
      expect(isAnsweredOnlyInCC5(d)).toBe(false);
    }
  });
});

// F-91 (live, 2026-10-07): a content load during a SkinGen session asked this; after OK the hidden clothing showed again.
// Batch F review #12: the rule (answer OK for a load the user asked for) goes only with a question an MCP command waits
// in, as for a waiting load (withSkinGenRule); one no MCP command waits in may come from the user's own load in CC5.
describe("formatDialog explains CC5's SkinGen session question (F-91)", () => {
  const SKINGEN = { title: "Character Creator 5", text: "Applying this content will deactivate the current SkinGen " +
    "session. Would you like to continue?", buttons: ["OK", "Cancel"] };

  it("adds the rule on the line after the question", () => {
    expect(formatDialog(SKINGEN, "cmd_ab12cd34_8")).toBe(['CC5 dialog "Character Creator 5":', SKINGEN.text,
      SKINGEN_QUESTION_RULE, "Buttons: OK, Cancel",
      "Job cmd_ab12cd34_8 is waiting on this answer; read its result with job_status after answering."].join("\n"));
  });

  it("finds the words whatever their case or line breaks", () => {
    const split = { ...SKINGEN, text: "Applying this content will DEACTIVATE the current\nSkinGen  session.\nContinue?" };
    expect(formatDialog(split, "cmd_ab12cd34_8"))
      .toContain(`${split.text}\n${SKINGEN_QUESTION_RULE}\nButtons: OK, Cancel\n`);
  });

  it("adds no rule when no MCP command waits in it: it may be the user's own load (batch F review #12)", () => {
    const own = ['CC5 dialog "Character Creator 5":', SKINGEN.text, "Buttons: OK, Cancel",
      "No MCP command is waiting on this dialog: it may be the user's own, so ask the user before answering it."]
      .join("\n");
    expect(formatDialog(SKINGEN)).toBe(own);
    expect(formatDialog(SKINGEN, null)).toBe(own);
  });

  it("adds nothing to other questions", () => {
    expect(formatDialog(LAYER, "cmd_12")).not.toContain(SKINGEN_QUESTION_RULE);
    expect(formatDialog({ ...SKINGEN, text: "Apply the preset?" }, "cmd_ab12cd34_8"))
      .not.toContain(SKINGEN_QUESTION_RULE);
  });

  it("get_cc5_dialog gives the rule only when an MCP command waits in the question (batch F review #12)", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: SKINGEN, waiting_job: null,
      recovery_policy: "cancel" });
    const own = await server.getRegisteredTool("get_cc5_dialog")({});
    expect(own.content[0].text).toBe(formatDialog(SKINGEN));
    expect(own.content[0].text).not.toContain(SKINGEN_QUESTION_RULE);
    expect(own.content[0].text).toContain("it may be the user's own, so ask the user before answering it.");

    bridge.getDialog.mockResolvedValue({ success: true, dialog: SKINGEN, waiting_job: "cmd_ab12cd34_8",
      recovery_policy: "cancel" });
    const waiting = await server.getRegisteredTool("get_cc5_dialog")({});
    expect(waiting.content[0].text).toBe(formatDialog(SKINGEN, "cmd_ab12cd34_8"));
    expect(waiting.content[0].text).toContain(`${SKINGEN.text}\n${SKINGEN_QUESTION_RULE}\n`);
  });

  it("answer_cc5_dialog's description gives the rule", () => {
    const description = server.tool.mock.calls.find((c: unknown[]) => c[0] === "answer_cc5_dialog")?.[1] as string;
    expect(description).toContain(SKINGEN_QUESTION_RULE);
  });
});

// Review #10: formatDialog's window sentences are the queue guard's (server.py _modal_dialog_error) less its "then try
// again", and the plugin's waiting text repeats them; read from server.py, so the two sides cannot drift apart.
describe("formatDialog's window sentences match server.py's (review #10)", () => {
  /** server.py with the string literals Python joins across lines ("a "\n    "b") joined and escaped quotes unescaped. */
  const SERVER_PY = fs.readFileSync(new URL("../../cc5-plugin/server.py", import.meta.url), "utf-8")
    .replace(/(['"])\s*\n\s*[rbfu]{0,2}(['"])/gi, "")
    .replace(/\\(["'])/g, "$1");
  const NAME = "@@NAME@@";
  /** formatDialog's sentence for `dialog` (no waiting job), its final period dropped, split around the window's name. */
  const parts = (dialog: CC5Dialog) => formatDialog(dialog).replace(/\.$/, "").split(NAME);

  it("the window with no buttons", () => {
    const [before, after] = parts({ title: NAME, text: "", buttons: [] });
    expect(before).toBe('CC5 has a window open with no buttons: "');
    expect(after).toBe('" - close it in Character Creator 5 (no MCP tool can close it)');
    expect(SERVER_PY).toContain(before);
    expect(SERVER_PY).toContain(after);
  });

  it("the Welcome / What's New page", () => {
    const [sentence] = parts({ title: "", text: "", buttons: [] });
    expect(sentence).toBe(WELCOME.replace(/\.$/, ""));
    expect(SERVER_PY).toContain(sentence);
  });

  it("the window whose buttons the bridge cannot read (F-99)", () => {
    const [before, after] = parts({ title: NAME, text: "", buttons: [], buttons_unreadable: true });
    expect(before).toBe('CC5 has a window open whose buttons this bridge cannot read: "');
    expect(after).toBe('" - answer or close it in Character Creator 5 (no MCP tool can click its buttons)');
    expect(SERVER_PY).toContain(before);
    expect(SERVER_PY).toContain(after);
  });

  it("the window whose text could not be read (review #8)", () => {
    const [before, after] = parts({ title: NAME, text: "", buttons: [], text_read: false });
    expect(before).toBe('CC5 is waiting for an answer to "');
    expect(SERVER_PY).toContain(before);
    // The guard builds this one from its question and an action: the action is the fixed part.
    expect(SERVER_PY).toContain(after.replace(/^" - /, ""));
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

  it("says how a stopped recipe or batch goes on after the answer (D1, D3), keeping the earlier rules", () => {
    const description = server.tool.mock.calls.find((c: unknown[]) => c[0] === "answer_cc5_dialog")?.[1] as string;
    expect(description).toContain("When a recipe or batch stopped on the question, go on with the call its report gives; " +
      "for Replace / Material Only pass the user's button as layer_answer (it then answers that question for the rest of " +
      "that run only).");
    // RB-6: layer_answer accepts only Replace and Material Only, so a Cancel goes on without it.
    expect(description).toContain("If the user picked Cancel, go on with continue_after and no layer_answer: a Cancel " +
      "is not carried, and the next identical question goes to the user again.");
    expect(description).toContain("progress window");
    expect(description).toContain("A dialog no MCP command is waiting on");
    expect(description).toContain("After answering, read the waiting command's result with job_status.");
    for (const call of server.tool.mock.calls) expect((call[1] as string).length).toBeLessThan(2000);
  });
});

describe("recovery prompt answered by the plugin (F-52)", () => {
  it("get_cc5_dialog reports each automatic answer, so it is never silent", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null, recovery_policy: "cancel",
      recovery_answered: [{ time: "2026-10-05 16:01:00", button: "Cancel", text: "Unsaved project data found." }] });
    const r = await server.getRegisteredTool("get_cc5_dialog")({});
    expect(r.content[0].text).toBe("No CC5 dialog is open.\nWhen CC5 started, its \"Unsaved project data found\" prompt "
      + "was answered Cancel automatically (2026-10-05 16:01:00, local time): the auto-saved changes were discarded.");
  });
});
