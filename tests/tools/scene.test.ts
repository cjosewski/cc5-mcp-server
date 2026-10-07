/**
 * Unit tests for registerSceneTools.
 * Tool handlers use bridgeCall, so bridge errors become content text responses.
 * The check_cc5_connection handler has its own try/catch with specific behavior.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { registerSceneTools } from "../../src/tools/scene.js";
import {
  createMockBridge,
  SUCCESS,
  FAILURE,
  CREATE_SUCCESS,
  CAPTURE_SUCCESS,
} from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import type { CC5Avatar, AvatarInfo, CreateAvatarResult, CaptureResult } from "../../src/types.js";

import { createMockServer } from "../helpers/mock-server.js";
import { BridgeHttpError } from "../../src/cc5-bridge.js";

// ── setup ─────────────────────────────────────────────────────────────────────

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSceneTools(server as any, bridge as any);
});

// ── registration ──────────────────────────────────────────────────────────────

describe("registerSceneTools – registration", () => {
  it("registers exactly 7 tools", () => {
    expect(server.tool).toHaveBeenCalledTimes(7);
  });

  it("registers delete_avatar", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "delete_avatar",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers list_avatars", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "list_avatars",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers get_avatar_info", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "get_avatar_info",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers check_cc5_connection", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "check_cc5_connection",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers create_avatar", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "create_avatar",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers capture_viewport", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "capture_viewport",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers set_subdivision_level", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "set_subdivision_level",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });
});

// ── list_avatars ──────────────────────────────────────────────────────────────

describe("list_avatars handler", () => {
  it("lists avatars with names and IDs", async () => {
    const avatars: CC5Avatar[] = [
      { id: "a1", name: "Hero", type: "character" },
      { id: "a2", name: "Villain", type: "character" },
    ];
    bridge.getAvatars.mockResolvedValue(avatars);
    const handler = server.getRegisteredTool("list_avatars");
    const result = await handler({});
    expect(result.content[0].text).toContain("Found 2 avatar(s)");
    expect(result.content[0].text).toContain("Hero");
    expect(result.content[0].text).toContain("a1");
    expect(result.content[0].text).toContain("Villain");
    expect(result.content[0].text).toContain("a2");
  });

  it("shows empty scene message when no avatars exist", async () => {
    bridge.getAvatars.mockResolvedValue([]);
    const handler = server.getRegisteredTool("list_avatars");
    const result = await handler({});
    expect(result.content[0].text).toBe("No avatars in the current scene.");
  });

  it("handles a single avatar correctly", async () => {
    bridge.getAvatars.mockResolvedValue([{ id: "solo", name: "Solo", type: "character" }]);
    const handler = server.getRegisteredTool("list_avatars");
    const result = await handler({});
    expect(result.content[0].text).toContain("Found 1 avatar(s)");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.getAvatars.mockRejectedValue(new Error("connection refused"));
    const handler = server.getRegisteredTool("list_avatars");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC5 bridge error: connection refused");
  });

  it("returns content with type 'text'", async () => {
    bridge.getAvatars.mockResolvedValue([]);
    const handler = server.getRegisteredTool("list_avatars");
    const result = await handler({});
    expect(result.content[0].type).toBe("text");
  });

  it("formats avatar list with dash prefix per avatar", async () => {
    const avatars: CC5Avatar[] = [
      { id: "x1", name: "Alpha", type: "character" },
    ];
    bridge.getAvatars.mockResolvedValue(avatars);
    const handler = server.getRegisteredTool("list_avatars");
    const result = await handler({});
    expect(result.content[0].text).toContain("- Alpha (ID: x1)");
  });
});

// ── get_avatar_info ───────────────────────────────────────────────────────────

describe("get_avatar_info handler", () => {
  const sampleInfo: AvatarInfo = {
    id: "av1",
    name: "TestHero",
    active_morphs: { Fat: 0.3, Muscular: 0.5, Thin: 0.1 },
  };

  it("shows avatar name and active morph count", async () => {
    bridge.getAvatarInfo.mockResolvedValue(sampleInfo);
    const handler = server.getRegisteredTool("get_avatar_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("TestHero");
    expect(result.content[0].text).toContain("Active morphs (3)");
  });

  it("lists each morph and its value", async () => {
    bridge.getAvatarInfo.mockResolvedValue(sampleInfo);
    const handler = server.getRegisteredTool("get_avatar_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("Fat");
    expect(result.content[0].text).toContain("0.3");
    expect(result.content[0].text).toContain("Muscular");
    expect(result.content[0].text).toContain("0.5");
  });

  it("shows no-avatar message when info is null", async () => {
    bridge.getAvatarInfo.mockResolvedValue(null);
    const handler = server.getRegisteredTool("get_avatar_info");
    const result = await handler({});
    expect(result.content[0].text).toBe("No avatar in the scene.");
  });

  it("shows zero active morphs correctly", async () => {
    bridge.getAvatarInfo.mockResolvedValue({
      id: "av2",
      name: "Plain",
      active_morphs: {},
    });
    const handler = server.getRegisteredTool("get_avatar_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("Active morphs (0)");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.getAvatarInfo.mockRejectedValue(new Error("not connected"));
    const handler = server.getRegisteredTool("get_avatar_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC5 bridge error: not connected");
  });
});

// ── check_cc5_connection ──────────────────────────────────────────────────────

describe("check_cc5_connection handler", () => {
  it("returns connected message when bridge is healthy", async () => {
    bridge.healthCheck.mockResolvedValue(true);
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    const handler = server.getRegisteredTool("check_cc5_connection");
    const result = await handler({});
    expect(result.content[0].text).toContain("connected and ready");
  });

  it("returns not-responding message when healthCheck returns false", async () => {
    bridge.healthCheck.mockResolvedValue(false);
    const handler = server.getRegisteredTool("check_cc5_connection");
    const result = await handler({});
    expect(result.content[0].text).toContain("NOT responding");
    expect(result.content[0].text).toContain("Character Creator 5");
  });

  it("returns not-responding message when healthCheck throws", async () => {
    bridge.healthCheck.mockRejectedValue(new Error("ECONNREFUSED"));
    const handler = server.getRegisteredTool("check_cc5_connection");
    const result = await handler({});
    expect(result.content[0].text).toContain("NOT responding");
  });

  it("calls bridge.healthCheck once per invocation", async () => {
    bridge.healthCheck.mockResolvedValue(true);
    const handler = server.getRegisteredTool("check_cc5_connection");
    await handler({});
    expect(bridge.healthCheck).toHaveBeenCalledTimes(1);
  });

  it("returns content with type 'text'", async () => {
    bridge.healthCheck.mockResolvedValue(true);
    const handler = server.getRegisteredTool("check_cc5_connection");
    const result = await handler({});
    expect(result.content[0].type).toBe("text");
  });
});

// ── create_avatar ─────────────────────────────────────────────────────────────

describe("create_avatar handler", () => {
  it("returns success message with avatar name on success", async () => {
    bridge.createDefaultAvatar.mockResolvedValue(CREATE_SUCCESS);
    const handler = server.getRegisteredTool("create_avatar");
    const result = await handler({});
    expect(result.content[0].text).toContain("Created neutral avatar");
    expect(result.content[0].text).toContain("Default Character");
  });

  it("uses 'Unknown' as name when result.name is undefined", async () => {
    const noName: CreateAvatarResult = { success: true };
    bridge.createDefaultAvatar.mockResolvedValue(noName);
    const handler = server.getRegisteredTool("create_avatar");
    const result = await handler({});
    expect(result.content[0].text).toContain("Unknown");
  });

  it("returns failure message when operation fails", async () => {
    const failed: CreateAvatarResult = { success: false, error: "scene is locked" };
    bridge.createDefaultAvatar.mockResolvedValue(failed);
    const handler = server.getRegisteredTool("create_avatar");
    const result = await handler({});
    expect(result.content[0].text).toBe("Failed: scene is locked");
  });

  it("calls bridge.createDefaultAvatar with no arguments", async () => {
    bridge.createDefaultAvatar.mockResolvedValue(CREATE_SUCCESS);
    const handler = server.getRegisteredTool("create_avatar");
    await handler({});
    expect(bridge.createDefaultAvatar).toHaveBeenCalledWith();
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.createDefaultAvatar.mockRejectedValue(new Error("CC5 not running"));
    const handler = server.getRegisteredTool("create_avatar");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC5 bridge error: CC5 not running");
  });

  it("returns content with type 'text'", async () => {
    bridge.createDefaultAvatar.mockResolvedValue(CREATE_SUCCESS);
    const handler = server.getRegisteredTool("create_avatar");
    const result = await handler({});
    expect(result.content[0].type).toBe("text");
  });
});

// ── delete_avatar ─────────────────────────────────────────────────────────────

describe("delete_avatar handler", () => {
  it("reports the removed avatar names", async () => {
    bridge.deleteAvatar.mockResolvedValue({ success: true, removed: ["Camila"] });
    const handler = server.getRegisteredTool("delete_avatar");
    const result = await handler({ name: "Camila" });
    expect(result.content[0].text).toBe("Deleted avatar(s): Camila");
  });

  it("deletes all avatars when name is omitted (passes empty string)", async () => {
    bridge.deleteAvatar.mockResolvedValue({ success: true, removed: ["A", "B"] });
    const handler = server.getRegisteredTool("delete_avatar");
    const result = await handler({});
    expect(bridge.deleteAvatar).toHaveBeenCalledWith("");
    expect(result.content[0].text).toBe("Deleted avatar(s): A, B");
  });

  it("returns failure message when avatar not found", async () => {
    bridge.deleteAvatar.mockResolvedValue({ success: false, error: "Avatar not found: X" });
    const handler = server.getRegisteredTool("delete_avatar");
    const result = await handler({ name: "X" });
    expect(result.content[0].text).toBe("Failed: Avatar not found: X");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.deleteAvatar.mockRejectedValue(new Error("CC5 not running"));
    const handler = server.getRegisteredTool("delete_avatar");
    const result = await handler({ name: "Camila" });
    expect(result.content[0].text).toContain("CC5 bridge error: CC5 not running");
  });

  it("shows the plugin's notes, such as the selection it cleared before the delete (F-92)", async () => {
    // Live: CC5 crashed deleting Kevin while his uniform pants were selected (load_asset leaves the loaded item selected).
    const cleared = "CC5's selection (Pants) was cleared before the delete: deleting a character while one of its " +
      "worn items is selected can crash CC5 (F-92).";
    bridge.deleteAvatar.mockResolvedValue({ success: true, removed: ["Kevin"], notes: [cleared] });
    const result = await server.getRegisteredTool("delete_avatar")({ name: "Kevin" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(`Deleted avatar(s): Kevin\n${cleared}`);
  });

  // Review #2 (F-92): delete_avatar fails closed. When CC5's selection could not be read, or held something and could
  // not be cleared, nothing is deleted (cc5_api.DELETE_SELECTION_NOT_CLEARED, DELETE_SELECTION_NOT_READ); the
  // WARNING note of a delete that went ahead anyway is gone.
  it("reports a delete CC5 refused because its selection could not be cleared as an error that deleted nothing (F-92)", async () => {
    const crash = "deleting a character while one of its worn items is selected can crash CC5 (F-92). Run " +
      "clear_selection, then delete again.";
    const notCleared = `CC5's selection (Pants) could not be cleared, so nothing was deleted: ${crash}`;
    const notRead = `CC5's selection could not be read or cleared, so nothing was deleted: ${crash}`;
    for (const error of [notCleared, notRead]) {
      bridge.deleteAvatar.mockResolvedValue({ success: false, error });
      const result = await server.getRegisteredTool("delete_avatar")({ name: "Kevin" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(`Failed: ${error}`);
    }
    // Through the real bridge a refused command is an HTTP 400, and the tool shows CC5's text as it is.
    bridge.deleteAvatar.mockRejectedValue(new BridgeHttpError(notCleared, 400));
    const refused = await server.getRegisteredTool("delete_avatar")({ name: "Kevin" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toBe(notCleared);
    expect(refused.content[0].text).not.toContain("Deleted avatar(s)");
  });
});

// ── capture_viewport ──────────────────────────────────────────────────────────

describe("capture_viewport handler", () => {
  it("returns success message with capture path when path is provided", async () => {
    bridge.captureViewport.mockResolvedValue(CAPTURE_SUCCESS);
    const handler = server.getRegisteredTool("capture_viewport");
    const result = await handler({ output_path: "C:/temp/capture.png" });
    // Handler returns [image, text] when bridge supplies base64 data
    expect(result.content[0].type).toBe("image");
    expect(result.content[1].text).toContain("Viewport captured:");
    expect(result.content[1].text).toContain("C:/temp/capture.png");
  });

  it("returns success message with result.path when no output_path arg given", async () => {
    const captured: CaptureResult = { success: true, path: "/tmp/cc5_snap.png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };
    bridge.captureViewport.mockResolvedValue(captured);
    const handler = server.getRegisteredTool("capture_viewport");
    const result = await handler({});
    // Handler returns [image, text] when bridge supplies base64 data
    expect(result.content[0].type).toBe("image");
    expect(result.content[1].text).toContain("Viewport captured:");
    expect(result.content[1].text).toContain("/tmp/cc5_snap.png");
  });

  it("returns failure message when capture operation fails", async () => {
    const failed: CaptureResult = { success: false, error: "no render context" };
    bridge.captureViewport.mockResolvedValue(failed);
    const handler = server.getRegisteredTool("capture_viewport");
    const result = await handler({});
    expect(result.content[0].text).toBe("Failed: no render context");
  });

  it("rejects path containing '..'", async () => {
    const handler = server.getRegisteredTool("capture_viewport");
    const result = await handler({ output_path: "C:/safe/../../../etc/evil.png" });
    expect(result.content[0].text).toContain("Path traversal");
    expect(bridge.captureViewport).not.toHaveBeenCalled();
  });

  it("rejects non-.png extension", async () => {
    const handler = server.getRegisteredTool("capture_viewport");
    const result = await handler({ output_path: "C:/out/frame.jpg" });
    expect(result.content[0].text).toContain(".png");
    expect(bridge.captureViewport).not.toHaveBeenCalled();
  });

  it("calls bridge.captureViewport with the output path", async () => {
    bridge.captureViewport.mockResolvedValue(CAPTURE_SUCCESS);
    const handler = server.getRegisteredTool("capture_viewport");
    await handler({ output_path: "C:/temp/capture.png" });
    expect(bridge.captureViewport).toHaveBeenCalledWith("C:/temp/capture.png", undefined, undefined);
  });

  it("returns the path and the plugin's warning for a render too large to send, without a desktop screenshot", async () => {
    // Live (F-58): the TypeScript fallback copied a full-screen screenshot over the real render.
    bridge.captureViewport.mockResolvedValue({ success: true, path: "C:/t/cc5_captures/cc5_viewport_1.png",
      warning: "Image too large to embed (35000000 bytes). Read from path directly." });
    const result = await server.getRegisteredTool("capture_viewport")({ width: 7680, height: 4320 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("Viewport captured: C:/t/cc5_captures/cc5_viewport_1.png\n" +
      "Image too large to embed (35000000 bytes). Read from path directly.");
  });

  it("says the image was not sent back when the plugin gives only a path", async () => {
    bridge.captureViewport.mockResolvedValue({ success: true, path: "C:/t/cc5_captures/cc5_viewport_2.png" });
    const result = await server.getRegisteredTool("capture_viewport")({});
    expect(result.content).toEqual([{ type: "text",
      text: "Viewport captured: C:/t/cc5_captures/cc5_viewport_2.png\nThe image was not sent back: open the file." }]);
  });

  it("is an error when CC5 sends neither the image nor its path", async () => {
    bridge.captureViewport.mockResolvedValue({ success: true });
    const result = await server.getRegisteredTool("capture_viewport")({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("CC5 reported a capture but sent neither the image nor its file path.");
  });

  it("shows CC5's own text when no file was written (the plugin answers 400; C2 review)", async () => {
    bridge.captureViewport.mockRejectedValue(new BridgeHttpError("RenderImage did not create file at C:/t/x.png", 400));
    const result = await server.getRegisteredTool("capture_viewport")({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("RenderImage did not create file at C:/t/x.png");
  });

  it("calls bridge.captureViewport with undefined when no path given", async () => {
    const captured: CaptureResult = { success: true, path: "/tmp/snap.png" };
    bridge.captureViewport.mockResolvedValue(captured);
    const handler = server.getRegisteredTool("capture_viewport");
    await handler({});
    expect(bridge.captureViewport).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.captureViewport.mockRejectedValue(new Error("render failed"));
    const handler = server.getRegisteredTool("capture_viewport");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC5 bridge error: render failed");
  });

  it("returns image content followed by text content on success", async () => {
    bridge.captureViewport.mockResolvedValue(CAPTURE_SUCCESS);
    const handler = server.getRegisteredTool("capture_viewport");
    const result = await handler({ output_path: "C:/temp/capture.png" });
    expect(result.content[0].type).toBe("image");
    expect(result.content[1].type).toBe("text");
  });

  // F-104 (live): a capture's undo took back a load CC5 had not finished; the plugin says so in a WARNING note
  // (cc5_api.CAPTURE_UNDO_REDONE).
  const UNDO_REDONE = "WARNING: CC5 had not finished the change before this capture (a load still running), so the " +
    "capture's own undo took that change back; it was put back with a redo (F-104). Check the scene.";

  it("shows every note the plugin returns, each on its own line of the text block beside the image (F-104)", async () => {
    const warning = UNDO_REDONE;
    bridge.captureViewport.mockResolvedValue({ ...CAPTURE_SUCCESS, notes: [warning, "Rendered at 1280x720."] });
    const result = await server.getRegisteredTool("capture_viewport")({ output_path: "C:/temp/capture.png" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "image", data: CAPTURE_SUCCESS.base64, mimeType: "image/png" });
    expect(result.content[1]).toEqual({ type: "text",
      text: `Viewport captured: C:/temp/capture.png\n${warning}\nRendered at 1280x720.` });
  });

  it("shows the notes with a render too large to send, with no path, and with a failure (F-104)", async () => {
    const warning = UNDO_REDONE;
    const handler = server.getRegisteredTool("capture_viewport");
    bridge.captureViewport.mockResolvedValueOnce({ success: true, path: "C:/t/cc5_captures/cc5_viewport_3.png",
      warning: "Image too large to embed (35000000 bytes). Read from path directly.", notes: [warning] });
    expect((await handler({})).content).toEqual([{ type: "text", text: "Viewport captured: " +
      "C:/t/cc5_captures/cc5_viewport_3.png\nImage too large to embed (35000000 bytes). Read from path directly.\n" +
      warning }]);
    bridge.captureViewport.mockResolvedValueOnce({ success: true, notes: [warning] });
    const none = await handler({});
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toBe(`CC5 reported a capture but sent neither the image nor its file path.\n${warning}`);
    bridge.captureViewport.mockResolvedValueOnce({ success: false, error: "RenderImage failed", notes: [warning] });
    const failed = await handler({});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe(`Failed: RenderImage failed\n${warning}`);
  });

  it("says it captures one view only and points fit checks to check_fit (F-44)", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "capture_viewport")?.[1] as string;
    expect(description).toContain("One view only");
    expect(description).toContain("check_fit");
  });
});

// ── set_subdivision_level ─────────────────────────────────────────────────────

describe("set_subdivision_level handler", () => {
  it("returns success message with the level on success", async () => {
    bridge.setSubdivisionLevel.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("set_subdivision_level");
    const result = await handler({ level: 2 });
    expect(result.content[0].text).toBe("Subdivision level set to 2");
  });

  it("returns failure message when operation returns failure", async () => {
    bridge.setSubdivisionLevel.mockResolvedValue(FAILURE);
    const handler = server.getRegisteredTool("set_subdivision_level");
    const result = await handler({ level: 1 });
    expect(result.content[0].text).toBe("Failed: operation failed");
  });

  it("calls bridge.setSubdivisionLevel with the level", async () => {
    bridge.setSubdivisionLevel.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("set_subdivision_level");
    await handler({ level: 0 });
    expect(bridge.setSubdivisionLevel).toHaveBeenCalledWith(0);
  });

  it("works for level 0 (base mesh)", async () => {
    bridge.setSubdivisionLevel.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("set_subdivision_level");
    const result = await handler({ level: 0 });
    expect(result.content[0].text).toBe("Subdivision level set to 0");
  });

  it("works for level 1 (medium)", async () => {
    bridge.setSubdivisionLevel.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("set_subdivision_level");
    const result = await handler({ level: 1 });
    expect(result.content[0].text).toBe("Subdivision level set to 1");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.setSubdivisionLevel.mockRejectedValue(new Error("CC5 crashed"));
    const handler = server.getRegisteredTool("set_subdivision_level");
    const result = await handler({ level: 2 });
    expect(result.content[0].text).toContain("CC5 bridge error: CC5 crashed");
  });
});

describe("scene failures carry isError", () => {
  it("check_cc5_connection: not responding", async () => {
    bridge.healthCheck.mockResolvedValue(false);
    expect((await server.getRegisteredTool("check_cc5_connection")({})).isError).toBe(true);
  });

  it("check_cc5_connection: healthCheck throws", async () => {
    bridge.healthCheck.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await server.getRegisteredTool("check_cc5_connection")({})).isError).toBe(true);
  });

  it("check_cc5_connection: connected is not an error", async () => {
    bridge.healthCheck.mockResolvedValue(true);
    expect((await server.getRegisteredTool("check_cc5_connection")({})).isError).toBeUndefined();
  });

  it("capture_viewport: bad path, success:false, throw", async () => {
    const handler = server.getRegisteredTool("capture_viewport");
    expect((await handler({ output_path: "C:/out/frame.jpg" })).isError).toBe(true);
    bridge.captureViewport.mockResolvedValue({ success: false, error: "no render context" });
    expect((await handler({})).isError).toBe(true);
    bridge.captureViewport.mockRejectedValue(new Error("render failed"));
    expect((await handler({})).isError).toBe(true);
  });

  it("capture_viewport: success is not an error", async () => {
    bridge.captureViewport.mockResolvedValue(CAPTURE_SUCCESS);
    expect((await server.getRegisteredTool("capture_viewport")({ output_path: "C:/temp/capture.png" })).isError).toBeUndefined();
  });
});

describe("check_cc5_connection reports an open dialog (F-23)", () => {
  it("says connected and ready when no dialog is open", async () => {
    bridge.healthCheck.mockResolvedValue(true);
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null });
    const r = await server.getRegisteredTool("check_cc5_connection")({});
    expect(r.content[0].text).toBe("CC5 bridge is connected and ready.");
  });

  it("says commands wait while a CC5 dialog is open", async () => {
    bridge.healthCheck.mockResolvedValue(true);
    bridge.getDialog.mockResolvedValue({ success: true, waiting_job: null,
      dialog: { title: "Character Creator 5", text: "Unsaved project data found.", buttons: ["OK", "Cancel"] } });
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(text).toContain("CC5 bridge is connected.\nBut CC5 has a dialog open");
    expect(text).toContain("Unsaved project data found.");
  });
});

describe("check_cc5_connection does not wait on a busy CC5 (review of F-23)", () => {
  it("asks for the dialog with a short timeout", async () => {
    bridge.healthCheck.mockResolvedValue(true);
    bridge.getDialog.mockRejectedValue(new Error("No reply from CC5 within 3s"));
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(bridge.getDialog).toHaveBeenCalledWith(3000);
    expect(text).toContain("Could not check for an open CC5 dialog within 3 s");
  });
});

describe("check_cc5_connection after the Batch C live check (F-56, F-59)", () => {
  beforeEach(() => bridge.healthCheck.mockResolvedValue(true));

  it("reports a progress window as CC5 being busy, not as a question to answer", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, waiting_job: null,
      dialog: { title: "Exporting", text: "Exporting FBX...", buttons: ["Cancel"], progress: true } });
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(text).toBe('CC5 bridge is connected.\nCC5 is busy: progress window "Exporting" (Exporting FBX...). ' +
      "It closes when the command finishes. Do not cancel it unless the user asks; they cancel it in CC5.");
  });

  it("behind a dialog no MCP command opened: commands fail after about 5 s, and the user is asked first", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, waiting_job: null,
      dialog: { title: "Character Creator 5", text: "Replace?", buttons: ["Replace", "Cancel"], progress: false } });
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(text).toBe("CC5 bridge is connected.\nBut CC5 has a dialog open. Other commands do not run until it is " +
      "closed (they fail after about 5 s):\nCC5 dialog \"Character Creator 5\":\nReplace?\nButtons: Replace, Cancel\n" +
      "No MCP command is waiting on this dialog: it may be the user's own, so ask the user before answering it.");
  });

  it("behind a dialog an MCP command is waiting on: direct commands are cancelled after ~30 s, jobs wait (F-59)", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, waiting_job: "cmd_ab12cd34_7",
      dialog: { title: "Character Creator 5", text: "Replace?", buttons: ["Replace", "Cancel"], progress: false } });
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(text).toBe("CC5 bridge is connected.\nBut CC5 has a dialog open that an MCP command is waiting on. " +
      "Nothing else starts until it is answered: a direct command sent now is cancelled after about 30 s; a job " +
      "(export, import, recipe step) stays queued and runs after the answer. get_cc5_dialog and answer_cc5_dialog " +
      "still work:\nCC5 dialog \"Character Creator 5\":\nReplace?\nButtons: Replace, Cancel\n" +
      "Job cmd_ab12cd34_7 is waiting on this answer; read its result with job_status after answering.");
  });

  // Review #4: for a window with no buttons, the reply offered answer_cc5_dialog and said it waits for an answer, then
  // quoted formatDialog's "no MCP tool can close it".
  it("behind a window with no buttons an MCP command waits in: it is closed in CC5, and answer_cc5_dialog is not offered", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, waiting_job: "cmd_ab12cd34_7",
      dialog: { title: "CCSkinGen", text: "SkinGen 2.0\nS/N : (serial)", buttons: [], progress: false } });
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(text).toBe("CC5 bridge is connected.\nBut CC5 has a window open that an MCP command is waiting on. " +
      "Nothing else starts until it is closed: a direct command sent now is cancelled after about 30 s; a job " +
      "(export, import, recipe step) stays queued and runs once it is closed. get_cc5_dialog still works:\n" +
      'CC5 has a window open with no buttons: "CCSkinGen" - close it in Character Creator 5 (no MCP tool can close ' +
      "it).\nJob cmd_ab12cd34_7 is waiting on this window; read its result with job_status once it is closed.");
    expect(text).not.toContain("answer_cc5_dialog");
    expect(text).not.toContain("S/N");
  });

  it("behind a window whose buttons the bridge cannot read (F-99): it is answered or closed in CC5", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, waiting_job: "cmd_ab12cd34_7",
      dialog: { title: "Export FBX", text: "", buttons: [], progress: false, buttons_unreadable: true } });
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(text).toBe("CC5 bridge is connected.\nBut CC5 has a window open that an MCP command is waiting on. " +
      "Nothing else starts until it is answered or closed in CC5: a direct command sent now is cancelled after about " +
      "30 s; a job (export, import, recipe step) stays queued and runs once it is answered or closed in CC5. " +
      "get_cc5_dialog still works:\nCC5 has a window open whose buttons this bridge cannot read: \"Export FBX\" - " +
      "answer or close it in Character Creator 5 (no MCP tool can click its buttons).\nJob cmd_ab12cd34_7 is waiting " +
      "on this window; read its result with job_status once it is closed.");
    expect(text).not.toContain("answer_cc5_dialog");
  });

  it("behind a window whose text could not be read (review #8): the user answers it in CC5", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, waiting_job: "cmd_ab12cd34_7",
      dialog: { title: "Character Creator 5", text: "", buttons: ["OK", "Cancel"], progress: false, text_read: false } });
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(text).toContain("Nothing else starts until it is answered or closed in CC5:");
    expect(text).toContain("get_cc5_dialog still works:\nCC5 is waiting for an answer to \"Character Creator 5\" - its " +
      "text could not be read, so ask the user to answer it in CC5.");
    expect(text).not.toContain("answer_cc5_dialog");
  });

  it("shows CC5's error when the dialog check is refused, instead of calling CC5 busy (C2 review)", async () => {
    bridge.getDialog.mockRejectedValue(new BridgeHttpError("Unauthorized", 401));
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(text).toBe("CC5 bridge is connected.\n(Could not check for an open CC5 dialog: Unauthorized)");
  });

  it("shows the recovery prompt the plugin answered at startup", async () => {
    bridge.getDialog.mockResolvedValue({ success: true, dialog: null, waiting_job: null,
      recovery_answered: [{ time: "2026-10-05 19:10:05", button: "Cancel", text: "Unsaved project data found." }] });
    const text = (await server.getRegisteredTool("check_cc5_connection")({})).content[0].text as string;
    expect(text).toBe("CC5 bridge is connected and ready.\nWhen CC5 started, its \"Unsaved project data found\" prompt " +
      "was answered Cancel automatically (2026-10-05 19:10:05, local time): the auto-saved changes were discarded.");
  });
});
