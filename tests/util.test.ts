/**
 * Unit tests for the bridgeCall utility.
 */

import { describe, it, expect } from "vitest";
import { bridgeCall, errorResult } from "../src/util.js";
import { BridgeHttpError, BridgeTimeoutError, BridgeUnreachableError } from "../src/cc5-bridge.js";

describe("bridgeCall", () => {
  it("returns formatted success text when the fn resolves", async () => {
    const result = await bridgeCall(
      () => Promise.resolve("raw value"),
      (v) => `Got: ${v}`
    );
    expect(result.content[0].text).toBe("Got: raw value");
    expect(result.content[0].type).toBe("text");
  });

  it("returns CC5 bridge error text when fn rejects with an Error", async () => {
    const result = await bridgeCall(
      () => Promise.reject(new Error("timeout")),
      () => "should not reach"
    );
    expect(result.content[0].text).toContain("CC5 bridge error: timeout");
  });

  it("asks whether CC5 is running only when CC5 could not be reached", async () => {
    const down = await bridgeCall(() => Promise.reject(new BridgeUnreachableError("fetch failed (connect ECONNREFUSED 127.0.0.1:5101)")), () => "no");
    expect(down.content[0].text).toBe(
      "CC5 bridge error: fetch failed (connect ECONNREFUSED 127.0.0.1:5101). Is CC5 running with the MCP Bridge plugin?");
    // C2 (F-21): CC5's own refusal (400), a dialog wait (409) and a timeout (504) keep CC5's text; only transport
    // problems say "CC5 bridge error".
    const refused = await bridgeCall(() => Promise.reject(new BridgeHttpError("No avatar in scene", 400)), () => "no");
    expect(refused.content[0].text).toBe("No avatar in scene");
    expect(refused.isError).toBe(true);
    const waiting = await bridgeCall(() => Promise.reject(new BridgeHttpError(
      'CC5 is waiting for an answer to "Replace?". The command is still running as job cmd_1.', 409)), () => "no");
    expect(waiting.content[0].text).toBe('CC5 is waiting for an answer to "Replace?". The command is still running as job cmd_1.');
    const forbidden = await bridgeCall(() => Promise.reject(new BridgeHttpError("Forbidden", 403)), () => "no");
    expect(forbidden.content[0].text).toBe("CC5 bridge error: Forbidden");
    const busy = await bridgeCall(() => Promise.reject(new BridgeHttpError(
      "CC5 timed out (still running): CC5 is still working on this command. Check the scene before retrying; the command may still complete.", 504)), () => "no");
    expect(busy.content[0].text).not.toContain("Is CC5 running");
    expect(busy.content[0].text).toContain("still running");
  });

  it("keeps CC5's text for a 504, whether the command still runs or was cancelled (C2 review)", async () => {
    const running = "CC5 timed out (still running): CC5 is still working on this command. Check the scene before " +
      "retrying; the command may still complete.";
    const cancelled = "CC5 timed out (cancelled): Timed out before CC5 started the command; it was cancelled and will not run.";
    for (const text of [running, cancelled]) {
      const r = await bridgeCall(() => Promise.reject(new BridgeHttpError(text, 504)), () => "no");
      expect(r.content[0].text).toBe(text);
      expect(r.isError).toBe(true);
    }
  });

  it("shows a client-side timeout as it is, not as a connection fault (C2 review)", async () => {
    const text = "No reply from CC5 within 35s. CC5 may still be running this command; check the scene " +
      "(list_avatars / capture_viewport) before retrying.";
    const r = await bridgeCall(() => Promise.reject(new BridgeTimeoutError(text)), () => "no");
    expect(r.content[0].text).toBe(text);
    expect(r.isError).toBe(true);
  });

  it("puts one period before the question when the message already ends with one", async () => {
    const r = await bridgeCall(() => Promise.reject(new BridgeUnreachableError("fetch failed.")), () => "no");
    expect(r.content[0].text).toBe("CC5 bridge error: fetch failed. Is CC5 running with the MCP Bridge plugin?");
  });

  it("returns CC5 bridge error text when fn rejects with a string", async () => {
    const result = await bridgeCall(
      () => Promise.reject("plain string error"),
      () => "should not reach"
    );
    expect(result.content[0].text).toContain("CC5 bridge error: plain string error");
  });

  it("returns a single content item", async () => {
    const result = await bridgeCall(
      () => Promise.resolve(42),
      (v) => `Value is ${v}`
    );
    expect(result.content).toHaveLength(1);
  });

  it("does not call formatSuccess when fn rejects", async () => {
    let called = false;
    await bridgeCall(
      () => Promise.reject(new Error("err")),
      () => { called = true; return "text"; }
    );
    expect(called).toBe(false);
  });

  it("passes the resolved value to formatSuccess", async () => {
    const data = { id: "av1", name: "Hero" };
    const result = await bridgeCall(
      () => Promise.resolve(data),
      (v) => `Avatar: ${v.name}`
    );
    expect(result.content[0].text).toBe("Avatar: Hero");
  });

  it("handles null as a successful resolved value", async () => {
    const result = await bridgeCall(
      () => Promise.resolve(null),
      (v) => (v === null ? "no value" : "has value")
    );
    expect(result.content[0].text).toBe("no value");
  });

  it("returns content array with type as literal 'text'", async () => {
    const result = await bridgeCall(
      () => Promise.resolve("ok"),
      (v) => v
    );
    expect(result.content[0].type).toBe("text");
  });
});

describe("bridgeCall isError", () => {
  it("flags thrown errors", async () => {
    const r = await bridgeCall(() => Promise.reject(new Error("x")), () => "no");
    expect(r.isError).toBe(true);
  });

  it("flags success:false results", async () => {
    const r = await bridgeCall(() => Promise.resolve({ success: false, error: "bad" }), (v) => `Failed: ${v.error}`);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("Failed: bad");
  });

  it("does not flag successes", async () => {
    const r = await bridgeCall(() => Promise.resolve({ success: true }), () => "ok");
    expect(r.isError).toBeUndefined();
  });
});

describe("errorResult", () => {
  it("wraps text as an error", () => {
    expect(errorResult("nope")).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
  });
});
