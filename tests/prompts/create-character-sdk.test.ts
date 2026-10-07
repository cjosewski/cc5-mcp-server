/**
 * The create_character prompt through the real MCP SDK (McpServer + Client over an in-memory transport): the optional
 * description argument as a client lists it, and the text getPrompt returns for no description, an empty one, the one
 * word Claude Code passed in F-71, and a whole description.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCreateCharacterPrompt } from "../../src/prompts/create-character.js";

let client: Client;

beforeEach(async () => {
  const server = new McpServer({ name: "cc5-test", version: "0.0.0" });
  registerCreateCharacterPrompt(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await client.close();
});

/** The text of the one user message create_character returns for these arguments. */
async function promptText(args: Record<string, string>): Promise<string> {
  const r = await client.getPrompt({ name: "create_character", arguments: args });
  expect(r.messages).toHaveLength(1);
  const [message] = r.messages;
  expect(message.role).toBe("user");
  if (message.content.type !== "text") throw new Error(`expected a text message, got ${message.content.type}`);
  return message.content.text;
}

describe("create_character over the MCP SDK", () => {
  it("lists one optional description argument", async () => {
    const { prompts } = await client.listPrompts();
    const prompt = prompts.find((p) => p.name === "create_character");
    expect(prompt).toBeDefined();
    expect(prompt?.arguments?.map(({ name, required }) => ({ name, required }))).toEqual([{ name: "description", required: false }]);
    expect(prompt?.description).toContain("stage by stage");
    // I-08: any character, exported where the user wants it, not only a patient for Unity.
    expect(prompt?.description).toContain("Unity, Unreal, Blender or another tool");
    expect(prompt?.description).not.toMatch(/patient/i);
    expect(prompt?.arguments?.[0].description).toContain("any injuries or special looks");
    expect(prompt?.arguments?.[0].description).not.toMatch(/patient/i);
  });

  it("asks for the description when none or an empty one arrives", async () => {
    const cases: Array<Record<string, string>> = [{}, { description: "" }];
    for (const args of cases) {
      expect(await promptText(args)).toContain("First ask me for the character description");
    }
  });

  it("flags the one word Claude Code passed as cut off (F-71)", async () => {
    expect(await promptText({ description: '"Adult' })).toContain("Only one word arrived");
  });

  it("restates a whole description as it arrived", async () => {
    expect(await promptText({ description: "Adult male soldier, about 30" }))
      .toContain('Character description, as this prompt received it: "Adult male soldier, about 30"');
  });
});
