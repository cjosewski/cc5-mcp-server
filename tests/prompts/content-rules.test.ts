/**
 * The protocol rules Chad set (src/prompts/content-rules.ts): the MCP server instructions carry every rule, stay at or
 * under the about 2,000 characters Claude Code shows, and reach a real MCP client; F-91's SkinGen session and question.
 */

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BATCH_RULE, BUILD_RULE, CANCEL_NOT_CARRIED, FIT_RULE, LAYER_RULE, LAYER_STOP_ADVICE, NOT_A_CHECK, PICK_RULE, PRESET_RULE,
  SERVER_INSTRUCTIONS, SKINGEN_QUESTION, SKINGEN_QUESTION_RULE, STORE_HINT, STORE_RULE,
} from "../../src/prompts/content-rules.js";
import { LAYER_EXPECT } from "../../src/build-session.js";

describe("content rules", () => {
  it("the server instructions hold every rule, one per line, at most 2,000 characters", () => {
    expect(SERVER_INSTRUCTIONS.split("\n")).toEqual([
      "Rules for every Character Creator 5 (CC5) session:",
      `- ${PICK_RULE}`, `- ${STORE_RULE}`, `- ${PRESET_RULE}`, `- ${FIT_RULE}`, `- ${BUILD_RULE}`, `- ${NOT_A_CHECK}`,
    ]);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
  });

  // F-91 (live CC5 5.13, 2026-10-07): the lip makeup preset that "hid hair and brows" (F-34) had started a SkinGen
  // session, which hides clothing too until a content load or a delete ends it (batch F review #13).
  it("the preset rule names the SkinGen session and claims only what was seen (F-91)", () => {
    expect(PRESET_RULE).toBe("Presets and clothing can change more than they are named for (live: uniform pants " +
      "removed the Boxers; a SkinGen or makeup preset hid hair, brows and clothing until a content load or a delete " +
      "ended its SkinGen session). Every character-content load is compared before and after: show the user its " +
      "CHECK and NOT CHECKED lines with captures and offer undo before the next change.");
    // After that preset the skin colour read back unchanged (F-91), so the rule no longer says it reset the colour.
    expect(PRESET_RULE).not.toContain("skin colour");
    expect(PRESET_RULE).not.toContain("lip makeup preset hid hair and brows");
    // Batch F review #13: deleting a prop ended a session too (no question): a content load is not the only end.
    expect(PRESET_RULE).not.toContain("until a content load ends");
    // The server instructions carry it (Claude Code shows about 2,000 characters of them).
    expect(SERVER_INSTRUCTIONS).toContain(`\n- ${PRESET_RULE}\n`);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
  });

  it("CC5's SkinGen question is a plain confirmation for a load the user asked for (F-91)", () => {
    expect(SKINGEN_QUESTION).toBe("Applying this content will deactivate the current SkinGen session. Would you like " +
      "to continue?");
    expect(SKINGEN_QUESTION_RULE).toBe(`CC5 can ask "${SKINGEN_QUESTION}" when content is loaded during a SkinGen ` +
      "session (seen for a prop load). A SkinGen or makeup preset starts one; until a later content load or a " +
      "delete ends it, the viewport hides hair, brows and clothing (live: deleting a prop ended one without a " +
      "question). For a load the user asked for, the question is a plain confirmation: answer OK and say so; OK " +
      "ends the session (the makeup stays) and the load goes on.");
    // It goes with the dialog tools, not into the server instructions, which have no room for it.
    expect(SERVER_INSTRUCTIONS).not.toContain(SKINGEN_QUESTION);
  });

  // Batch F review #13: only a prop load was seen asking (another SkinGen preset is not tested), and deleting a prop
  // ended a session without a question; the rule said CC5 asks at every content load during a session.
  it("the SkinGen question rule says a content load can ask, and that a delete ends the session too (F-91)", () => {
    expect(SKINGEN_QUESTION_RULE).not.toMatch(/^CC5 asks /);
    expect(SKINGEN_QUESTION_RULE).toContain(`CC5 can ask "${SKINGEN_QUESTION}"`);
    expect(SKINGEN_QUESTION_RULE).toContain("(seen for a prop load)");
    expect(SKINGEN_QUESTION_RULE).toContain("until a later content load or a delete ends it");
    expect(SKINGEN_QUESTION_RULE).toContain("(live: deleting a prop ended one without a question)");
    // One line: the replies put it on a line of its own after the question (formatDialog, withSkinGenRule).
    expect(SKINGEN_QUESTION_RULE).not.toContain("\n");
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
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2000);
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
