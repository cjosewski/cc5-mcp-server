/**
 * The protocol rules Chad set (src/prompts/content-rules.ts): the MCP server instructions carry every rule, stay under
 * the about 2,000 characters Claude Code shows, and reach a real MCP client.
 */

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BATCH_RULE, BUILD_RULE, CANCEL_NOT_CARRIED, FIT_RULE, LAYER_RULE, LAYER_STOP_ADVICE, NOT_A_CHECK, PICK_RULE, PRESET_RULE,
  SERVER_INSTRUCTIONS, STORE_HINT, STORE_RULE,
} from "../../src/prompts/content-rules.js";
import { LAYER_EXPECT } from "../../src/build-session.js";

describe("content rules", () => {
  it("the server instructions hold every rule, one per line, under 2,000 characters", () => {
    expect(SERVER_INSTRUCTIONS.split("\n")).toEqual([
      "Rules for every Character Creator 5 (CC5) session:",
      `- ${PICK_RULE}`, `- ${STORE_RULE}`, `- ${PRESET_RULE}`, `- ${FIT_RULE}`, `- ${BUILD_RULE}`, `- ${NOT_A_CHECK}`,
    ]);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2000);
  });

  it("the build rule carries the answering rule and the layer rule (D1, D3)", () => {
    expect(BUILD_RULE).toContain("plain confirmation");
    expect(BUILD_RULE).toContain("real choice");
    expect(BUILD_RULE).toContain("run nothing else until it is answered");
    expect(BUILD_RULE.endsWith(LAYER_RULE)).toBe(true);
    expect(LAYER_RULE).toContain("no standing answer");
  });

  it("the layer stop advice expects the words of CC5's question", () => {
    expect(LAYER_STOP_ADVICE).toContain(LAYER_EXPECT);
    expect(LAYER_STOP_ADVICE).toContain("answer_cc5_dialog");
    expect(LAYER_STOP_ADVICE).toContain("layer_answer");
  });

  // RB-6: layer_answer takes only Replace and Material Only, so following the advice after a Cancel failed in the SDK.
  it("the layer stop advice says how to go on after a Cancel, and never carries one", () => {
    expect(CANCEL_NOT_CARRIED).toBe("If the user picked Cancel, go on with continue_after and no layer_answer: a Cancel " +
      "is not carried, and the next identical question goes to the user again.");
    expect(LAYER_STOP_ADVICE.endsWith(CANCEL_NOT_CARRIED)).toBe(true);
    expect(LAYER_STOP_ADVICE).toContain("Unless the user already chose Replace or Material Only for this character");
    expect(LAYER_STOP_ADVICE).not.toMatch(/with Cancel/);
    // The server instructions carry the user's choice to later questions of the build, but never a Cancel (DEC-7).
    expect(LAYER_RULE).toContain("answer later ones in that build with that choice (not a Cancel) and say so");
    expect(SERVER_INSTRUCTIONS).toContain(LAYER_RULE);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2000);
  });

  it("the store rule and hint only suggest: the user decides and buys (I-02)", () => {
    expect(STORE_RULE).toContain("Only suggest: the user decides");
    expect(STORE_HINT).toContain("the user decides and buys");
    expect(BATCH_RULE).toContain("first build one variant with apply_character_recipe");
  });

  it("reach an MCP client as the server instructions", async () => {
    const server = new McpServer({ name: "cc5-test", version: "0.0.0" }, { instructions: SERVER_INSTRUCTIONS });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await client.close();
    }
  });
});
