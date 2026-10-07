import fs from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerBuilderTools, searchContent, BROWSE_FOLDERS, NothingSearchedError, SEARCH_FOLDERS,
} from "../../src/tools/builder.js";
import { createMockBridge, mockJobs } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";
import { HEADSHOT_DISABLED } from "../../src/recipe.js";
import { BridgeHttpError, BridgeTimeoutError, BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { finishBuild, startBuild, LAYER_EXPECT } from "../../src/build-session.js";
import { claimScene } from "../../src/scene-lock.js";
import { formatDialog } from "../../src/tools/dialog.js";
import { LITE_HAIR_LABEL } from "../../src/tools/content.js";
import {
  CANCEL_NOT_CARRIED, LAYER_STOP_ADVICE, NOT_A_CHECK, PICK_RULE, STORE_HINT, STORE_RULE,
} from "../../src/prompts/content-rules.js";

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerBuilderTools(server as any, bridge as any);
  finishBuild(startBuild("recipe"));  // no stop left over from another test
});

describe("searchContent", () => {
  it("matches every word in the file name across folders", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(
      f === "cloth_upper" ? ["C:/c/Military Jacket Camo.iClothes", "C:/c/Hoodie.iClothes"] : ["C:/s/Combat Boots.ccShoes"]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits = await searchContent(bridge as any, "camo jacket", ["cloth_upper", "shoes"]);
    expect(hits).toEqual([{ folder: "cloth_upper", path: "C:/c/Military Jacket Camo.iClothes" }]);
  });

  it("skips folders that error", async () => {
    bridge.browseContent.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce(["C:/s/Combat Boots.ccShoes"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits = await searchContent(bridge as any, "boots", ["cloth_upper", "shoes"]);
    expect(hits).toHaveLength(1);
  });

  // TS-1: an error string inside the list was skipped silently, and the reply said nothing installed matched.
  it("counts an error string browse_content returns inside its list as that folder's failure, never as a file", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(
      f === "shoes" ? ["C:/s/Combat Boots.ccShoes"] : ["Unknown folder type: texture. Available: cloth, shoes, pose"]));
    const skipped: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await searchContent(bridge as any, "pose", ["shoes", "texture"], skipped)).toEqual([]);
    expect(skipped).toEqual(["texture: Unknown folder type: texture. Available: cloth, shoes, pose"]);
  });

  it("throws NothingSearchedError naming every folder when CC5 could list none of them", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(
      f === "motion" ? ["Unknown folder type: motion. Available: cloth_upper, shoes"] : [`No content folder resolved for '${f}'`]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const search = searchContent(bridge as any, "walk", ["motion", "props"]);
    await expect(search).rejects.toBeInstanceOf(NothingSearchedError);
    await expect(search).rejects.toThrow("Nothing was searched: no folder could be listed (motion: Unknown folder type: " +
      "motion. Available: cloth_upper, shoes; props: No content folder resolved for 'props')");
  });

  it("knows every error answer browse_content gives inside its list", async () => {
    const answers = ["Unknown folder type: x. Available: shoes", "No content folder resolved for 'x'",
      "Content browsing not available for 'x' in this CC5 version", "Error browsing content: boom"];
    for (const answer of answers) {
      bridge.browseContent.mockResolvedValue([answer]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(searchContent(bridge as any, "x", ["shoes"])).rejects.toBeInstanceOf(NothingSearchedError);
    }
    // The plugin's own texts (cc5_api.browse_content) start with these words.
    const py = fs.readFileSync(new URL("../../cc5-plugin/cc5_api.py", import.meta.url), "utf-8");
    for (const start of ['return [f"Unknown folder type: ', 'return [f"Content browsing not available',
      'return [f"No content folder resolved', 'return [f"Error browsing content: ']) {
      expect(py).toContain(start);
    }
  });

  it("throws when every folder fails (e.g. CC5 is down)", async () => {
    bridge.browseContent.mockRejectedValue(new Error("ECONNREFUSED"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(searchContent(bridge as any, "boots", ["cloth_upper", "shoes"])).rejects.toThrow();
  });

  it("asks CC5 to filter by the query, so items past its 200-file cap can be found", async () => {
    bridge.browseContent.mockResolvedValue(["C:/c/Camo Jacket.ccCloth"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits = await searchContent(bridge as any, "camo jacket", ["cloth_upper"]);
    expect(bridge.browseContent).toHaveBeenCalledWith("cloth_upper", "camo jacket");
    expect(hits).toEqual([{ folder: "cloth_upper", path: "C:/c/Camo Jacket.ccCloth" }]);
  });

  it("reports folders CC5 cut off at its cap instead of treating the marker as a file", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `C:/c/Camo Shirt ${i}.ccCloth`);
    bridge.browseContent.mockResolvedValue([...many, "(truncated: more than 200 files matched; only the first 200 are listed)"]);
    const truncated: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hits = await searchContent(bridge as any, "camo", ["cloth_upper"], [], truncated);
    expect(hits).toHaveLength(200);
    expect(truncated).toEqual(["cloth_upper"]);
  });
});

describe("search_content", () => {
  it("returns a bridge error when every folder fails", async () => {
    bridge.browseContent.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await server.getRegisteredTool("search_content")({ query: "boots", folder_types: ["cloth_upper", "shoes"], limit: 40 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("CC5 bridge error");
  });

  it("notes skipped folders when only some fail", async () => {
    bridge.browseContent.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(["C:/s/Combat Boots.ccShoes"]);
    const r = await server.getRegisteredTool("search_content")({ query: "boots", folder_types: ["cloth_upper", "shoes"], limit: 40 });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain("Combat Boots");
    expect(r.content[0].text).toContain("skipped folders");
  });

  it("stops at the first folder when CC5 cannot be reached, and asks whether CC5 runs (C2 review)", async () => {
    bridge.browseContent.mockRejectedValue(new BridgeUnreachableError("fetch failed (connect ECONNREFUSED 127.0.0.1:5101)"));
    const r = await server.getRegisteredTool("search_content")({ query: "boots", folder_types: ["cloth_upper", "shoes"], limit: 40 });
    expect(bridge.browseContent).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("CC5 bridge error: fetch failed (connect ECONNREFUSED 127.0.0.1:5101). " +
      "Is CC5 running with the MCP Bridge plugin?");
  });

  it("stops at the first folder behind an open dialog and shows CC5's text as it is (C2 review)", async () => {
    // The open-dialog guard fails every command after 5 s: 22 folders would take almost two minutes.
    const guard = 'CC5 is waiting for an answer to "Replace?" - no MCP command is waiting on it, so it is probably the ' +
      "user's own or CC5's: ask the user to answer or close it in CC5, then try again.";
    bridge.browseContent.mockRejectedValue(new BridgeHttpError(guard, 400));
    const r = await server.getRegisteredTool("search_content")({ query: "boots", folder_types: ["cloth_upper", "shoes"], limit: 40 });
    expect(bridge.browseContent).toHaveBeenCalledTimes(1);
    expect(r.content[0].text).toBe(guard);
  });

  it.each([
    new BridgeHttpError("CC5 timed out (cancelled): Timed out before CC5 started the command; it was cancelled and will not run.", 504),
    new BridgeHttpError('CC5 is waiting for an answer to "Replace?". Buttons: Replace, Cancel.', 409),
    new BridgeTimeoutError("No reply from CC5 within 35s. CC5 may still be running this command; check the scene " +
      "(list_avatars / capture_viewport) before retrying."),
  ])("stops at the first folder on '%s' and shows that text (C2 review: 22 folders x 30 s)", async (err) => {
    bridge.browseContent.mockRejectedValue(err);
    const r = await server.getRegisteredTool("search_content")({ query: "boots", folder_types: ["cloth_upper", "shoes"], limit: 40 });
    expect(bridge.browseContent).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(err.message);
  });

  it("keeps searching past a folder that fails on its own (e.g. a 500)", async () => {
    bridge.browseContent.mockRejectedValueOnce(new BridgeHttpError("boom", 500)).mockResolvedValueOnce(["C:/s/Combat Boots.ccShoes"]);
    const r = await server.getRegisteredTool("search_content")({ query: "boots", folder_types: ["cloth_upper", "shoes"], limit: 40 });
    expect(bridge.browseContent).toHaveBeenCalledTimes(2);
    expect(r.content[0].text).toContain("Combat Boots");
    expect(r.content[0].text).toContain("(skipped folders that failed: cloth_upper: boom)");
  });

  it("says the search was incomplete when CC5 cut a folder off at its cap", async () => {
    bridge.browseContent.mockResolvedValue(["C:/c/Camo Shirt 1.ccCloth", "(truncated: more than 200 files matched; only the first 200 are listed)"]);
    const r = await server.getRegisteredTool("search_content")({ query: "camo", folder_types: ["cloth_upper"], limit: 40 });
    expect(r.content[0].text).toContain("1 match(es)");
    expect(r.content[0].text).toContain("search incomplete in cloth_upper");
    expect(r.content[0].text).not.toContain("(truncated");
  });

  it("says it searches the user's Custom content, and gives the pick-list and store rules (F-72, I-02, I-03)", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "search_content")?.[1] as string;
    expect(description).toContain("the user's own content from CC5's Custom tab, 'Reallusion Custom'");
    expect(description).toContain(PICK_RULE);
    expect(description).toContain(STORE_RULE);
  });

  it("answers a search without a hit as a result, not an error, and points to the store (I-02)", async () => {
    bridge.browseContent.mockResolvedValue([]);
    const r = await server.getRegisteredTool("search_content")({ query: "xyzzy", folder_types: ["cloth_upper"], limit: 40 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("No content matched 'xyzzy' in the installed content (CC5's templates and the user's " +
      `Custom content). Try other words or browse_content. ${STORE_HINT}`);
  });

  // TS-1: every folder answered with an error inside its list, and the reply said nothing installed matched, plus the store.
  it("says nothing was searched when CC5 could list none of the folders, keeping its 'Available' list and no store hint", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(
      f === "motion" ? ["Unknown folder type: motion. Available: cloth_upper, shoes, pose"] : [`No content folder resolved for '${f}'`]));
    const r = await server.getRegisteredTool("search_content")({ query: "walk", folder_types: ["motion", "props"], limit: 40 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Nothing was searched: no folder could be listed (motion: Unknown folder type: motion. " +
      "Available: cloth_upper, shoes, pose; props: No content folder resolved for 'props')");
    expect(r.content[0].text).not.toContain(STORE_HINT);
    expect(r.content[0].text).not.toContain("CC5 bridge error");
  });

  it("names the folders CC5 could not list when it searched the others", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(
      f === "texture" ? ["No content folder resolved for 'texture'"] : []));
    const r = await server.getRegisteredTool("search_content")({ query: "camo", folder_types: ["cloth_upper", "texture"], limit: 40 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("No content matched 'camo' in the installed content (CC5's templates and the user's " +
      `Custom content). Try other words or browse_content. ${STORE_HINT}\n(skipped folders that failed: texture: No ` +
      "content folder resolved for 'texture')");
  });

  it("takes at least one category, any category browse_content takes (cc5_api.browse_content)", () => {
    const shape = server.tool.mock.calls.find((c) => c[0] === "search_content")?.[2] as
      Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(shape.folder_types.safeParse(undefined).success).toBe(true);
    expect(shape.folder_types.safeParse([]).success).toBe(false);
    expect(shape.folder_types.safeParse(["clothing"]).success).toBe(false);
    expect(shape.folder_types.safeParse(["motion", "props", "light", "camera", "wrinkle_mask"]).success).toBe(true);
    expect(shape.folder_types.safeParse(SEARCH_FOLDERS).success).toBe(true);
    const py = fs.readFileSync(new URL("../../cc5-plugin/cc5_api.py", import.meta.url), "utf-8");
    const block = /enum_candidates: dict\[str, Any\] = \{([\s\S]*?)\n {4}\}/.exec(py)?.[1] ?? "";
    const plugin = [...block.matchAll(/^\s+"([a-z_]+)":/gm)].map((m) => m[1]).sort();
    expect(plugin.length).toBeGreaterThan(20);
    expect([...BROWSE_FOLDERS].sort()).toEqual(plugin);
  });
});

// I-07 (Chad, 2026-10-07): the Lite Hair sets are low-poly versions made for mobile games, "used only as a failsafe".
describe("search_content's Lite Hair hairstyles (I-07)", () => {
  const LITE = "C:/Reallusion/Templates/Hair/Group/Lite Hair Female Vol. 1/Pixie Bob.rlHair";
  const LITE_MALE = "C:/Reallusion/Templates/Hair/Group/Lite Hair Male Vol. 2/Short Bob.rlHair";
  const BOB = "C:/Reallusion/Templates/Hair/Group/Prime Hairstyles/06_Ear length Bob.rlHair";
  const SKIRT = "C:/c/Bob Skirt.ccCloth";
  const search = (folder_types: string[], limit: number) =>
    server.getRegisteredTool("search_content")({ query: "bob", folder_types, limit });

  it("labels Lite Hair hairstyles and lists them after the others; other categories' hits keep their places", async () => {
    bridge.browseContent.mockImplementation((f: string) => Promise.resolve(f === "hair" ? [LITE, BOB, LITE_MALE] : [SKIRT]));
    const r = await search(["cloth_lower", "hair"], 40);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe([
      "4 match(es):",
      `[cloth_lower] ${SKIRT}`,
      `[hair] ${BOB}`,
      `[hair] ${LITE}${LITE_HAIR_LABEL}`,
      `[hair] ${LITE_MALE}${LITE_HAIR_LABEL}`,
    ].join("\n"));
  });

  it("shows the full-quality hairstyles first when the limit cuts the list", async () => {
    const lite = Array.from({ length: 3 }, (_, i) => `C:/T/Hair/Group/Lite Hair Male Vol. 1/Bob ${i}.rlHair`);
    const full = Array.from({ length: 2 }, (_, i) => `C:/T/Hair/Group/Prime Hairstyles/Bob ${i}.rlHair`);
    bridge.browseContent.mockResolvedValue([...lite, ...full]);
    const r = await search(["hair"], 3);
    expect(r.content[0].text).toBe(["5 match(es):", `[hair] ${full[0]}`, `[hair] ${full[1]}`,
      `[hair] ${lite[0]}${LITE_HAIR_LABEL}`].join("\n"));
  });
});

// Chad's ruling (2026-10-03): live, Headshot crashed CC5 5.13, so the tool is switched off and never calls CC5.
describe("headshot_from_photo", () => {
  it("is switched off: fails at once with the do-it-in-CC5 message and sends CC5 nothing", async () => {
    for (const photo_path of ["C:/a/face.jpg", "C:/a/b.gif"]) {
      const r = await server.getRegisteredTool("headshot_from_photo")({ photo_path });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(HEADSHOT_DISABLED);
    }
    expect(HEADSHOT_DISABLED).toContain("use the Headshot plugin inside Character Creator 5");
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("says in its description that it is switched off and what to do instead", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "headshot_from_photo")?.[1] as string;
    expect(description).toContain("Switched off");
    expect(description).toContain("Headshot plugin inside Character Creator 5");
  });
});

describe("builder tool descriptions", () => {
  it("each stays under 2,000 characters", () => {
    expect(server.tool.mock.calls.length).toBeGreaterThan(0);
    for (const call of server.tool.mock.calls) expect((call[1] as string).length).toBeLessThan(2000);
  });
});

describe("apply_character_recipe", () => {
  it("does not offer a headshot photo", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "apply_character_recipe")?.[1] as string;
    expect(description.toLowerCase()).not.toContain("headshot");
  });

  it("flags partial failure as an error", async () => {
    mockJobs(bridge, { load_asset: { success: false, error: "File not found" } });
    const r = await server.getRegisteredTool("apply_character_recipe")({ recipe: { assets: ["C:/x/a.iClothes"] } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("FAIL asset a.iClothes: File not found");
  });

  it("stops at the next step when the client cancels, and says so", async () => {
    const started = mockJobs(bridge);
    const ac = new AbortController();
    bridge.setSkinCondition.mockImplementation(async () => { ac.abort(); return { success: true }; });
    const r = await server.getRegisteredTool("apply_character_recipe")(
      { recipe: { skin_condition: { condition: "pale", amount: 1 }, pose_file: "C:/p/Supine.rlMotion" } },
      { signal: ac.signal });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Cancelled: the remaining steps were not started\./);
    expect(started).toEqual([]);
  });

  it("sends a progress notification per step when the client asks for progress", async () => {
    mockJobs(bridge);
    bridge.setSkinCondition.mockResolvedValue({ success: true });
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    await server.getRegisteredTool("apply_character_recipe")(
      { recipe: { skin_condition: { condition: "pale", amount: 1 }, pose_file: "C:/p/Supine.rlMotion" } },
      { signal: new AbortController().signal, _meta: { progressToken: 7 }, sendNotification });
    expect(sendNotification.mock.calls.map(([n]) => [n.params.progress, n.params.message]))
      .toEqual([[1, "OK skin_condition"], [2, "OK pose_file"]]);
  });
});

// ── D1 / D3: a recipe that meets a CC5 question stops, and continue_after goes on after the answer ──────────────

const OK = { success: true };
const EYES_01 = "C:/Templates/Eye/Eyes_01.ccEye";
const EYES_02 = "C:/Templates/Eye/Eyes_02.ccEye";
const EYES_03 = "C:/Templates/Eye/Eyes_03.ccEye";
const SHIRT = "C:/c/Shirt.ccCloth";
const RGB: [number, number, number] = [0.8, 0.6, 0.5];
const LAYER = {
  title: "Character Creator 5",
  text: "The target object layer already exists.\nDo you want to replace the object, or the material only?",
  buttons: ["Replace", "Material Only", "Cancel"],
};
const APPLY = { title: "", text: "Apply the preset?", buttons: ["OK", "Cancel"] };
const PROGRESS = { title: "Exporting", text: "Exporting FBX...", buttons: ["Cancel"], progress: true };
const GUARD = 'CC5 is waiting for an answer to "Replace?" - no MCP command is waiting on it, so it is probably the ' +
  "user's own or CC5's: ask the user to answer or close it in CC5, then try again.";
const LAYER_QUESTION = "The target object layer already exists. Do you want to replace the object, or the material only?";
const LAYER_BUTTONS = "Replace, Material Only, Cancel";
/** server.py _waiting_dialog_error for the job `id` (a 409's text and a waiting job's dialog_message). */
const waiting = (id: string, question = LAYER_QUESTION, buttons = LAYER_BUTTONS) =>
  `CC5 is waiting for an answer to "${question}" (the "Character Creator 5" window). Buttons: ${buttons}. The command is ` +
  `still running as job ${id}: answer it with answer_cc5_dialog (ask the user when it is a real choice), then check ` +
  `its result with job_status("${id}").`;
/** The same text in a report's WAIT line (batch F review #29): continue_after, not job_status, reads the job's result. */
const waitingLine = (id: string, question = LAYER_QUESTION, buttons = LAYER_BUTTONS) =>
  `CC5 is waiting for an answer to "${question}" (the "Character Creator 5" window). Buttons: ${buttons}. The command is ` +
  `still running as job ${id}: answer it with answer_cc5_dialog (ask the user when it is a real choice), then ` +
  "continue_after reads its result.";

// Batch F review #29: what the plugin sends for a command waiting in SkinGen's About box (F-94: a window with no
// buttons) and in CC5's Export FBX dialog (F-99: buttons this bridge cannot read): server.py _dialog_view and
// _waiting_dialog_error, as tests/py/test_dialogs.py pins them. ABOUT_TEXT is the box's labels, the serial redacted.
const ABOUT_TEXT = "S/N : (serial)\nProduct Version : 1.0.0824.1\nwww.reallusion.com";
const ABOUT = { title: "CCSkinGen", text: ABOUT_TEXT, buttons: [], text_read: true };
const FBX = { title: "Export FBX", text: "", buttons: [], text_read: true, buttons_unreadable: true };
const ABOUT_NAMED = 'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool ' +
  "can close it)";
const FBX_NAMED = 'CC5 has a window open whose buttons this bridge cannot read: "Export FBX" - answer or close it in ' +
  "Character Creator 5 (no MCP tool can click its buttons)";
/** Batch F's text for job `id` waiting in a window no MCP tool can click (`named`: how the window is named). */
const closeWaiting = (named: string, id: string) =>
  `${named}. The command is still running as job ${id}: read its result with job_status("${id}") once it is closed.`;
/**
 * The About box from a plugin before batch F (batch E): its view had no text_read, and its text said to answer every
 * window with answer_cc5_dialog, which jobs.ts jobDialogMessage rewords as get_cc5_dialog words the window.
 */
const ABOUT_E = { title: "CCSkinGen", text: ABOUT_TEXT, buttons: [] };
const aboutWaitingE = (id: string) => 'CC5 is waiting for an answer to "S/N : (serial) Product Version : 1.0.0824.1 ' +
  `www.reallusion.com" (the "CCSkinGen" window). Buttons: none found. The command is still running as job ${id}: ` +
  "answer it with answer_cc5_dialog (ask the user when it is a real choice), then check its result with " +
  `job_status("${id}").`;

/** A job's status as the test scripts it; answers: the buttons clicked while it waited in a CC5 dialog (F-98). */
type Script = {
  status: "queued" | "running" | "done" | "failed"; result?: unknown; dialog?: unknown; dialog_message?: string;
  answers?: unknown[];
};
const CANCEL = [{ button: "Cancel", title: "Character Creator 5" }];

const asking = (id: string): Script => ({ status: "running", dialog: LAYER, dialog_message: waiting(id) });
/** A finished character-content load: worn items it added, nothing else changed. */
const loaded = (file: string, added: string[] = []): Script => ({ status: "done", result: { success: true, path: file,
  target: "Kevin", changes: { complete: true, target: "Kevin", target_is_first: true, elapsed_ms: 200,
    compared: { worn: 2, morphs: 10, materials: 30 }, skipped: 0, truncated: false,
    facts: added.map((name, i) => ({ kind: "worn_added", group: "clothing", id: String(20 + i), name })) } } });

/** Jobs that report what the test scripts: `next` says how a new job starts, `set` changes what a job reports later. */
function jobStore(next: (action: string, params: Record<string, unknown>, id: string) => Script) {
  const jobs = new Map<string, { action: string; script: Script }>();
  const started: Array<{ id: string; action: string; params: Record<string, unknown> }> = [];
  bridge.startJob.mockImplementation(async (action: string, params: Record<string, unknown>) => {
    const id = `cmd_ab12cd34_${started.length + 1}`;
    started.push({ id, action, params });
    jobs.set(id, { action, script: next(action, params, id) });
    return { job_id: id };
  });
  bridge.getJob.mockImplementation(async (id: string) => {
    const job = jobs.get(id);
    if (!job) throw new BridgeHttpError(`Unknown job: ${id}`, 404);
    return { job_id: id, action: job.action, ...job.script };
  });
  return {
    started,
    set(id: string, script: Script) {
      const job = jobs.get(id);
      if (job) job.script = script;
    },
  };
}

/** Eye presets ask CC5's Replace / Material Only question; any other load finishes and adds its garment. */
const eyesAsk = () => jobStore((_action, params, id) => {
  const file = String(params.file_path);
  return file.endsWith(".ccEye") ? asking(id) : loaded(file, ["Shirt"]);
});

const recipeTool = () => server.getRegisteredTool("apply_character_recipe");

describe("apply_character_recipe stops on a CC5 question nobody has answered (D1)", () => {
  it("shows the question and the continue_after call, and sends nothing after it", async () => {
    const store = eyesAsk();
    bridge.setSkinColor.mockResolvedValue(OK);
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const r = await recipeTool()({ recipe: { assets: [EYES_01, SHIRT], skin_rgb: RGB } },
      { signal: new AbortController().signal, _meta: { progressToken: 1 }, sendNotification });
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text.split("\n")[0]).toBe("Stopped at asset Eyes_01.ccEye: CC5 is waiting for an answer nobody has given yet, " +
      "so nothing after it was sent to CC5.");
    expect(text).toContain(`WAIT asset Eyes_01.ccEye: ${waitingLine("cmd_ab12cd34_1")}`);
    expect(text).not.toContain("job_status(");  // review #29: continue_after reads the job's result
    expect(text).toContain("Still to run after the answer: skin_rgb, asset Shirt.ccCloth.");
    expect(text).toContain('To go on after the answer: apply_character_recipe with continue_after "cmd_ab12cd34_1" and ' +
      'this recipe: {"skin_rgb":[0.8,0.6,0.5],"assets":["C:/c/Shirt.ccCloth"]}');
    expect(text).toContain(LAYER_STOP_ADVICE);
    expect(store.started.map((j) => j.params.file_path)).toEqual([EYES_01]);
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(sendNotification.mock.calls.map(([n]) => n.params.message)).toEqual(["WAIT asset Eyes_01.ccEye"]);
  });

  it("goes on after the answer and reports the whole recipe in order", async () => {
    const store = eyesAsk();
    bridge.setMultipleMorphs.mockResolvedValue(OK);
    bridge.setSkinColor.mockResolvedValue(OK);
    const first = await recipeTool()({ recipe: { morphs: [{ morph_id: "m1", value: 0.5 }], assets: [EYES_01, SHIRT], skin_rgb: RGB } });
    expect(first.content[0].text).toMatch(/^Stopped at asset Eyes_01\.ccEye/);
    store.set("cmd_ab12cd34_1", loaded(EYES_01));  // the user answered in CC5: the eye load finished

    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n").slice(0, 6)).toEqual([
      'Continued after the answer (continue_after "cmd_ab12cd34_1"): this report covers the whole recipe.',
      "All 4 steps succeeded.",
      "OK   morphs",
      "OK   asset Eyes_01.ccEye (after the answer)",
      "OK   skin_rgb",
      "OK   asset Shirt.ccCloth",
    ]);
    expect(bridge.setMultipleMorphs).toHaveBeenCalledTimes(1);
    expect(store.started.map((j) => j.params.file_path)).toEqual([EYES_01, SHIRT]);

    const again = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain("is not where the last recipe stopped");
  });

  it("refuses a continuation while CC5 still asks, and keeps the stop for later", async () => {
    const store = eyesAsk();
    bridge.setSkinColor.mockResolvedValue(OK);
    await recipeTool()({ recipe: { assets: [EYES_01], skin_rgb: RGB } });
    bridge.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_1" });
    const still = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(still.isError).toBe(true);
    expect(still.content[0].text).toBe(`${waiting("cmd_ab12cd34_1")}\nAnswer it first, then call apply_character_recipe ` +
      'with continue_after "cmd_ab12cd34_1" again. Nothing else was sent to CC5.');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();

    store.set("cmd_ab12cd34_1", loaded(EYES_01));
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    const done = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(done.isError).toBeUndefined();
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(1);
  });

  it("refuses a continuation while another window is open, with the progress wording for a progress window", async () => {
    const store = eyesAsk();
    bridge.setSkinColor.mockResolvedValue(OK);
    await recipeTool()({ recipe: { assets: [EYES_01], skin_rgb: RGB } });
    const polls = bridge.getJob.mock.calls.length;
    bridge.getDialog.mockResolvedValue({ success: true, dialog: APPLY, waiting_job: null });
    const other = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(other.content[0].text).toBe(`${formatDialog(APPLY, null)}\nNothing was sent to CC5: answer or close it first, ` +
      'then call apply_character_recipe with continue_after "cmd_ab12cd34_1" again.');
    bridge.getDialog.mockResolvedValue({ success: true, dialog: PROGRESS, waiting_job: "cmd_ab12cd34_9" });
    const busy = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(busy.content[0].text).toBe(`${formatDialog(PROGRESS, "cmd_ab12cd34_9")}\nNothing was sent to CC5: call ` +
      'apply_character_recipe with continue_after "cmd_ab12cd34_1" again when CC5 has finished; the progress window closes by itself.');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    expect(bridge.getJob).toHaveBeenCalledTimes(polls);  // the refused calls did not wait for the job either

    store.set("cmd_ab12cd34_1", loaded(EYES_01));
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    expect((await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" })).isError).toBeUndefined();
  });

  it("refuses a continuation with the original recipe before any CC5 call, and takes the remaining one", async () => {
    const store = jobStore((action, params, id) => action === "create_default_avatar"
      ? { status: "done", result: { success: true, name: "Default Character" } }
      : String(params.file_path).endsWith(".ccEye") ? asking(id) : loaded(String(params.file_path)));
    bridge.getAvatars.mockResolvedValue([{ name: "Kevin", id: "1", type: "avatar" }]);
    bridge.deleteAvatar.mockResolvedValue(OK);
    bridge.setSkinColor.mockResolvedValue(OK);
    const recipe = { base: "default", assets: [EYES_01], skin_rgb: RGB };
    const first = await recipeTool()({ recipe });
    expect(first.content[0].text).toContain('continue_after "cmd_ab12cd34_2"');
    const calls = () => [bridge.getDialog, bridge.getAvatars, bridge.deleteAvatar, bridge.getJob, bridge.startJob]
      .map((f) => f.mock.calls.length);
    const before = calls();

    const full = await recipeTool()({ recipe, continue_after: "cmd_ab12cd34_2" });
    expect(full.isError).toBe(true);
    expect(full.content[0].text).toBe('continue_after cmd_ab12cd34_2 goes on with the remaining recipe its report gave. ' +
      'Pass that recipe (or an empty one): {"skin_rgb":[0.8,0.6,0.5]}. Nothing was sent to CC5.');
    expect(calls()).toEqual(before);

    store.set("cmd_ab12cd34_2", loaded(EYES_01));
    const r = await recipeTool()({ recipe: { skin_rgb: RGB }, continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("All 3 steps succeeded.");
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(1);  // the base did not run again
  });

  it("runs a step again after the window that kept it from running is closed", async () => {
    const started = mockJobs(bridge);
    bridge.setSkinColor.mockRejectedValueOnce(new BridgeHttpError(GUARD, 400)).mockResolvedValue(OK);
    const first = await recipeTool()({ recipe: { skin_rgb: RGB, pose_file: "C:/p/Supine.rlMotion" } });
    expect(first.content[0].text).toMatch(/^Stopped at skin_rgb: it could not run while CC5 had a window open/);
    expect(started).toEqual([]);
    const id = /continue_after "(stop_\d+)"/.exec(first.content[0].text)?.[1] ?? "";
    expect(id).toMatch(/^stop_\d+$/);

    const r = await recipeTool()({ recipe: {}, continue_after: id });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n")).toEqual([
      `Continued after the answer (continue_after "${id}"): this report covers the whole recipe.`,
      "All 2 steps succeeded.", "OK   skin_rgb", "OK   pose_file"]);
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(2);
  });

  // Batch F review #10: SkinGen's About box (left open by bake_skin_textures, F-84) kept skin_rgb from running, and the
  // report said "Still to run after the answer" and "To go on after the answer", with nothing to answer.
  it("says a step a window with no buttons kept from running goes on once the window is answered or closed in CC5", async () => {
    mockJobs(bridge);
    // The queue guard's text (server.py _modal_dialog_error), which the bridge sends with HTTP 400.
    const guard = `${ABOUT_NAMED}, then try again.`;
    bridge.setSkinColor.mockRejectedValueOnce(new BridgeHttpError(guard, 400)).mockResolvedValue(OK);
    const first = await recipeTool()({ recipe: { skin_rgb: RGB, pose_file: "C:/p/Supine.rlMotion" } });
    expect(first.isError).toBe(true);
    const id = /continue_after "(stop_\d+)"/.exec(first.content[0].text)?.[1] ?? "";
    expect(id).toMatch(/^stop_\d+$/);
    expect(first.content[0].text).toBe([
      "Stopped at skin_rgb: it could not run while CC5 had a window open (a question nobody has answered, a window to " +
        "close in CC5 because it has no buttons or this bridge cannot read its buttons, or a progress window), so " +
        "nothing after it was sent to CC5.",
      'WAIT skin_rgb: CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool ' +
        "can close it), then try again.",
      "Still to run once the window is answered or closed in CC5: skin_rgb, pose_file.",
      `To go on once the window is answered or closed in CC5: apply_character_recipe with continue_after "${id}" and ` +
        'this recipe: {"skin_rgb":[0.8,0.6,0.5],"pose_file":"C:/p/Supine.rlMotion"}',
      "Show the user the window above; they answer or close it in CC5 unless it is a plain confirmation of what they " +
        "asked for. Do not run the step again yourself: continue_after runs it once the window is closed.",
    ].join("\n"));
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(1);
  });

  it("goes on after a question whose job CC5 did not name, and reports that step as not known", async () => {
    const started = mockJobs(bridge);
    const asked = 'CC5 is waiting for an answer to "Apply the skin colour?".';
    bridge.setSkinColor.mockRejectedValue(new BridgeHttpError(asked, 409));
    const first = await recipeTool()({ recipe: { skin_rgb: RGB, pose_file: "C:/p/Supine.rlMotion" } });
    expect(first.content[0].text.split("\n").slice(0, 2)).toEqual([
      "Stopped at skin_rgb: CC5 is waiting for an answer nobody has given yet, so nothing after it was sent to CC5.",
      `WAIT skin_rgb: ${asked}`]);
    expect(started).toEqual([]);
    const id = /continue_after "(stop_\d+)"/.exec(first.content[0].text)?.[1] ?? "";
    expect(id).toMatch(/^stop_\d+$/);

    const r = await recipeTool()({ recipe: {}, continue_after: id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text.split("\n")).toEqual([
      `Continued after the answer (continue_after "${id}"): this report covers the whole recipe.`,
      "1 of 2 steps failed.",
      "FAIL skin_rgb (after the answer): its job id is unknown: check the scene (list_clothes, capture_viewport) before " +
        "relying on it",
      "OK   pose_file"]);
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(1);  // CC5 ran it under the question: not sent again
    expect(started.map((j) => j.action)).toEqual(["apply_pose"]);
  });

  it("waits for the job a base step stopped on, then runs the whole base again", async () => {
    const text = waiting("cmd_ab12cd34_7", "Delete Old?", "OK, Cancel");
    let answered = false;
    bridge.getAvatars.mockResolvedValue([{ name: "Old", id: "1", type: "avatar" }]);
    bridge.deleteAvatar.mockRejectedValueOnce(new BridgeHttpError(text, 409)).mockResolvedValue(OK);
    bridge.setSkinColor.mockResolvedValue(OK);
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_8" });
    bridge.getJob.mockImplementation(async (id: string) => {
      if (id !== "cmd_ab12cd34_7") return { job_id: id, action: "create_default_avatar", status: "done", result: OK };
      return answered
        ? { job_id: id, action: "delete_avatar", status: "done", result: OK }
        : { job_id: id, action: "delete_avatar", status: "running", dialog: APPLY, dialog_message: text };
    });
    const first = await recipeTool()({ recipe: { base: "default", skin_rgb: RGB } });
    expect(first.content[0].text).toMatch(/^Stopped at base: it could not run while CC5 had a window open/);
    expect(first.content[0].text).toContain('continue_after "cmd_ab12cd34_7" and this recipe: ' +
      '{"base":"default","skin_rgb":[0.8,0.6,0.5]}');
    expect(bridge.startJob).not.toHaveBeenCalled();

    answered = true;  // the user answered in CC5 and the delete finished
    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_7" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n")).toEqual([
      'Continued after the answer (continue_after "cmd_ab12cd34_7"): this report covers the whole recipe.',
      "All 2 steps succeeded.", "OK   base", "OK   skin_rgb"]);
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(2);
    expect(bridge.startJob).toHaveBeenCalledTimes(1);
    expect(bridge.startJob).toHaveBeenCalledWith("create_default_avatar", {});
  });

  it("stops again at a later question of the same recipe, and the last continuation reports the whole recipe", async () => {
    const store = eyesAsk();
    bridge.setSkinColor.mockResolvedValue(OK);
    await recipeTool()({ recipe: { assets: [EYES_01, EYES_02], skin_rgb: RGB } });
    store.set("cmd_ab12cd34_1", loaded(EYES_01));

    const second = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(second.isError).toBe(true);
    expect(second.content[0].text.split("\n").slice(0, 4)).toEqual([
      'Continued after the answer (continue_after "cmd_ab12cd34_1"): this report covers the whole recipe.',
      "Stopped at asset Eyes_02.ccEye: CC5 is waiting for an answer nobody has given yet, so nothing after it was " +
        "sent to CC5.",
      "OK   asset Eyes_01.ccEye (after the answer)",
      `WAIT asset Eyes_02.ccEye: ${waitingLine("cmd_ab12cd34_2")}`,
    ]);
    expect(second.content[0].text).toContain('continue_after "cmd_ab12cd34_2" and this recipe: {"skin_rgb":[0.8,0.6,0.5]}');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();

    store.set("cmd_ab12cd34_2", loaded(EYES_02));
    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n").slice(0, 5)).toEqual([
      'Continued after the answer (continue_after "cmd_ab12cd34_2"): this report covers the whole recipe.',
      "All 3 steps succeeded.",
      "OK   asset Eyes_01.ccEye (after the answer)",
      "OK   asset Eyes_02.ccEye (after the answer)",
      "OK   skin_rgb",
    ]);
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(1);
    expect(store.started.map((j) => j.params.file_path)).toEqual([EYES_01, EYES_02]);
  });

  it("refuses an unknown continue_after without calling CC5, and frees the scene for the next recipe", async () => {
    const r = await recipeTool()({ recipe: {}, continue_after: "stop_999999" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("continue_after stop_999999 is not where the last recipe stopped (or the MCP server " +
      "restarted): run the remaining steps as a new recipe. Nothing was sent to CC5.");
    expect(bridge.getDialog).not.toHaveBeenCalled();
    expect(bridge.getJob).not.toHaveBeenCalled();
    bridge.setSkinColor.mockResolvedValue(OK);
    expect((await recipeTool()({ recipe: { skin_rgb: RGB } })).isError).toBeUndefined();
  });

  it("forgets the stop when CC5 lost the job, and says how to go on", async () => {
    eyesAsk();
    await recipeTool()({ recipe: { assets: [EYES_01], skin_rgb: RGB } });
    bridge.getJob.mockRejectedValue(new BridgeHttpError("Unknown job: cmd_ab12cd34_1", 404));
    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Job cmd_ab12cd34_1 not found. CC5 was probably restarted and the job's result is " +
      "lost. Check the output folder, then run the operation again. The recipe that stopped at asset Eyes_01.ccEye cannot " +
      'be continued: check the scene (list_avatars, capture_viewport), then run the remaining steps as a new recipe: {"skin_rgb":[0.8,0.6,0.5]}.');
    expect((await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" })).content[0].text)
      .toContain("is not where the last recipe stopped");
  });

  it("keeps the stop when the client cancels the wait, or the step is still running", async () => {
    const store = eyesAsk();
    await recipeTool()({ recipe: { assets: [EYES_01], skin_rgb: RGB } });
    store.set("cmd_ab12cd34_1", { status: "running" });
    const ac = new AbortController();
    bridge.getJob.mockImplementationOnce(async (id: string) => {
      ac.abort();
      return { job_id: id, action: "load_asset", status: "running" };
    });
    const cancelled = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" }, { signal: ac.signal });
    expect(cancelled.content[0].text).toBe("Cancelled while waiting for asset Eyes_01.ccEye to finish; nothing else was " +
      'sent to CC5. Call apply_character_recipe with continue_after "cmd_ab12cd34_1" again to go on.');

    vi.useFakeTimers();
    try {
      const pending = recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
      await vi.advanceTimersByTimeAsync(200_000);
      const running = await pending;
      expect(running.content[0].text).toBe("asset Eyes_01.ccEye is still running in CC5 (job cmd_ab12cd34_1). Call " +
        'apply_character_recipe with continue_after "cmd_ab12cd34_1" again in a moment; nothing else was sent to CC5.');
    } finally {
      vi.useRealTimers();
    }
    store.set("cmd_ab12cd34_1", loaded(EYES_01));
    bridge.setSkinColor.mockResolvedValue(OK);
    expect((await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" })).isError).toBeUndefined();
  });
});

describe("apply_character_recipe does not start while CC5 has a window open (D1)", () => {
  it("refuses at once and sends CC5 nothing", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: APPLY, waiting_job: null });
    const r = await recipeTool()({ recipe: { base: "default", skin_rgb: RGB } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`${formatDialog(APPLY, null)}\nNothing was sent to CC5: answer or close it first, ` +
      "then run the recipe again.");
    expect(bridge.getDialog).toHaveBeenCalledWith(3000);
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
    expect(bridge.setSkinColor).not.toHaveBeenCalled();

    bridge.getDialog.mockResolvedValue({ success: true, dialog: PROGRESS, waiting_job: "cmd_ab12cd34_9" });
    const busy = await recipeTool()({ recipe: { skin_rgb: RGB } });
    expect(busy.content[0].text).toBe(`${formatDialog(PROGRESS, "cmd_ab12cd34_9")}\nNothing was sent to CC5: run the ` +
      "recipe again when it closes.");
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
  });

  it("points to the stopped recipe when the open question is the one it stopped on", async () => {
    eyesAsk();
    await recipeTool()({ recipe: { assets: [EYES_01] } });
    bridge.getDialog.mockResolvedValue({ success: true, dialog: LAYER, waiting_job: "cmd_ab12cd34_1" });
    const r = await recipeTool()({ recipe: { skin_rgb: RGB } });
    expect(r.content[0].text).toContain("\nThe last recipe stopped on this question at asset Eyes_01.ccEye: after the " +
      'answer, go on with apply_character_recipe continue_after "cmd_ab12cd34_1".');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    expect((await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" })).content[0].text)
      .not.toContain("is not where the last recipe stopped");  // the refused call did not replace the stop
  });

  // F-94 (live): the pre-check showed the Welcome page as 'CC5 dialog "(untitled)": Buttons: none found' to ask about.
  it("words CC5's Welcome page as a window to close in CC5, as the queue guard does (F-94)", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: { title: "", text: "", buttons: [] }, waiting_job: null });
    const r = await recipeTool()({ recipe: { skin_rgb: RGB } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("CC5's Welcome / What's New page (or another untitled CC5 window) is open - close it " +
      "in Character Creator 5 (tick \"Don't show this again\" so it stays closed).\nNothing was sent to CC5: answer or " +
      "close it first, then run the recipe again.");
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
  });

  it("says the stopped recipe stopped on a window with no buttons, to go on once it is closed (F-94)", async () => {
    jobStore((_action, _params, id) => ({ status: "running", dialog: ABOUT, dialog_message: closeWaiting(ABOUT_NAMED, id) }));
    const first = await recipeTool()({ recipe: { assets: [EYES_01] } });
    expect(first.isError).toBe(true);
    // Review #19: the report said CC5 waited for an answer and to answer a plain confirmation, for a window with no
    // buttons that answer_cc5_dialog cannot click. Batch F review #29: the plugin's own text, whose "read its result with
    // job_status(...)" the advice below contradicted: the WAIT line names continue_after instead.
    expect(first.content[0].text).toBe([
      "Stopped at asset Eyes_01.ccEye: CC5 has a window open with no buttons that nobody has closed yet, so nothing " +
        "after it was sent to CC5.",
      'WAIT asset Eyes_01.ccEye: CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 ' +
        "(no MCP tool can close it). The command is still running as job cmd_ab12cd34_1: continue_after reads its " +
        "result once it is closed.",
      "Nothing else was left to run.",
      'To go on once the window is closed: apply_character_recipe with continue_after "cmd_ab12cd34_1" and this recipe: {}',
      "Ask the user to close that window in Character Creator 5: it has no buttons, so no MCP tool can close it. Do not " +
        "call job_status or run the step again: continue_after waits for it and reports it once the window is closed.",
    ].join("\n"));
    bridge.getDialog.mockResolvedValue({ success: true, dialog: ABOUT, waiting_job: "cmd_ab12cd34_1" });
    const r = await recipeTool()({ recipe: { skin_rgb: RGB } });
    expect(r.content[0].text).toBe(`${formatDialog(ABOUT, "cmd_ab12cd34_1")}\nNothing was sent to CC5: answer or close ` +
      "it first, then run the recipe again.\nThe last recipe stopped on this window at asset Eyes_01.ccEye: once it is " +
      'closed, go on with apply_character_recipe continue_after "cmd_ab12cd34_1".');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
  });

  it("goes ahead when the dialog check itself fails", async () => {
    bridge.getDialog.mockRejectedValue(new BridgeTimeoutError("No reply from CC5 within 3s."));
    bridge.setSkinColor.mockResolvedValue(OK);
    const r = await recipeTool()({ recipe: { skin_rgb: RGB } });
    expect(r.isError).toBeUndefined();
    expect(bridge.setSkinColor).toHaveBeenCalledTimes(1);
  });

  it("notes a stop the new recipe replaced, which can no longer be continued", async () => {
    eyesAsk();
    await recipeTool()({ recipe: { assets: [EYES_01] } });
    bridge.setSkinColor.mockResolvedValue(OK);
    const r = await recipeTool()({ recipe: { skin_rgb: RGB } });
    expect(r.content[0].text.split("\n").slice(0, 2)).toEqual([
      'Note: the recipe that stopped at asset Eyes_01.ccEye (continue_after "cmd_ab12cd34_1") was not continued; it can ' +
      "no longer be continued.", "All 1 steps succeeded."]);
    expect((await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" })).content[0].text)
      .toContain("is not where the last recipe stopped");
  });
});

// Review #19 and #3: a step waiting in a window answer_cc5_dialog cannot click was reported as waiting for an answer.
describe("apply_character_recipe and windows answered or closed in CC5 itself (F-94, F-99)", () => {
  it("asks to answer or close a window with no buttons before continue_after goes on", async () => {
    const store = jobStore((_action, _params, id) =>
      ({ status: "running", dialog: ABOUT, dialog_message: closeWaiting(ABOUT_NAMED, id) }));
    bridge.setSkinColor.mockResolvedValue(OK);
    await recipeTool()({ recipe: { assets: [EYES_01], skin_rgb: RGB } });
    bridge.getDialog.mockResolvedValue({ success: true, dialog: ABOUT, waiting_job: "cmd_ab12cd34_1" });
    const still = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(still.isError).toBe(true);
    // Batch F review #29: the refusal with the text batch F's plugin sends.
    expect(still.content[0].text).toBe('CC5 has a window open with no buttons: "CCSkinGen" - close it in Character ' +
      "Creator 5 (no MCP tool can close it). The command is still running as job cmd_ab12cd34_1: read its result with " +
      'job_status("cmd_ab12cd34_1") once it is closed.\nAnswer or close it first, then call apply_character_recipe with ' +
      'continue_after "cmd_ab12cd34_1" again. Nothing else was sent to CC5.');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();

    store.set("cmd_ab12cd34_1", loaded(EYES_01));  // the user closed the window and the load finished
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    const done = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(done.isError).toBeUndefined();
    expect(done.content[0].text.split("\n").slice(1, 4)).toEqual([
      "All 2 steps succeeded.", "OK   asset Eyes_01.ccEye (after the answer)", "OK   skin_rgb"]);
  });

  // Batch F review #29: a plugin before batch F said to answer even a window with no buttons with answer_cc5_dialog;
  // jobs.ts jobDialogMessage words it as get_cc5_dialog does (formatDialog), on two lines.
  it("words a plugin's 'answer it with answer_cc5_dialog' for a window with no buttons as get_cc5_dialog does", async () => {
    jobStore((_action, _params, id) => ({ status: "running", dialog: ABOUT_E, dialog_message: aboutWaitingE(id) }));
    const first = await recipeTool()({ recipe: { assets: [EYES_01], skin_rgb: RGB } });
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toBe([
      "Stopped at asset Eyes_01.ccEye: CC5 has a window open with no buttons that nobody has closed yet, so nothing " +
        "after it was sent to CC5.",
      'WAIT asset Eyes_01.ccEye: CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 ' +
        "(no MCP tool can close it).",
      "Job cmd_ab12cd34_1 is waiting on this window; continue_after reads its result once it is closed.",
      "Still to run once the window is closed: skin_rgb.",
      'To go on once the window is closed: apply_character_recipe with continue_after "cmd_ab12cd34_1" and this ' +
        'recipe: {"skin_rgb":[0.8,0.6,0.5]}',
      "Ask the user to close that window in Character Creator 5: it has no buttons, so no MCP tool can close it. Do not " +
        "call job_status or run the step again: continue_after waits for it and reports it once the window is closed.",
    ].join("\n"));
    expect(first.content[0].text).not.toContain("answer_cc5_dialog");

    bridge.getDialog.mockResolvedValue({ success: true, dialog: ABOUT_E, waiting_job: "cmd_ab12cd34_1" });
    const still = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(still.isError).toBe(true);
    expect(still.content[0].text).toBe('CC5 has a window open with no buttons: "CCSkinGen" - close it in Character ' +
      "Creator 5 (no MCP tool can close it).\nJob cmd_ab12cd34_1 is waiting on this window; read its result with " +
      "job_status once it is closed.\nAnswer or close it first, then call apply_character_recipe with continue_after " +
      '"cmd_ab12cd34_1" again. Nothing else was sent to CC5.');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
  });

  // F-99 (live): CC5's Export FBX dialog is one QML widget: the bridge reads no buttons and can click none.
  it("says a window whose buttons the bridge cannot read is answered or closed in CC5, in every reply", async () => {
    jobStore((_action, _params, id) => ({ status: "running", dialog: FBX, dialog_message: closeWaiting(FBX_NAMED, id) }));
    const first = await recipeTool()({ recipe: { assets: [EYES_01], skin_rgb: RGB } });
    expect(first.isError).toBe(true);
    // Batch F review #29: the plugin's own text, its job_status words naming continue_after in the WAIT line.
    expect(first.content[0].text).toBe([
      "Stopped at asset Eyes_01.ccEye: CC5 has a window open whose buttons this bridge cannot read, and nobody has " +
        "answered or closed it yet, so nothing after it was sent to CC5.",
      'WAIT asset Eyes_01.ccEye: CC5 has a window open whose buttons this bridge cannot read: "Export FBX" - answer or ' +
        "close it in Character Creator 5 (no MCP tool can click its buttons). The command is still running as job " +
        "cmd_ab12cd34_1: continue_after reads its result once it is closed.",
      "Still to run once the window is answered or closed: skin_rgb.",
      'To go on once the window is answered or closed: apply_character_recipe with continue_after "cmd_ab12cd34_1" ' +
        'and this recipe: {"skin_rgb":[0.8,0.6,0.5]}',
      "Ask the user to answer or close that window in Character Creator 5: this bridge cannot read or click its " +
        "buttons. Do not call job_status or run the step again: continue_after waits for it and reports it once the " +
        "window is closed.",
    ].join("\n"));

    bridge.getDialog.mockResolvedValue({ success: true, dialog: FBX, waiting_job: "cmd_ab12cd34_1" });
    const still = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(still.content[0].text).toBe('CC5 has a window open whose buttons this bridge cannot read: "Export FBX" - ' +
      "answer or close it in Character Creator 5 (no MCP tool can click its buttons). The command is still running as " +
      'job cmd_ab12cd34_1: read its result with job_status("cmd_ab12cd34_1") once it is closed.\nAnswer or close it ' +
      'first, then call apply_character_recipe with continue_after "cmd_ab12cd34_1" again. Nothing else was sent to CC5.');
    const fresh = await recipeTool()({ recipe: { skin_rgb: RGB } });
    expect(fresh.content[0].text).toBe(`${formatDialog(FBX, "cmd_ab12cd34_1")}\nNothing was sent to CC5: answer or ` +
      "close it first, then run the recipe again.\nThe last recipe stopped on this window at asset Eyes_01.ccEye: once " +
      'it is answered or closed, go on with apply_character_recipe continue_after "cmd_ab12cd34_1".');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
  });

  // Review #8: answer_cc5_dialog refuses a dialog whose text could not be read (it may be the crash-recovery prompt),
  // and the report said to answer a plain confirmation yourself.
  it("asks the user to answer a question whose text could not be read in CC5, in every reply", async () => {
    const unread = { title: "Character Creator 5", text: "", buttons: [], text_read: false };
    const asked = 'CC5 is waiting for an answer to "Character Creator 5". Buttons: none found. The command is still ' +
      "running as job cmd_ab12cd34_1: its text could not be read, so ask the user to answer it in CC5, then check its " +
      'result with job_status("cmd_ab12cd34_1").';
    jobStore(() => ({ status: "running", dialog: unread, dialog_message: asked }));
    const first = await recipeTool()({ recipe: { assets: [EYES_01], skin_rgb: RGB } });
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toBe([
      "Stopped at asset Eyes_01.ccEye: CC5 is waiting for an answer nobody has given yet, so nothing after it was sent " +
        "to CC5.",
      // Batch F review #29: the WAIT line names continue_after where the plugin's text names job_status.
      'WAIT asset Eyes_01.ccEye: CC5 is waiting for an answer to "Character Creator 5". Buttons: none found. The ' +
        "command is still running as job cmd_ab12cd34_1: its text could not be read, so ask the user to answer it in " +
        "CC5, then continue_after reads its result.",
      "Still to run after the answer: skin_rgb.",
      'To go on after the answer: apply_character_recipe with continue_after "cmd_ab12cd34_1" and this recipe: ' +
        '{"skin_rgb":[0.8,0.6,0.5]}',
      "Ask the user to answer that question in Character Creator 5: its text could not be read, so answer_cc5_dialog " +
        "refuses it (it may be CC5's crash-recovery prompt). Do not call job_status or run the step again: " +
        "continue_after waits for it and reports it.",
    ].join("\n"));

    bridge.getDialog.mockResolvedValue({ success: true, dialog: unread, waiting_job: "cmd_ab12cd34_1" });
    const still = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(still.content[0].text).toBe(`${asked}\nAsk the user to answer it in CC5 first, then call ` +
      'apply_character_recipe with continue_after "cmd_ab12cd34_1" again. Nothing else was sent to CC5.');
    const fresh = await recipeTool()({ recipe: { skin_rgb: RGB } });
    expect(fresh.content[0].text).toBe(`${formatDialog(unread, "cmd_ab12cd34_1")}\nNothing was sent to CC5: answer or ` +
      "close it first, then run the recipe again.\nThe last recipe stopped on this question at asset Eyes_01.ccEye: " +
      'after the answer, go on with apply_character_recipe continue_after "cmd_ab12cd34_1".');
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
  });
});

// F-98 (live): after Chad's Cancel on _Hazel1 Eyes' Replace / Material Only question, the continued recipe reported
// "OK   asset _Hazel1 Eyes.ccEye (after the answer)" and "All 2 steps succeeded", though CC5 applied nothing.
describe("apply_character_recipe reports a step answered Cancel in CC5 as cancelled (F-98)", () => {
  it("never counts the step that finished after the user's Cancel as succeeded", async () => {
    const store = eyesAsk();
    const first = await recipeTool()({ recipe: { assets: [EYES_01, SHIRT] } });
    expect(first.content[0].text).toMatch(/^Stopped at asset Eyes_01\.ccEye/);
    // The user picked Cancel: CC5 finished the load without applying it, and the job's status names the button.
    store.set("cmd_ab12cd34_1", { ...loaded(EYES_01), answers: CANCEL });

    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text.split("\n").slice(0, 4)).toEqual([
      'Continued after the answer (continue_after "cmd_ab12cd34_1"): this report covers the whole recipe.',
      "1 of 2 steps was cancelled in CC5; 1 succeeded.",
      "CANCELLED asset Eyes_01.ccEye (after the answer) (answered Cancel in CC5, so CC5 applied nothing)",
      "OK   asset Shirt.ccCloth",
    ]);
    expect(r.content[0].text).not.toContain("All 2 steps succeeded");
    expect(store.started.map((j) => j.params.file_path)).toEqual([EYES_01, SHIRT]);
  });

  it("names a step answered Cancel while the recipe ran, in its progress notification too", async () => {
    jobStore((_action, params) => ({ ...loaded(String(params.file_path)), answers: CANCEL }));
    bridge.setSkinColor.mockResolvedValue(OK);
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const r = await recipeTool()({ recipe: { assets: [EYES_01], skin_rgb: RGB } },
      { signal: new AbortController().signal, _meta: { progressToken: 1 }, sendNotification });
    expect(r.isError).toBe(true);
    expect(r.content[0].text.split("\n").slice(0, 3)).toEqual([
      "1 of 2 steps was cancelled in CC5; 1 succeeded.",
      "CANCELLED asset Eyes_01.ccEye (answered Cancel in CC5, so CC5 applied nothing)",
      "OK   skin_rgb",
    ]);
    expect(sendNotification.mock.calls.map(([n]) => n.params.message)).toEqual(["CANCELLED asset Eyes_01.ccEye", "OK skin_rgb"]);
  });
});

// Review #12: the recipe's base step deletes through delete_avatar, which clears CC5's selection first (F-92), but the
// report dropped what delete_avatar noted.
describe("apply_character_recipe's base step and delete_avatar (F-92)", () => {
  const KEVIN = [{ name: "Kevin", id: "1", type: "avatar" }];
  const CLEARED = "CC5's selection (Pants) was cleared before the delete: deleting a character while one of its worn " +
    "items is selected can crash CC5 (F-92).";
  const REFUSED = "CC5's selection (Pants) could not be cleared, so nothing was deleted: deleting a character while " +
    "one of its worn items is selected can crash CC5 (F-92). Run clear_selection (or deselect everything in Character Creator 5), then delete again.";

  it("shows what delete_avatar noted in the base step's line", async () => {
    mockJobs(bridge);
    bridge.getAvatars.mockResolvedValue(KEVIN);
    bridge.deleteAvatar.mockResolvedValue({ success: true, removed: ["Kevin"], notes: [CLEARED] });
    bridge.setSkinColor.mockResolvedValue(OK);
    const r = await recipeTool()({ recipe: { base: "default", skin_rgb: RGB } });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(["All 2 steps succeeded.", `OK   base: ${CLEARED}`, "OK   skin_rgb"].join("\n"));
  });

  it("keeps those notes with the base step when it finishes after an answer", async () => {
    bridge.getAvatars.mockResolvedValue(KEVIN);
    bridge.deleteAvatar.mockResolvedValue({ success: true, removed: ["Kevin"], notes: [CLEARED] });
    bridge.setSkinColor.mockResolvedValue(OK);
    const store = jobStore((_action, _params, id) =>
      ({ status: "running", dialog: APPLY, dialog_message: waiting(id, "Apply the preset?", "OK, Cancel") }));
    const first = await recipeTool()({ recipe: { base: "default", skin_rgb: RGB } });
    expect(first.content[0].text.split("\n")[1])
      .toBe(`WAIT base: ${waitingLine("cmd_ab12cd34_1", "Apply the preset?", "OK, Cancel")} ${CLEARED}`);

    store.set("cmd_ab12cd34_1", { status: "done", result: { success: true, name: "Default Character" } });
    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n").slice(1)).toEqual([
      "All 2 steps succeeded.", `OK   base (after the answer): ${CLEARED}`, "OK   skin_rgb"]);
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(1);
  });

  // Batch F review #11: the base load's question was answered Cancel after the base step had deleted Kevin, and the
  // report said "CC5 applied nothing" next to the delete's note: Kevin was gone, and the base may not have loaded.
  it("says a base load answered Cancel may not have loaded, and that the characters in the scene were already deleted", async () => {
    bridge.getAvatars.mockResolvedValue(KEVIN);
    bridge.deleteAvatar.mockResolvedValue({ success: true, removed: ["Kevin"], notes: [CLEARED] });
    bridge.setSkinColor.mockResolvedValue(OK);
    const store = jobStore((_action, _params, id) =>
      ({ status: "running", dialog: APPLY, dialog_message: waiting(id, "Apply the preset?", "OK, Cancel") }));
    await recipeTool()({ recipe: { base: "default", skin_rgb: RGB } });

    // The user picked Cancel: CC5 finished the job, and its status names the button.
    store.set("cmd_ab12cd34_1", { status: "done", result: { success: true, name: "Default Character" }, answers: CANCEL });
    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text.split("\n")).toEqual([
      'Continued after the answer (continue_after "cmd_ab12cd34_1"): this report covers the whole recipe.',
      "1 of 2 steps was cancelled in CC5; 1 succeeded.",
      "CANCELLED base (after the answer) (answered Cancel in CC5, so CC5 may not have done it; any characters that " +
        `were in the scene had already been deleted) ${CLEARED}`,
      "OK   skin_rgb",
    ]);
    expect(r.content[0].text).not.toContain("applied nothing");
    expect(bridge.deleteAvatar).toHaveBeenCalledTimes(1);
  });

  it("keeps those notes when the base step runs again after a question stopped its deletes", async () => {
    const text = waiting("cmd_ab12cd34_7", "Delete Camila?", "OK, Cancel");
    let answered = false;
    bridge.getAvatars.mockImplementation(async () => (answered ? [] : [...KEVIN, { name: "Camila", id: "2", type: "avatar" }]));
    bridge.deleteAvatar.mockResolvedValueOnce({ success: true, removed: ["Kevin"], notes: [CLEARED] })
      .mockRejectedValueOnce(new BridgeHttpError(text, 409));
    bridge.setSkinColor.mockResolvedValue(OK);
    bridge.startJob.mockResolvedValue({ job_id: "cmd_ab12cd34_8" });
    bridge.getJob.mockImplementation(async (id: string) => {
      if (id !== "cmd_ab12cd34_7") return { job_id: id, action: "create_default_avatar", status: "done", result: OK };
      return answered
        ? { job_id: id, action: "delete_avatar", status: "done", result: OK }
        : { job_id: id, action: "delete_avatar", status: "running", dialog: APPLY, dialog_message: text };
    });
    const first = await recipeTool()({ recipe: { base: "default", skin_rgb: RGB } });
    expect(first.content[0].text.split("\n")[1]).toBe(`WAIT base: ${text} ${CLEARED}`);

    answered = true;  // the user answered in CC5 and Camila's delete finished
    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_7" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.split("\n").slice(1)).toEqual(["All 2 steps succeeded.", `OK   base: ${CLEARED}`, "OK   skin_rgb"]);
  });

  it("ends the recipe as a failed base step when CC5's selection could not be cleared, and keeps no stop", async () => {
    const started = mockJobs(bridge);
    bridge.getAvatars.mockResolvedValue(KEVIN);
    // delete_avatar fails closed (nothing deleted); the bridge answers a failed command with HTTP 400 and its error.
    bridge.deleteAvatar.mockRejectedValue(new BridgeHttpError(REFUSED, 400));
    bridge.setSkinColor.mockResolvedValue(OK);
    const r = await recipeTool()({ recipe: { base: "default", skin_rgb: RGB, pose_file: "C:/p/Supine.rlMotion" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe([
      "Ended at base: that step failed, so nothing after it was sent to CC5.",
      `FAIL base: could not remove existing avatar Kevin: ${REFUSED}`,
      "Not sent to CC5: skin_rgb, pose_file.",
      "Run clear_selection (or deselect everything in CC5), then run the whole recipe again: its base step deletes " +
        "the characters in the scene first.",
    ].join("\n"));
    expect(started).toEqual([]);
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
    // Nothing to continue: the next recipe runs without a note about a stop it replaced.
    const next = await recipeTool()({ recipe: { skin_rgb: RGB } });
    expect(next.content[0].text).toBe("All 1 steps succeeded.\nOK   skin_rgb");
  });
});

describe("apply_character_recipe and CC5's Replace / Material Only question (D3)", () => {
  it("refuses layer_answer without continue_after: there is no standing answer", async () => {
    const r = await recipeTool()({ recipe: { skin_rgb: RGB }, layer_answer: "Replace" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("layer_answer only goes on after a recipe stopped on CC5's 'Replace / Material Only' " +
      "question (with continue_after). There is no standing answer: run the recipe without it; if CC5 asks, the recipe " +
      "stops and the question goes to the user. Nothing was sent to CC5.");
    expect(bridge.getDialog).not.toHaveBeenCalled();
    expect(bridge.setSkinColor).not.toHaveBeenCalled();
  });

  it("answers the same question for the rest of the recipe with the user's button; a new recipe asks again", async () => {
    const store = eyesAsk();
    bridge.answerDialog.mockImplementation(async (button: string) => {
      const asked = store.started[store.started.length - 1];
      store.set(asked.id, loaded(String(asked.params.file_path)));  // CC5 takes the click and the load finishes
      return { success: true, clicked: button, dialog: LAYER };
    });
    const first = await recipeTool()({ recipe: { assets: [EYES_01, EYES_02] } });
    expect(first.content[0].text).toMatch(/^Stopped at asset Eyes_01\.ccEye/);
    store.set("cmd_ab12cd34_1", loaded(EYES_01));  // the user picked Material Only and it was answered

    vi.useFakeTimers();
    try {
      const pending = recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1", layer_answer: "Material Only" });
      await vi.advanceTimersByTimeAsync(5_000);
      const r = await pending;
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toContain("OK   asset Eyes_01.ccEye (after the answer)\nOK   asset Eyes_02.ccEye: CC5 asked " +
        "'Replace / Material Only'; answered 'Material Only' (the user's answer earlier in this run)");
    } finally {
      vi.useRealTimers();
    }
    expect(bridge.answerDialog).toHaveBeenCalledTimes(1);
    expect(bridge.answerDialog).toHaveBeenCalledWith("Material Only", LAYER_EXPECT);

    const next = await recipeTool()({ recipe: { assets: [EYES_03] } });
    expect(next.content[0].text).toMatch(/^Stopped at asset Eyes_03\.ccEye/);
    expect(bridge.answerDialog).toHaveBeenCalledTimes(1);
  });

  // RB-3: the run clicked its answer, then the same load asked another question: the click was dropped from the report.
  it("names the run's click in the stop and in the step that finishes after the answer", async () => {
    const apply = (id: string): Script =>
      ({ status: "running", dialog: APPLY, dialog_message: waiting(id, "Apply the preset?", "OK, Cancel") });
    const store = eyesAsk();
    bridge.answerDialog.mockImplementation(async (button: string) => {
      store.set("cmd_ab12cd34_2", apply("cmd_ab12cd34_2"));  // the click took, and the load asks another question
      return { success: true, clicked: button, dialog: LAYER };
    });
    const first = await recipeTool()({ recipe: { assets: [EYES_01, EYES_02] } });
    expect(first.content[0].text).toMatch(/^Stopped at asset Eyes_01\.ccEye/);
    store.set("cmd_ab12cd34_1", loaded(EYES_01));  // the user picked Material Only and it was answered

    vi.useFakeTimers();
    let second: Awaited<ReturnType<ReturnType<typeof recipeTool>>>;
    try {
      const pending = recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1", layer_answer: "Material Only" });
      await vi.advanceTimersByTimeAsync(5_000);
      second = await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain(`\nWAIT asset Eyes_02.ccEye: ${waitingLine("cmd_ab12cd34_2", "Apply the preset?", "OK, Cancel")} ` +
      "(this run already answered 'Replace / Material Only' in this job with 'Material Only')\n");
    expect(second.content[0].text).not.toContain(LAYER_STOP_ADVICE);  // CC5 asks something else now: no fresh layer choice
    expect(bridge.answerDialog).toHaveBeenCalledTimes(1);

    store.set("cmd_ab12cd34_2", loaded(EYES_02));  // the user answered "Apply the preset?"
    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_2" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("\nOK   asset Eyes_02.ccEye (after the answer): CC5 asked 'Replace / Material Only'; " +
      "answered 'Material Only' (the user's answer earlier in this run)\n");
    expect(bridge.answerDialog).toHaveBeenCalledTimes(1);
  });

  it("refuses layer_answer after a stop on another question", async () => {
    jobStore((_action, _params, id) => ({ status: "running", dialog: APPLY, dialog_message: waiting(id, "Apply the preset?", "OK, Cancel") }));
    const first = await recipeTool()({ recipe: { assets: [EYES_01] } });
    expect(first.content[0].text).not.toContain(LAYER_STOP_ADVICE);
    const r = await recipeTool()({ recipe: {}, continue_after: "cmd_ab12cd34_1", layer_answer: "Replace" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("layer_answer answers only CC5's 'Replace / Material Only' question, and this run " +
      "stopped on a different one. Go on without layer_answer. Nothing was sent to CC5.");
    expect(bridge.getDialog).toHaveBeenCalledTimes(1);  // the first recipe's check only
  });
});

describe("apply_character_recipe refuses recipes it cannot run, before any CC5 call", () => {
  it("refuses a missing base, an empty recipe and a base that is not a character, even while the scene is busy", async () => {
    const release = claimScene("another run");
    if (typeof release === "string") throw new Error(release);
    try {
      const missing = await recipeTool()({ recipe: { base: "C:/definitely/missing/Kevin.ccAvatar" } });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toBe("base not found: C:/definitely/missing/Kevin.ccAvatar. Nothing was changed in " +
        "CC5: the characters in the scene were left as they were.");
      for (const recipe of [{}, { assets: [] }]) {
        const empty = await recipeTool()({ recipe });
        expect(empty.isError).toBe(true);
        expect(empty.content[0].text).toBe("The recipe has no steps, so nothing was sent to CC5. Give it at least one step.");
      }
      const prop = await recipeTool()({ recipe: { base: "C:/b/x.iProp" } });
      expect(prop.isError).toBe(true);
      expect(prop.content[0].text).toBe("Invalid recipe: base: base must be a .ccAvatar or .iAvatar file");
    } finally {
      release();
    }
    expect(bridge.getDialog).not.toHaveBeenCalled();
    expect(bridge.getAvatars).not.toHaveBeenCalled();
    expect(bridge.startJob).not.toHaveBeenCalled();
  });

  it("describes the step order, the stop, layer_answer and the rules, without a headshot", () => {
    const call = server.tool.mock.calls.find((c) => c[0] === "apply_character_recipe");
    const description = call?.[1] as string;
    expect(description).toContain("Steps run in this order: base, body preset, morphs, facial profile, skin, makeup and " +
      "eye presets and hairstyles (from assets), skin colour, skin condition, textures, injury overlays, clothing, shoes, " +
      "accessories and other assets, wrinkle strength, expression, pose.");
    expect(description).toContain("continue_after");
    expect(description).toContain("layer_answer");
    expect(description).toContain(PICK_RULE);
    expect(description).toContain(NOT_A_CHECK);
    expect(description.toLowerCase()).not.toContain("headshot");
    const shape = call?.[2] as Record<string, { safeParse: (v: unknown) => { success: boolean }; description?: string }>;
    expect(shape.continue_after.safeParse("cmd_ab12cd34_1").success).toBe(true);
    expect(shape.continue_after.safeParse("stop_3").success).toBe(true);
    expect(shape.continue_after.safeParse("anything").success).toBe(false);
    expect(shape.layer_answer.safeParse("Material Only").success).toBe(true);
    expect(shape.layer_answer.safeParse("Cancel").success).toBe(false);
    // RB-6: the schema takes no Cancel, so its description says how to go on after one.
    expect(shape.layer_answer.description).toContain("for the rest of this recipe only; there is no standing answer.");
    expect(shape.layer_answer.description?.endsWith(CANCEL_NOT_CARRIED)).toBe(true);
  });

  // TS-9: 'one recipe per stage (... then presets and hair ...)' contradicted the one-load-at-a-time rule.
  it("keeps recipes to body and face, and has presets, hair and clothing loaded one at a time", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "apply_character_recipe")?.[1] as string;
    expect(description).toContain("Use a recipe for body and face; load presets, hair and clothing one at a time with " +
      "load_asset, showing each with captures and an undo offer before the next.");
    expect(description).not.toContain("one recipe per stage");
    expect(description.length).toBeLessThan(2000);
  });
});
