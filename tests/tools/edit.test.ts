/**
 * Unit tests for registerEditTools.
 * Tool handlers use bridgeCall, so bridge errors become content text responses
 * rather than thrown exceptions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { registerEditTools } from "../../src/tools/edit.js";
import { createMockBridge, SUCCESS, FAILURE } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

// ── setup ─────────────────────────────────────────────────────────────────────

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerEditTools(server as any, bridge as any);
});

// ── tool registration ─────────────────────────────────────────────────────────

describe("registerEditTools – registration", () => {
  it("registers exactly 2 tools", () => {
    expect(server.tool).toHaveBeenCalledTimes(2);
  });

  it("registers undo", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "undo",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers redo", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "redo",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });
});

// ── undo ──────────────────────────────────────────────────────────────────────

describe("undo handler", () => {
  it("returns success message when undo succeeds", async () => {
    bridge.undo.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("undo");
    const result = await handler({});
    expect(result.content[0].text).toBe("Undo successful");
  });

  it("returns failure message when undo returns failure result", async () => {
    bridge.undo.mockResolvedValue(FAILURE);
    const handler = server.getRegisteredTool("undo");
    const result = await handler({});
    expect(result.content[0].text).toBe("Undo failed: operation failed");
  });

  it("calls bridge.undo with no arguments", async () => {
    bridge.undo.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("undo");
    await handler({});
    expect(bridge.undo).toHaveBeenCalledWith();
  });

  it("returns content with type 'text'", async () => {
    bridge.undo.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("undo");
    const result = await handler({});
    expect(result.content[0].type).toBe("text");
  });

  it("returns bridge error text when bridge.undo throws (does not propagate)", async () => {
    bridge.undo.mockRejectedValue(new BridgeUnreachableError("bridge down"));
    const handler = server.getRegisteredTool("undo");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC5 bridge error: bridge down");
    expect(result.content[0].text).toContain("Is CC5 running");
  });

  // F-89 (live CC5 5.13, corrects F-86): an FBX export does not clear CC5's undo history. Only a light's intensity
  // change made before an export was not undone (and undo said it succeeded); morph and skin changes undid normally.
  it("names the one change an undo did not take back after an FBX export, keeping the rest of its description", () => {
    const description = server.tool.mock.calls.find((c) => c[0] === "undo")?.[1] as string;
    expect(description).toContain("Live (CC5 5.13): after an FBX export, an undo did not take back a light's intensity " +
      "change made before the export, and still reported success; morph and skin changes undo normally across exports.");
    expect(description).not.toContain("undo history");
    expect(description).not.toContain("nothing done before it can be undone");
    expect(description).toContain("CC5 does not say when nothing is left to undo (this still reports success)");
    expect(description).toContain("after a viewport capture, an extra undo lets a later redo replay the capture instead " +
      "of the change.");
  });
});

// ── redo ──────────────────────────────────────────────────────────────────────

describe("redo handler", () => {
  it("returns success message when redo succeeds", async () => {
    bridge.redo.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("redo");
    const result = await handler({});
    expect(result.content[0].text).toBe("Redo successful");
  });

  it("returns failure message when redo returns failure result", async () => {
    bridge.redo.mockResolvedValue(FAILURE);
    const handler = server.getRegisteredTool("redo");
    const result = await handler({});
    expect(result.content[0].text).toBe("Redo failed: operation failed");
  });

  it("calls bridge.redo with no arguments", async () => {
    bridge.redo.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("redo");
    await handler({});
    expect(bridge.redo).toHaveBeenCalledWith();
  });

  it("returns content with type 'text'", async () => {
    bridge.redo.mockResolvedValue(SUCCESS);
    const handler = server.getRegisteredTool("redo");
    const result = await handler({});
    expect(result.content[0].type).toBe("text");
  });

  it("returns bridge error text when bridge.redo throws (does not propagate)", async () => {
    bridge.redo.mockRejectedValue(new BridgeUnreachableError("network error"));
    const handler = server.getRegisteredTool("redo");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC5 bridge error: network error");
    expect(result.content[0].text).toContain("Is CC5 running");
  });
});
