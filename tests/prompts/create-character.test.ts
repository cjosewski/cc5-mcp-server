import { describe, it, expect, vi } from "vitest";
import { registerCreateCharacterPrompt, buildCreateCharacterPrompt } from "../../src/prompts/create-character.js";

describe("create_character prompt", () => {
  it("embeds the description and the workflow", () => {
    const text = buildCreateCharacterPrompt("50-year-old male, heavy build, blast injury to left arm");
    expect(text).toContain("blast injury to left arm");
    expect(text).toContain("search_content");
    expect(text).toContain("apply_character_recipe");
    expect(text).toContain("check_quest_budget");
  });

  it("registers with the server", () => {
    const server = { prompt: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCreateCharacterPrompt(server as any);
    expect(server.prompt).toHaveBeenCalledWith("create_character", expect.any(String), expect.any(Object), expect.any(Function));
  });
});
