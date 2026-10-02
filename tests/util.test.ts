/**
 * Unit tests for the bridgeCall utility.
 */

import { describe, it, expect } from "vitest";
import { bridgeCall, errorResult } from "../src/util.js";
import { BridgeHttpError, BridgeUnreachableError } from "../src/cc5-bridge.js";

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
    const refused = await bridgeCall(() => Promise.reject(new BridgeHttpError("No avatar in scene", 400)), () => "no");
    expect(refused.content[0].text).toBe("CC5 bridge error: No avatar in scene");
    expect(refused.isError).toBe(true);
    const busy = await bridgeCall(() => Promise.reject(new BridgeHttpError(
      "CC5 timed out (still running): CC5 is still working on this command. Check the scene before retrying; the command may still complete.", 504)), () => "no");
    expect(busy.content[0].text).not.toContain("Is CC5 running");
    expect(busy.content[0].text).toContain("still running");
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
