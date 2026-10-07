/**
 * check_fit (F-44 phase 1): frames the character from several views and captures each into one folder, returning
 * every image with its view and file path and a reading rubric. It detects nothing and never calls a fit clean; at
 * the first view it cannot capture properly it stops with INCOMPLETE and sends CC5 nothing more (D1).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeHttpError, BridgeTimeoutError, BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { claimScene } from "../../src/scene-lock.js";
import { formatDialog } from "../../src/tools/dialog.js";
import { registerFitTools, FIT_DESCRIPTION, RUBRIC, FIXES, SIDE_EFFECTS } from "../../src/tools/fit.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";
import { png } from "../helpers/images.js";

// ── setup ─────────────────────────────────────────────────────────────────────

const STAMP = 1700000000000;
const KEVIN = { name: "Kevin", id: "1", type: "x" };
const CAMILA = { name: "Camila", id: "2", type: "x" };
/** The default views in order, and what frame_camera is sent for each ('front' goes as CC5's Home view). */
const VIEWS = ["face", "left", "right", "back", "front"];
const SENT = ["face", "left", "right", "back", "home"];
const LAYER = {
  title: "Character Creator 5",
  text: "The target object layer already exists.\nDo you want to replace the object, or the material only?",
  buttons: ["&Replace", "Material Only", "Cancel"],
};
const FOOTER = [RUBRIC, FIXES, SIDE_EFFECTS].join("\n");
const CANCELLED = "CC5 timed out (cancelled): Timed out before CC5 started the command; it was cancelled and will not run.";
/** The header of a default check of Kevin, the only character in the scene. */
const HEADER = "Fit check of Kevin: 5 views (face, left, right, back, front).\n" +
  "Wearing: Boxers; hair: none; accessories: Hat_DarkBlue.";

type Entry = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Entry[]; isError?: boolean };

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;
let tmp: string;

const checkFolder = () => path.join(tmp, "cc5_fit", `check_${STAMP}`);
const fileFor = (i: number, view: string) => path.join(checkFolder(), `${i}_${view}.png`);
const image = (seed: number) => png(1280, 720, seed).toString("base64");
const incompleteAt = (view: string, i: number, before: boolean) =>
  `INCOMPLETE: the fit check of Kevin stopped at view '${view}' (${i}/5); ` +
  `${before ? "the images taken before it are below" : "no image was taken"}. Do not treat this as a pass.\nWhy: `;
/**
 * The first text block of a default check's INCOMPLETE reply: the stop and why, the header, then the first view's
 * label when an image was taken, else the rubric (F-95: text blocks that follow each other are one block).
 */
const incompleteText = (view: string, i: number, before: boolean, why: string) =>
  `${incompleteAt(view, i, before)}${why}\n${HEADER}\n${before ? `View 1/5: face (${fileFor(1, "face")})` : FOOTER}`;

async function run(args: Record<string, unknown> = {}, extra?: unknown): Promise<Result> {
  return (await server.getRegisteredTool("check_fit")(args, extra)) as Result;
}
const textsOf = (r: Result) => r.content.filter((e) => e.type === "text").map((e) => e.text as string);
const imagesOf = (r: Result) => r.content.filter((e) => e.type === "image");
const lastLine = (e: Entry) => (e.text ?? "").split("\n").at(-1);

/** F-95: Claude Code shows text blocks that follow each other with no separator, so no text block follows another. */
function expectNoTextAfterText(r: Result) {
  r.content.forEach((e, k) => {
    if (k > 0 && e.type === "text") expect(r.content[k - 1].type).toBe("image");
  });
}

/** The k-th call (from 1) of a bridge mock runs `impl`; its other calls behave as before. */
function onCall(mock: MockBridge[keyof MockBridge], k: number, impl: (...args: unknown[]) => unknown) {
  const usual = mock.getMockImplementation();
  let calls = 0;
  mock.mockImplementation(async (...args: unknown[]) => (++calls === k ? impl(...args) : usual?.(...args)));
}

/** Nothing holds the scene any more: the next batch, recipe or check can start. */
function expectSceneFree() {
  const release = claimScene("next");
  expect(release).toBeTypeOf("function");
  if (typeof release === "function") release();
}

/** CC5 was asked to frame or capture nothing, and no check folder was made. */
function expectNothingCaptured() {
  expect(bridge.frameCamera).not.toHaveBeenCalled();
  expect(bridge.captureViewport).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(tmp, "cc5_fit"))).toBe(false);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc5-fit-"));
  vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
  vi.spyOn(Date, "now").mockReturnValue(STAMP);
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFitTools(server as any, bridge as any);
  bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
  bridge.getAvatars.mockResolvedValue([KEVIN]);
  bridge.listClothes.mockResolvedValue([{ name: "Boxers", id: 1, type: "x" }]);
  bridge.listHair.mockResolvedValue([]);
  bridge.listAccessories.mockResolvedValue([{ name: "Hat_DarkBlue", id: 2 }]);
  bridge.frameCamera.mockImplementation(async (view: string, target?: string) => ({ success: true, view, framed: target }));
  let captures = 0;
  bridge.captureViewport.mockImplementation(async (file?: string) => ({ success: true, path: file, base64: image(++captures) }));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── registration ──────────────────────────────────────────────────────────────

describe("check_fit registration", () => {
  it("registers exactly one tool, check_fit", () => {
    expect(server.tool).toHaveBeenCalledTimes(1);
    expect(server.tool).toHaveBeenCalledWith("check_fit", FIT_DESCRIPTION, expect.any(Object), expect.any(Function));
  });

  it("says it never calls a fit clean, its default views, what it costs redo, and when it is refused", () => {
    const description = server.tool.mock.calls[0][1] as string;
    expect(description).toContain("never reports a fit as clean");
    expect(description).toContain("default face, left, right, back, front");
    expect(description).toContain("can no longer be redone");
    expect(description).toContain("while CC5 shows a dialog");
  });
});

// ── a full check ──────────────────────────────────────────────────────────────

describe("check_fit default run", () => {
  it("frames and captures face, left, right, back and front in turn, into one check folder at 1280x720", async () => {
    await run();
    expect(bridge.getDialog).toHaveBeenCalledWith(3000);
    expect(bridge.frameCamera.mock.calls).toEqual(SENT.map((view) => [view, "Kevin"]));
    expect(bridge.captureViewport.mock.calls).toEqual(VIEWS.map((view, k) => [fileFor(k + 1, view), 1280, 720]));
    const framed = bridge.frameCamera.mock.invocationCallOrder;
    const captured = bridge.captureViewport.mock.invocationCallOrder;
    for (let k = 0; k < 5; k++) {
      expect(captured[k]).toBeGreaterThan(framed[k]);
      if (k < 4) expect(captured[k]).toBeLessThan(framed[k + 1]);
    }
  });

  it("returns a header, each view's label and image, and the reading rubric, and calls nothing clean", async () => {
    const r = await run();
    expect(r.isError).toBeUndefined();
    // The header and the first view's label are one text block (F-95); every label comes just before its image.
    expect(r.content).toHaveLength(11);
    expectNoTextAfterText(r);
    VIEWS.forEach((view, k) => {
      const label = `View ${k + 1}/5: ${view} (${fileFor(k + 1, view)})`;
      expect(r.content[2 * k]).toEqual({ type: "text", text: k === 0 ? `${HEADER}\n${label}` : label });
      expect(r.content[1 + 2 * k]).toEqual({ type: "image", data: image(k + 1), mimeType: "image/png" });
    });
    expect(r.content[10]).toEqual({ type: "text", text: FOOTER });
    for (const words of ["does not detect anything", "not a logo", "show the user every view", "remove_scene_item",
      "can no longer be redone"]) {
      expect(FOOTER).toContain(words);
    }
    for (const text of textsOf(r)) expect(text).not.toMatch(/\bclean\b|\bpassed\b/i);
  });

  it("creates the check folder itself, so a later check can remove it", async () => {
    await run();
    expect(fs.statSync(checkFolder()).isDirectory()).toBe(true);
  });

  it("labels a view with the planned file when CC5 does not send the path back", async () => {
    bridge.captureViewport.mockResolvedValueOnce({ success: true, base64: image(9) });
    const r = await run();
    expect(lastLine(r.content[0])).toBe(`View 1/5: face (${fileFor(1, "face")})`);
    expect(imagesOf(r)).toHaveLength(5);
  });
});

describe("check_fit views", () => {
  it("captures a view asked for twice once, where it first appears", async () => {
    const r = await run({ views: ["back", "face", "back"] });
    expect(bridge.frameCamera.mock.calls).toEqual([["back", "Kevin"], ["face", "Kevin"]]);
    expect(bridge.captureViewport.mock.calls.map((c) => c[0])).toEqual([fileFor(1, "back"), fileFor(2, "face")]);
    expect(r.content[0].text).toContain("Fit check of Kevin: 2 views (back, face).");
    expect(lastLine(r.content[0])).toBe(`View 1/2: back (${fileFor(1, "back")})`);
    expect(r.content[2].text).toBe(`View 2/2: face (${fileFor(2, "face")})`);
    expect(imagesOf(r)).toHaveLength(2);
  });

  it("sends 'front' as CC5's Home view, the whole-body front view verified live", async () => {
    const r = await run({ views: ["front"] });
    expect(bridge.frameCamera.mock.calls).toEqual([["home", "Kevin"]]);
    expect(bridge.captureViewport).toHaveBeenCalledWith(fileFor(1, "front"), 1280, 720);
    expect(r.content[0].text).toContain("Fit check of Kevin: 1 view (front).");
    expect(lastLine(r.content[0])).toBe(`View 1/1: front (${fileFor(1, "front")})`);
  });
});

describe("check_fit schema", () => {
  const schema = () => z.object(server.tool.mock.calls.find((c) => c[0] === "check_fit")?.[2] as z.ZodRawShape);

  it("offers only the views verified live, one to five of them", () => {
    for (const views of [["all"], ["focus"], ["bottom"], ["top"], ["home"], [],
      ["face", "front", "left", "right", "back", "face"]]) {
      expect(schema().safeParse({ views }).success).toBe(false);
    }
    expect(schema().safeParse({ views: ["face"] }).success).toBe(true);
    expect(schema().safeParse({}).success).toBe(true);
  });

  it("takes a target name", () => {
    expect(schema().safeParse({ target: "" }).success).toBe(false);
    expect(schema().safeParse({ target: "Kevin" }).success).toBe(true);
  });
});

// ── refusals ──────────────────────────────────────────────────────────────────

describe("check_fit refuses before capturing anything", () => {
  it("while a recipe or batch holds the scene, without asking CC5 anything", async () => {
    const held = claimScene("apply_character_recipe");
    if (typeof held !== "function") throw new Error("the scene was not free");
    try {
      const r = await run();
      expect(r.isError).toBe(true);
      expect(r.content).toEqual([{ type: "text", text: "apply_character_recipe is still running in CC5. Wait for it to " +
        "finish before starting a fit check: two at once would edit the same scene." }]);
      expect(bridge.getDialog).not.toHaveBeenCalled();
      expect(bridge.getAvatars).not.toHaveBeenCalled();
      expectNothingCaptured();
      expect(claimScene("next")).toBeTypeOf("string"); // still the recipe's
    } finally {
      held();
    }
    expectSceneFree();
  });

  it("while CC5 shows a question: it shows the question and does not answer it", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_3" });
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: formatDialog(LAYER, "cmd_ab12cd34_3") +
      "\ncheck_fit captured nothing: run it again once this dialog is answered or closed." }]);
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(bridge.answerDialog).not.toHaveBeenCalled();
    expectNothingCaptured();
    expectSceneFree();
  });

  it("while CC5 shows a command's progress window: CC5 is busy, run it again when it has finished", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, waiting_job: null,
      dialog: { title: "Exporting", text: "Exporting FBX...", buttons: ["Cancel"], progress: true } });
    const r = await run();
    expect(r.isError).toBe(true);
    const text = r.content[0].text as string;
    expect(text).toContain("CC5 is busy");
    expect(text).toContain("when CC5 has finished");
    expect(text).not.toContain("answered or closed");
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(bridge.answerDialog).not.toHaveBeenCalled();
    expectNothingCaptured();
    expectSceneFree();
  });

  it("when the scene has no character", async () => {
    bridge.getAvatars.mockResolvedValue([]);
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("No avatar in the scene: nothing to check.");
    expectNothingCaptured();
    expectSceneFree();
  });

  it("when CC5's avatar list is not a list, as for an empty scene", async () => {
    bridge.getAvatars.mockResolvedValue(undefined);
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("No avatar in the scene: nothing to check.");
    expectNothingCaptured();
    expectSceneFree();
  });

  it("when several characters are in the scene and no target is given", async () => {
    bridge.getAvatars.mockResolvedValue([KEVIN, CAMILA]);
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Several characters are in the scene (Kevin, Camila): pass target.");
    expectNothingCaptured();
    expectSceneFree();
  });

  it("when no character has the target's name", async () => {
    bridge.getAvatars.mockResolvedValue([KEVIN, CAMILA]);
    const r = await run({ target: "Bob" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Avatar not found: Bob. Characters: Kevin, Camila");
    expectNothingCaptured();
    expectSceneFree();
  });

  it("when two characters share the target's name, which CC5 cannot frame apart", async () => {
    bridge.getAvatars.mockResolvedValue([KEVIN, { ...KEVIN, id: "3" }]);
    const r = await run({ target: "Kevin" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("More than one character is named Kevin: CC5 frames a character by name, so it " +
      "cannot tell them apart. Rename or remove one in CC5 first. Nothing was captured.");
    expectNothingCaptured();
    expectSceneFree();
  });

  it("when the target matches several characters only by ignoring case", async () => {
    bridge.getAvatars.mockResolvedValue([KEVIN, { name: "KEVIN", id: "3", type: "x" }]);
    const r = await run({ target: "kevin" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Several characters match kevin (Kevin, KEVIN): pass the exact name.");
    expectNothingCaptured();
    expectSceneFree();
  });

  it("when CC5 cannot be reached, asking whether it is running", async () => {
    bridge.getAvatars.mockRejectedValue(new BridgeUnreachableError("fetch failed (ECONNREFUSED)"));
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Is CC5 running");
    expectNothingCaptured();
    expectSceneFree();
  });
});

// ── the character and the header ──────────────────────────────────────────────

describe("check_fit picks the character", () => {
  it("matches the target ignoring case when only one character fits, and sends CC5 that character's own name", async () => {
    const r = await run({ target: "kevin" });
    expect(r.isError).toBeUndefined();
    expect(bridge.frameCamera.mock.calls.map((c) => c[1])).toEqual(["Kevin", "Kevin", "Kevin", "Kevin", "Kevin"]);
    expect(r.content[0].text).toContain("Fit check of Kevin: 5 views");
  });

  it("prefers the exact name over a name that differs only in case", async () => {
    bridge.getAvatars.mockResolvedValue([{ name: "kevin", id: "3", type: "x" }, KEVIN]);
    const r = await run({ target: "Kevin" });
    expect(r.isError).toBeUndefined();
    expect(bridge.frameCamera.mock.calls.map((c) => c[1])).toEqual(["Kevin", "Kevin", "Kevin", "Kevin", "Kevin"]);
    // This Kevin is the second character: the list tools would read the first one's items.
    expect(r.content[0].text).toBe("Fit check of Kevin: 5 views (face, left, right, back, front).\n" +
      `View 1/5: face (${fileFor(1, "face")})`);
  });

  it("checks a character other than the first without a Wearing line: the list tools read only the first", async () => {
    bridge.getAvatars.mockResolvedValue([KEVIN, CAMILA]);
    const r = await run({ target: "Camila" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("Fit check of Camila: 5 views (face, left, right, back, front).\n" +
      `View 1/5: face (${fileFor(1, "face")})`);
    expect(bridge.listClothes).not.toHaveBeenCalled();
    expect(bridge.listHair).not.toHaveBeenCalled();
    expect(bridge.listAccessories).not.toHaveBeenCalled();
    expect(bridge.frameCamera.mock.calls.map((c) => c[1])).toEqual(["Camila", "Camila", "Camila", "Camila", "Camila"]);
  });

  it("names the first character's items when it is the one checked", async () => {
    bridge.getAvatars.mockResolvedValue([KEVIN, CAMILA]);
    const r = await run({ target: "Kevin" });
    expect(r.content[0].text).toBe("Fit check of Kevin: 5 views (face, left, right, back, front).\n" +
      `Wearing: Boxers; hair: none; accessories: Hat_DarkBlue.\nView 1/5: face (${fileFor(1, "face")})`);
  });
});

describe("check_fit's Wearing line", () => {
  it("says what it could not read, and still checks", async () => {
    bridge.listHair.mockRejectedValue(new BridgeHttpError("CC5 bridge error (500): boom", 500));
    const r = await run();
    expect(r.content[0].text).toContain("\nWearing: Boxers; hair: (not read); accessories: Hat_DarkBlue.");
    expect(r.isError).toBeUndefined();
    expect(imagesOf(r)).toHaveLength(5);
  });

  it("says when nothing is worn, lists several items, and marks a reply that is not a list as not read", async () => {
    bridge.listClothes.mockResolvedValue([]);
    bridge.listHair.mockResolvedValue([{ name: "Oval Afro", id: 3, type: "x" }, { name: "Brows", id: 4, type: "x" }]);
    bridge.listAccessories.mockResolvedValue(undefined);
    const r = await run();
    expect(r.content[0].text).toContain("\nWearing: nothing; hair: Oval Afro, Brows; accessories: (not read).");
  });
});

describe("check_fit goes ahead when the dialog check gives no answer", () => {
  it.each([
    ["is not answered in time", (b: MockBridge) => b.getDialog.mockRejectedValue(new BridgeTimeoutError("No reply from CC5 within 3s."))],
    ["resolves nothing", (b: MockBridge) => b.getDialog.mockResolvedValue(undefined)],
    ["fails", (b: MockBridge) => b.getDialog.mockResolvedValue({ success: false, error: "Unknown action: get_dialog" })],
  ])("when the check %s", async (_how, arrange) => {
    arrange(bridge);
    const r = await run();
    expect(r.isError).toBeUndefined();
    expect(imagesOf(r)).toHaveLength(5);
  });
});

// ── stopping at the first view it cannot capture (D1) ────────────────────────

describe("check_fit stops at the first view it cannot capture properly (D1)", () => {
  it("shows CC5's reason and the images taken before it, and sends CC5 nothing more", async () => {
    const question = 'CC5 is waiting for an answer to "X" - no MCP command is waiting on it, so it is probably the ' +
      "user's own or CC5's: ask the user to answer or close it in CC5, then try again.";
    onCall(bridge.frameCamera, 3, () => { throw new BridgeHttpError(question, 400); });
    const r = await run();
    expect(r.isError).toBe(true);
    const first = r.content[0].text as string;
    expect(first.startsWith("INCOMPLETE: the fit check of Kevin stopped at view 'right' (3/5)")).toBe(true);
    expect(first).toContain('Why: CC5 is waiting for an answer to "X"');
    // The stop, the header and the first view's label are one text block (F-95).
    expect(first).toBe(incompleteText("right", 3, true, question));
    expect(r.content).toHaveLength(5);
    expectNoTextAfterText(r);
    expect(r.content[2].text).toBe(`View 2/5: left (${fileFor(2, "left")})`);
    expect(imagesOf(r)).toHaveLength(2);
    expect(r.content.at(-1)).toEqual({ type: "text", text: FOOTER });
    expect(bridge.frameCamera).toHaveBeenCalledTimes(3);
    expect(bridge.captureViewport).toHaveBeenCalledTimes(2);
    expect(bridge.getDialog).toHaveBeenCalledTimes(1);
  });

  it("after a call cancelled behind a dialog (504), names that dialog", async () => {
    onCall(bridge.captureViewport, 2, () => { throw new BridgeHttpError(CANCELLED, 504); });
    bridge.getDialog
      .mockResolvedValueOnce({ success: true, dialog: null, waiting_job: null })
      .mockResolvedValueOnce({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_3" });
    const r = await run();
    expect(r.isError).toBe(true);
    const first = r.content[0].text as string;
    expect(first).toBe(incompleteText("left", 2, true, `${CANCELLED}\n${formatDialog(LAYER, "cmd_ab12cd34_3")}`));
    expect(first).toContain("Job cmd_ab12cd34_3 is waiting on this answer");
    expect(bridge.getDialog).toHaveBeenCalledTimes(2);
    expect(bridge.getDialog).toHaveBeenLastCalledWith(3000);
    expect(bridge.frameCamera).toHaveBeenCalledTimes(2);
    expect(imagesOf(r)).toHaveLength(1);
  });

  it.each([
    ["no dialog is open", (b: MockBridge) => b.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null })],
    ["the dialog check fails", (b: MockBridge) => b.getDialog
      .mockResolvedValueOnce({ success: true, dialog: null, waiting_job: null })
      .mockRejectedValueOnce(new BridgeTimeoutError("No reply from CC5 within 3s."))],
  ])("after a 504 when %s, gives CC5's text only", async (_how, arrange) => {
    arrange(bridge);
    onCall(bridge.captureViewport, 2, () => { throw new BridgeHttpError(CANCELLED, 504); });
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(incompleteText("left", 2, true, CANCELLED));
    expect(bridge.getDialog).toHaveBeenCalledTimes(2);
    expect(bridge.frameCamera).toHaveBeenCalledTimes(2);
  });

  it("after a capture that opened a question (409), keeps CC5's job_status text and stops", async () => {
    const waiting = 'CC5 is waiting for an answer to "Overwrite?". Buttons: Yes, No. The command is still running as ' +
      "job cmd_ab12cd34_9: answer it with answer_cc5_dialog (ask the user when it is a real choice), then check its " +
      'result with job_status("cmd_ab12cd34_9").';
    bridge.captureViewport.mockRejectedValueOnce(new BridgeHttpError(waiting, 409));
    const r = await run();
    expect(r.isError).toBe(true);
    // With no image, the stop, the header and the rubric are one text block (F-95).
    expect(r.content).toEqual([{ type: "text", text: incompleteText("face", 1, false, waiting) }]);
    expect(imagesOf(r)).toHaveLength(0);
    expect(bridge.frameCamera).toHaveBeenCalledTimes(1);
    expect(bridge.getDialog).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["frames another character", { success: true, view: "face", framed: "Camila" }, "CC5 framed 'Camila' instead of Kevin"],
    ["names no framed character", { success: true, view: "face" }, "CC5 framed no character instead of Kevin"],
    ["fails", { success: false, error: "x" }, "frame_camera failed: x"],
    ["fails without a reason", { success: false }, "frame_camera failed: no reason given"],
    ["answers nothing", undefined, "frame_camera failed: no reason given"],
  ])("when frame_camera %s", async (_how, answer, why) => {
    bridge.frameCamera.mockResolvedValueOnce(answer);
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(incompleteText("face", 1, false, why));
    expect(bridge.frameCamera).toHaveBeenCalledTimes(1);
    expect(bridge.captureViewport).not.toHaveBeenCalled();
  });

  it.each([
    ["fails", { success: false, error: "No camera in scene" }, "capture_viewport failed: No camera in scene"],
    ["fails without a reason", { success: false }, "capture_viewport failed: no reason given"],
    ["sends a path and a warning but no image",
      { success: true, path: "C:/t/1_face.png", warning: "Image too large to embed (35000000 bytes). Read from path directly." },
      "CC5 sent no image for this view (C:/t/1_face.png: Image too large to embed (35000000 bytes). Read from path directly.)"],
    ["sends a path but no image", { success: true, path: "C:/t/1_face.png" }, "CC5 sent no image for this view (C:/t/1_face.png)"],
    ["sends neither an image nor a path", { success: true }, "CC5 sent no image for this view"],
  ])("when the capture %s", async (_how, answer, why) => {
    bridge.captureViewport.mockResolvedValueOnce(answer);
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(incompleteText("face", 1, false, why));
    expect(imagesOf(r)).toHaveLength(0);
    expect(bridge.frameCamera).toHaveBeenCalledTimes(1);
    expect(bridge.captureViewport).toHaveBeenCalledTimes(1);
  });

  it("stops at a screenshot of CC5's window instead of a render, and never returns it", async () => {
    bridge.captureViewport.mockResolvedValueOnce({ success: true, path: fileFor(1, "face"),
      base64: png(1920, 1040).toString("base64") });
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("screenshot of CC5's window (1920x1040)");
    expect(r.content[0].text).toBe(incompleteText("face", 1, false, "the 'face' image is a screenshot of CC5's window " +
      "(1920x1040), not a render: RenderImage is not working (it stops after a .ccProject is loaded); restart CC5 or " +
      "check the fit by hand"));
    expect(imagesOf(r)).toHaveLength(0);
    expect(bridge.frameCamera).toHaveBeenCalledTimes(1);
  });

  it("stops at an image that is not a PNG", async () => {
    bridge.captureViewport.mockResolvedValueOnce({ success: true, path: fileFor(1, "face"),
      base64: Buffer.from("GIF89a, not a PNG render").toString("base64") });
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(incompleteText("face", 1, false,
      `the 'face' image is not a PNG render (${fileFor(1, "face")})`));
    expect(imagesOf(r)).toHaveLength(0);
    expect(bridge.frameCamera).toHaveBeenCalledTimes(1);
  });

  it("asks whether CC5 is running when it stops answering mid-check", async () => {
    onCall(bridge.frameCamera, 2, () => { throw new BridgeUnreachableError("fetch failed (ECONNREFUSED)"); });
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("INCOMPLETE: the fit check of Kevin stopped at view 'left' (2/5)");
    expect(r.content[0].text).toContain("Is CC5 running");
    expect(imagesOf(r)).toHaveLength(1);
    expect(bridge.getDialog).toHaveBeenCalledTimes(1);
  });

  it("stops before the next view once the client cancels", async () => {
    const ac = new AbortController();
    bridge.captureViewport.mockImplementationOnce(async (file?: string) => {
      ac.abort();
      return { success: true, path: file, base64: image(1) };
    });
    const r = await run({}, { signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(incompleteText("left", 2, true, "the check was cancelled"));
    expect(imagesOf(r)).toHaveLength(1);
    expect(bridge.frameCamera).toHaveBeenCalledTimes(1);
    expect(bridge.captureViewport).toHaveBeenCalledTimes(1);
  });
});

// ── other behaviour ───────────────────────────────────────────────────────────

describe("check_fit's other safeguards", () => {
  it("warns when a view is identical to the one before (the camera did not move), and goes on", async () => {
    const same = image(7);
    bridge.captureViewport
      .mockResolvedValueOnce({ success: true, path: fileFor(1, "face"), base64: same })
      .mockResolvedValueOnce({ success: true, path: fileFor(2, "left"), base64: same });
    const r = await run();
    expect(r.isError).toBeUndefined();
    expect(imagesOf(r)).toHaveLength(5);
    expect(lastLine(r.content[0])).toBe(`View 1/5: face (${fileFor(1, "face")})`);
    expect(r.content[2].text).toBe(`View 2/5: left (${fileFor(2, "left")}) WARNING: identical to the previous view: ` +
      "the camera did not move.");
    expect(r.content[4].text).toBe(`View 3/5: right (${fileFor(3, "right")})`);
  });

  // F-104 (live): a capture's undo took back a load CC5 had not finished; the plugin says so in a WARNING note
  // (cc5_api.CAPTURE_UNDO_REDONE).
  const UNDO_REDONE = "WARNING: CC5 had not finished the change before this capture (a load still running), so the " +
    "capture's own undo took that change back; it was put back with a redo (F-104). Check the scene.";

  it("shows a capture's WARNING note under that view's label, and goes on", async () => {
    const warning = UNDO_REDONE;
    bridge.captureViewport.mockResolvedValueOnce({ success: true, path: fileFor(1, "face"), base64: image(9),
      notes: [warning, "a note that is no warning"] });
    const r = await run();
    expect(r.isError).toBeUndefined();
    expect(imagesOf(r)).toHaveLength(5);
    expectNoTextAfterText(r);
    expect(r.content[0].text).toBe(`${HEADER}\nView 1/5: face (${fileFor(1, "face")})\n${warning}`);
    expect(r.content[1]).toEqual({ type: "image", data: image(9), mimeType: "image/png" });
    expect(r.content[2].text).toBe(`View 2/5: left (${fileFor(2, "left")})`);
    for (const text of textsOf(r)) expect(text).not.toContain("a note that is no warning");
  });

  it("keeps a capture's WARNING note when the check stops at that view", async () => {
    const warning = UNDO_REDONE;
    bridge.captureViewport.mockResolvedValueOnce({ success: true, path: fileFor(1, "face"),
      base64: png(1920, 1040).toString("base64"), notes: [warning] });
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(incompleteText("face", 1, false, "the 'face' image is a screenshot of CC5's window " +
      "(1920x1040), not a render: RenderImage is not working (it stops after a .ccProject is loaded); restart CC5 or " +
      `check the fit by hand\n${warning}`));
    bridge.captureViewport.mockResolvedValueOnce({ success: false, error: "No camera in scene", notes: [warning] });
    expect((await run()).content[0].text).toBe(incompleteText("face", 1, false,
      `capture_viewport failed: No camera in scene\n${warning}`));
  });

  it("reports each view as progress when the client asks for it", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await run({}, { _meta: { progressToken: "t" }, sendNotification });
    const sent = sendNotification.mock.calls.map(([n]) => n);
    expect(sent.every((n) => n.method === "notifications/progress" && n.params.progressToken === "t")).toBe(true);
    expect(sent.map((n) => n.params.message)).toEqual(
      ["view 1/5: face", "view 2/5: left", "view 3/5: right", "view 4/5: back", "view 5/5: front"]);
  });
});

describe("check_fit always frees the scene", () => {
  it("after a full check", async () => {
    expect((await run()).isError).toBeUndefined();
    expectSceneFree();
  });

  it("after an INCOMPLETE", async () => {
    bridge.frameCamera.mockResolvedValue({ success: false, error: "No camera in scene" });
    expect((await run()).isError).toBe(true);
    expectSceneFree();
  });

  it("after a refusal", async () => {
    bridge.getAvatars.mockResolvedValue([]);
    expect((await run()).isError).toBe(true);
    expectSceneFree();
  });

  it("after an unexpected error", async () => {
    const sendNotification = vi.fn(() => { throw new Error("transport closed"); });
    await expect(run({}, { _meta: { progressToken: "t" }, sendNotification })).rejects.toThrow("transport closed");
    expect(bridge.frameCamera).not.toHaveBeenCalled();
    expectSceneFree();
  });

  it("and holds it while it runs, so a recipe or batch cannot change the character mid-check", async () => {
    let resume!: () => void;
    bridge.getAvatars.mockImplementationOnce(() => new Promise((resolve) => { resume = () => resolve([KEVIN]); }));
    const running = run();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(bridge.getAvatars).toHaveBeenCalledTimes(1);
      const recipe = claimScene("apply_character_recipe");
      if (typeof recipe === "function") recipe();
      expect(recipe).toBe("check_fit is still running in CC5. Wait for it to finish before starting another batch or " +
        "recipe: two at once would edit the same scene.");
    } finally {
      resume?.();
    }
    expect((await running).isError).toBeUndefined();
    expectSceneFree();
  });
});

describe("check_fit keeps only the newest check folders", () => {
  const stamps = Array.from({ length: 21 }, (_, k) => `check_${1600000000000 + k}`);
  const base = () => path.join(tmp, "cc5_fit");

  beforeEach(() => {
    for (const name of [...stamps, "check_123", "notes"]) fs.mkdirSync(path.join(base(), name), { recursive: true });
  });

  it("removes all but the newest 19 before a check adds its own, and nothing else", async () => {
    const r = await run();
    expect(r.isError).toBeUndefined();
    expect(fs.readdirSync(base()).sort()).toEqual([...stamps.slice(2), "check_123", `check_${STAMP}`, "notes"].sort());
    expect(bridge.captureViewport.mock.calls.map((c) => path.dirname(c[0] as string))).toEqual(Array(5).fill(checkFolder()));
  });

  it("goes on when an old folder cannot be removed", async () => {
    const rm = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("EBUSY: resource busy or locked"); });
    const r = await run();
    expect(rm).toHaveBeenCalledTimes(2);
    expect(r.isError).toBeUndefined();
    expect(imagesOf(r)).toHaveLength(5);
    expect(fs.readdirSync(base())).toHaveLength(24);
  });

  it("goes on when it cannot create the check folder: the plugin creates it too", async () => {
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("EPERM: operation not permitted"); });
    const r = await run();
    expect(mkdir).toHaveBeenCalledWith(checkFolder(), { recursive: true });
    expect(r.isError).toBeUndefined();
    expect(imagesOf(r)).toHaveLength(5);
    expect(bridge.captureViewport).toHaveBeenCalledWith(fileFor(1, "face"), 1280, 720);
  });
});

describe("claimScene names what it refuses", () => {
  it("another batch or recipe by default, and a fit check when check_fit asks", () => {
    const release = claimScene("a");
    if (typeof release !== "function") throw new Error("the scene was not free");
    try {
      expect(claimScene("b")).toBe("a is still running in CC5. Wait for it to finish before starting another batch or " +
        "recipe: two at once would edit the same scene.");
      expect(claimScene("b", "a fit check")).toBe("a is still running in CC5. Wait for it to finish before starting " +
        "a fit check: two at once would edit the same scene.");
    } finally {
      release();
    }
    expectSceneFree();
  });
});

// ── through the MCP SDK ───────────────────────────────────────────────────────

describe("check_fit over the MCP SDK", () => {
  let client: Client;

  beforeEach(async () => {
    const sdkServer = new McpServer({ name: "cc5-test", version: "0.0.0" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerFitTools(sdkServer, bridge as any);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([sdkServer.connect(serverSide), client.connect(clientSide)]);
  });

  afterEach(async () => {
    await client.close();
  });

  it("lists check_fit with its description", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "check_fit")?.description).toBe(FIT_DESCRIPTION);
  });

  it("returns every view's label and image to the client", async () => {
    const r = await client.callTool({ name: "check_fit", arguments: { views: ["face", "front"] } });
    expect(r.isError).toBeFalsy();
    const content = r.content as Entry[];
    // No text block right after another (F-95): the header and the first view's label are one.
    expect(content.map((e) => e.type)).toEqual(["text", "image", "text", "image", "text"]);
    expect(lastLine(content[0])).toBe(`View 1/2: face (${fileFor(1, "face")})`);
    expect(content[1]).toMatchObject({ type: "image", data: image(1), mimeType: "image/png" });
    expect(content[2]).toMatchObject({ type: "text", text: `View 2/2: front (${fileFor(2, "front")})` });
    expect(bridge.frameCamera.mock.calls).toEqual([["face", "Kevin"], ["home", "Kevin"]]);
  });

  it("refuses a view that was not verified live, before asking CC5 anything", async () => {
    const r = await client.callTool({ name: "check_fit", arguments: { views: ["all"] } });
    expect(r.isError).toBe(true);
    expect(bridge.getDialog).not.toHaveBeenCalled();
    expect(bridge.frameCamera).not.toHaveBeenCalled();
  });
});
