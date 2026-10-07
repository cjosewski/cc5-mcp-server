/**
 * Unit tests for registerExpressionTools.
 * Tool handlers use bridgeCall, so bridge errors become content text responses
 * rather than thrown exceptions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BridgeUnreachableError } from "../../src/cc5-bridge.js";
import { registerExpressionTools, setExpressionAgainLine } from "../../src/tools/expression.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import type { MockBridge } from "../helpers/mock-bridge.js";
import type { ExpressionInfo, ExpressionSetResult, ExpressionResetResult } from "../../src/types.js";
import { createMockServer } from "../helpers/mock-server.js";

// ── setup ─────────────────────────────────────────────────────────────────────

let bridge: MockBridge;
let server: ReturnType<typeof createMockServer>;

beforeEach(() => {
  bridge = createMockBridge();
  server = createMockServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerExpressionTools(server as any, bridge as any);
});

// ── tool registration ─────────────────────────────────────────────────────────

describe("registerExpressionTools – registration", () => {
  it("registers exactly 3 tools", () => {
    expect(server.tool).toHaveBeenCalledTimes(3);
  });

  it("registers get_expression_info", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "get_expression_info",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers set_expression", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "set_expression",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });

  it("registers reset_expression", () => {
    expect(server.tool).toHaveBeenCalledWith(
      "reset_expression",
      expect.any(String),
      expect.any(Object),
      expect.any(Function)
    );
  });
});

// ── get_expression_info ───────────────────────────────────────────────────────

describe("get_expression_info handler", () => {
  it("returns group count and expression names on success", async () => {
    const info: ExpressionInfo = {
      Smile: ["Happy", "Grin"],
      Sad: ["Frown", "Sulk"],
    };
    bridge.getExpressionInfo.mockResolvedValue(info);
    const handler = server.getRegisteredTool("get_expression_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("Expression groups (2)");
    expect(result.content[0].text).toContain("Smile");
    expect(result.content[0].text).toContain("Happy");
    expect(result.content[0].text).toContain("Sad");
  });

  it("lists individual expression names under their group", async () => {
    const info: ExpressionInfo = {
      Eyes: ["Blink", "Squint", "Wide"],
    };
    bridge.getExpressionInfo.mockResolvedValue(info);
    const handler = server.getRegisteredTool("get_expression_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("- Blink");
    expect(result.content[0].text).toContain("- Squint");
    expect(result.content[0].text).toContain("- Wide");
  });

  it("returns no-data message when expression info is empty", async () => {
    const info: ExpressionInfo = {};
    bridge.getExpressionInfo.mockResolvedValue(info);
    const handler = server.getRegisteredTool("get_expression_info");
    const result = await handler({});
    expect(result.content[0].text).toBe("No expression data available.");
  });

  it("returns content with type 'text'", async () => {
    const info: ExpressionInfo = { Smile: ["Happy"] };
    bridge.getExpressionInfo.mockResolvedValue(info);
    const handler = server.getRegisteredTool("get_expression_info");
    const result = await handler({});
    expect(result.content[0].type).toBe("text");
  });

  it("calls bridge.getExpressionInfo with no arguments", async () => {
    bridge.getExpressionInfo.mockResolvedValue({});
    const handler = server.getRegisteredTool("get_expression_info");
    await handler({});
    expect(bridge.getExpressionInfo).toHaveBeenCalledWith();
  });

  it("handles a single group with multiple expressions", async () => {
    const info: ExpressionInfo = {
      Mouth: ["Open", "Smile", "Pucker", "Teeth"],
    };
    bridge.getExpressionInfo.mockResolvedValue(info);
    const handler = server.getRegisteredTool("get_expression_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("Expression groups (1)");
    expect(result.content[0].text).toContain("Mouth (4)");
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.getExpressionInfo.mockRejectedValue(new BridgeUnreachableError("bridge down"));
    const handler = server.getRegisteredTool("get_expression_info");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC5 bridge error: bridge down");
    expect(result.content[0].text).toContain("Is CC5 running");
  });
});

// ── set_expression ────────────────────────────────────────────────────────────

describe("set_expression handler", () => {
  it("reports applied sliders on success", async () => {
    const r: ExpressionSetResult = {
      success: true,
      applied: [{ name: "Brow_Raise_Inner_L", weight: 0.8 }],
      skipped: [],
    };
    bridge.setExpression.mockResolvedValue(r);
    const handler = server.getRegisteredTool("set_expression");
    const result = await handler({ expressions: [{ name: "Brow_Raise_Inner_L", weight: 0.8 }] });
    expect(result.content[0].text).toContain("Set 1 expression slider(s)");
    expect(result.content[0].text).toContain("Brow_Raise_Inner_L = 0.8");
  });

  it("reports skipped unknown names", async () => {
    const r: ExpressionSetResult = {
      success: true,
      applied: [{ name: "Smile_L", weight: 1 }],
      skipped: ["Bogus"],
    };
    bridge.setExpression.mockResolvedValue(r);
    const handler = server.getRegisteredTool("set_expression");
    const result = await handler({ expressions: [{ name: "Smile_L", weight: 1 }, { name: "Bogus", weight: 1 }] });
    expect(result.content[0].text).toContain("Skipped (unknown): Bogus");
  });

  it("returns failure message when nothing valid was set", async () => {
    const r: ExpressionSetResult = { success: false, error: "No valid expression names", skipped: ["Nope"] };
    bridge.setExpression.mockResolvedValue(r);
    const handler = server.getRegisteredTool("set_expression");
    const result = await handler({ expressions: [{ name: "Nope", weight: 1 }] });
    expect(result.content[0].text).toContain("Failed: No valid expression names");
    expect(result.content[0].text).toContain("skipped: Nope");
  });

  it("calls bridge.setExpression with the expression list", async () => {
    const r: ExpressionSetResult = { success: true, applied: [{ name: "Smile_L", weight: 0.5 }], skipped: [] };
    bridge.setExpression.mockResolvedValue(r);
    const handler = server.getRegisteredTool("set_expression");
    await handler({ expressions: [{ name: "Smile_L", weight: 0.5 }] });
    expect(bridge.setExpression).toHaveBeenCalledWith([{ name: "Smile_L", weight: 0.5 }]);
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.setExpression.mockRejectedValue(new Error("bridge down"));
    const handler = server.getRegisteredTool("set_expression");
    const result = await handler({ expressions: [{ name: "Smile_L", weight: 1 }] });
    expect(result.content[0].text).toContain("CC5 bridge error: bridge down");
  });
});

// ── reset_expression ──────────────────────────────────────────────────────────

describe("reset_expression handler", () => {
  it("reports the number of sliders reset", async () => {
    const r: ExpressionResetResult = { success: true, reset_count: 128 };
    bridge.resetExpression.mockResolvedValue(r);
    const handler = server.getRegisteredTool("reset_expression");
    const result = await handler({});
    expect(result.content[0].text).toBe("Reset 128 expression slider(s) to neutral.");
  });

  it("returns failure message when no avatar", async () => {
    const r: ExpressionResetResult = { success: false, error: "No avatar" };
    bridge.resetExpression.mockResolvedValue(r);
    const handler = server.getRegisteredTool("reset_expression");
    const result = await handler({});
    expect(result.content[0].text).toBe("Failed: No avatar");
  });

  it("calls bridge.resetExpression with no arguments", async () => {
    bridge.resetExpression.mockResolvedValue({ success: true, reset_count: 0 });
    const handler = server.getRegisteredTool("reset_expression");
    await handler({});
    expect(bridge.resetExpression).toHaveBeenCalledWith();
  });

  it("returns bridge error text when bridge throws (does not propagate)", async () => {
    bridge.resetExpression.mockRejectedValue(new Error("bridge down"));
    const handler = server.getRegisteredTool("reset_expression");
    const result = await handler({});
    expect(result.content[0].text).toContain("CC5 bridge error: bridge down");
  });
});

describe("reset_expression reports the sliders it changed (F-18)", () => {
  it("names the sliders that were set", async () => {
    bridge.resetExpression.mockResolvedValue({ success: true, reset_count: 2, reset: ["Brow_Raise_Inner_L", "Mouth_Smile"], slider_count: 172 });
    const r = await server.getRegisteredTool("reset_expression")({});
    expect(r.content[0].text).toBe("Reset 2 expression slider(s) to neutral: Brow_Raise_Inner_L, Mouth_Smile.");
  });

  it("says when the face was already neutral", async () => {
    bridge.resetExpression.mockResolvedValue({ success: true, reset_count: 0, reset: [], slider_count: 172 });
    const r = await server.getRegisteredTool("reset_expression")({});
    expect(r.content[0].text).toBe("The face was already neutral: no expression slider was set.");
  });
});

// Review #5 (F-88): the OBJ round trip needs a neutral face and the expression set again afterwards, but no reply gave
// the weights of more than three sliders, so the rest of the expression was lost (live case: six sliders).
describe("reset_expression gives every weight it reset, to set the expression again (review #5)", () => {
  const SIX = ["Brow_Compress_L", "Brow_Compress_R", "Eye_Squint_L", "Eye_Squint_R", "Mouth_Frown_L", "Mouth_Frown_R"];

  it("adds one ready set_expression line with each slider's weight", async () => {
    bridge.resetExpression.mockResolvedValue({ success: true, reset_count: 6, reset: SIX, slider_count: 172,
      reset_weights: { Brow_Compress_L: 0.6, Brow_Compress_R: 0.6, Eye_Squint_L: 0.3, Eye_Squint_R: 0.3,
        Mouth_Frown_L: 0.4, Mouth_Frown_R: 0.4 } });
    const r = await server.getRegisteredTool("reset_expression")({});
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("Reset 6 expression slider(s) to neutral: Brow_Compress_L, Brow_Compress_R, " +
      "Eye_Squint_L, Eye_Squint_R, Mouth_Frown_L, Mouth_Frown_R.\nTo set the expression again: set_expression with " +
      "Brow_Compress_L 0.6, Brow_Compress_R 0.6, Eye_Squint_L 0.3, Eye_Squint_R 0.3, Mouth_Frown_L 0.4, Mouth_Frown_R 0.4");
  });

  it("lists every weight also past the 50 names the reply names, rounded to 4 decimals at most", async () => {
    const names = Array.from({ length: 52 }, (_, i) => `Slider_${i}`);
    bridge.resetExpression.mockResolvedValue({ success: true, reset_count: 52, reset: names.slice(0, 50), slider_count: 172,
      reset_weights: Object.fromEntries(names.map((n) => [n, 0.30000001192092896])) });
    const text = (await server.getRegisteredTool("reset_expression")({})).content[0].text;
    const [first, again] = text.split("\n");
    expect(first.endsWith("Slider_49, ....")).toBe(true);
    expect(again).toBe(`To set the expression again: set_expression with ${names.map((n) => `${n} 0.3`).join(", ")}`);
  });

  it("adds no line for an older plugin, a neutral face, or weights that are not numbers", async () => {
    const replies: Array<[Record<string, unknown>, string]> = [
      [{ success: true, reset_count: 2, reset: ["A", "B"], slider_count: 172 }, "Reset 2 expression slider(s) to neutral: A, B."],
      [{ success: true, reset_count: 0, reset: [], slider_count: 172, reset_weights: {} },
        "The face was already neutral: no expression slider was set."],
      [{ success: true, reset_count: 1, reset: ["A"], slider_count: 172, reset_weights: { A: "0.5" } },
        "Reset 1 expression slider(s) to neutral: A."],
      [{ success: true, reset_count: 128 }, "Reset 128 expression slider(s) to neutral."],
    ];
    for (const [result, text] of replies) {
      bridge.resetExpression.mockResolvedValue(result);
      expect((await server.getRegisteredTool("reset_expression")({})).content[0].text).toBe(text);
    }
  });

  it("setExpressionAgainLine reads only the field it is given, and skips entries that are not finite numbers", () => {
    const result = { reset_weights: { A: 0.5, B: Number.NaN, C: 1 }, expression_weights: { D: 0.25 } };
    expect(setExpressionAgainLine(result, "reset_weights")).toBe("To set the expression again: set_expression with A 0.5, C 1");
    expect(setExpressionAgainLine(result, "expression_weights")).toBe("To set the expression again: set_expression with D 0.25");
    for (const bad of [null, undefined, "x", 3, { reset_weights: [0.5] }, { reset_weights: null }]) {
      expect(setExpressionAgainLine(bad, "reset_weights")).toBeUndefined();
    }
  });
});
