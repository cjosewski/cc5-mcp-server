import { describe, it, expect, vi } from "vitest";
import { registerCreateCharacterPrompt, buildCreateCharacterPrompt } from "../../src/prompts/create-character.js";
import { RecipeSchema } from "../../src/recipe.js";

describe("create_character prompt", () => {
  it("embeds the description and the workflow", () => {
    const text = buildCreateCharacterPrompt("50-year-old male, heavy build, blast injury to left arm");
    expect(text).toContain("blast injury to left arm");
    expect(text).toContain("search_content");
    expect(text).toContain("apply_character_recipe");
    expect(text).toContain("check_quest_budget");
  });

  it("starts an empty scene from a textured template, not CC5's bald, untextured 'default' mannequin", () => {
    const step1 = buildCreateCharacterPrompt("40-year-old woman").split("\n").find((l) => l.startsWith("1. "));
    expect(step1).toContain("browse_content('character')");
    expect(step1).toContain("Do not use base 'default'");
    expect(step1).not.toMatch(/base will be 'default'/);
  });

  it("asks for overlay images instead of pointing at image_layer content (live CC5 lists only .iImgLayer files there)", () => {
    const step5 = buildCreateCharacterPrompt("40-year-old woman").split("\n").find((l) => l.startsWith("5. "));
    expect(step5).toContain("PNG/JPG/TGA");
    expect(step5).not.toContain("image_layer");
    expect(buildCreateCharacterPrompt("x")).not.toContain("image_layer");
  });

  // Chad's ruling (2026-10-03): headshot_from_photo is switched off, so the prompt must not suggest it.
  it("does not suggest a headshot", () => {
    expect(buildCreateCharacterPrompt("40-year-old woman, photo attached").toLowerCase()).not.toContain("headshot");
  });

  it("warns in the recipe schema that 'default' is a mannequin", () => {
    expect(RecipeSchema.shape.base.description).toContain("mannequin");
    expect(RecipeSchema.shape.base.description).toContain("browse_content('character')");
  });

  it("registers with the server", () => {
    const server = { prompt: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCreateCharacterPrompt(server as any);
    expect(server.prompt).toHaveBeenCalledWith("create_character", expect.any(String), expect.any(Object), expect.any(Function));
  });
});
