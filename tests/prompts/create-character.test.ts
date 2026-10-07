import { describe, it, expect, vi } from "vitest";
import { registerCreateCharacterPrompt, buildCreateCharacterPrompt } from "../../src/prompts/create-character.js";
import { RecipeSchema } from "../../src/recipe.js";
import { LAYER_EXPECT } from "../../src/build-session.js";
import { IMAGE_TYPES_TEXT } from "../../src/tools/pipeline.js";
import { INJURY_CHOICES } from "../../src/tools/unity.js";
import { FIT_DEFAULT_VIEWS } from "../../src/tools/fit.js";

const DESCRIPTION = "50-year-old male, heavy build, blast injury to left arm";
const PROMPT = buildCreateCharacterPrompt(DESCRIPTION);

/** The prompt line that starts with "<n>. " (a numbered step). */
function line(n: number, text = PROMPT): string {
  const found = text.split("\n").find((l) => l.startsWith(`${n}. `));
  if (found === undefined) throw new Error(`the prompt has no step ${n}`);
  return found;
}

/** The rule line that starts with "- <name>:". */
function rule(name: string, text = PROMPT): string {
  const found = text.split("\n").find((l) => l.startsWith(`- ${name}:`));
  if (found === undefined) throw new Error(`the prompt has no rule '${name}'`);
  return found;
}

/** Each of `parts` occurs in `text`, in this order (by first occurrence). */
function expectInOrder(text: string, parts: string[]): void {
  const at = parts.map((p) => text.indexOf(p));
  parts.forEach((p, i) => expect(at[i], `'${p}' is missing`).toBeGreaterThanOrEqual(0));
  for (let i = 1; i < parts.length; i++) {
    expect(at[i - 1], `'${parts[i - 1]}' comes before '${parts[i]}'`).toBeLessThan(at[i]);
  }
}

describe("create_character prompt", () => {
  it("embeds the description and the workflow", () => {
    expect(PROMPT).toContain(DESCRIPTION);
    expect(PROMPT).toContain("search_content");
    expect(PROMPT).toContain("apply_character_recipe");
    expect(PROMPT).toContain("check_quest_budget");
  });

  it("lays out the rules and eight steps under their own headings", () => {
    const lines = PROMPT.split("\n");
    const rules = lines.indexOf("Rules for every stage:");
    const steps = lines.indexOf("Steps:");
    expect(rules).toBeGreaterThan(0);
    expect(lines[rules - 1]).toBe("");
    expect(steps).toBeGreaterThan(rules);
    expect(lines[steps - 1]).toBe("");
    expect(lines.slice(rules + 1, steps - 1).every((l) => l.startsWith("- "))).toBe(true);
    expect(lines.slice(steps + 1).map((l) => l.slice(0, 3))).toEqual(["1. ", "2. ", "3. ", "4. ", "5. ", "6. ", "7. ", "8. "]);
  });

  it("starts from an undressed textured template, a dressed one only as an alternative, never the 'default' mannequin", () => {
    const step1 = line(1);
    expect(step1).toContain("browse_content('character')");
    expect(step1).toContain("Do not use base 'default'");
    expect(step1).toContain("only as an alternative");
    expect(step1).toContain("fully dressed");
    expect(step1).not.toMatch(/base will be 'default'/);
  });

  // F-71: Claude Code passed only the first word typed after the command ('"Adult').
  describe("the description as it arrived (F-71)", () => {
    it("asks for the description when none arrived", () => {
      for (const missing of [undefined, "", "   "]) {
        const text = buildCreateCharacterPrompt(missing);
        expect(text).toContain("First ask me for the patient description");
        expect(text).not.toContain("as this prompt received it");
      }
    });

    it("restates a description of several words, trimmed, and uses the full typed text", () => {
      const text = buildCreateCharacterPrompt("  Adult male soldier, about 30  ");
      expect(text).toContain('Patient description, as this prompt received it: "Adult male soldier, about 30"');
      expect(text).toContain("Repeat the description you will build");
      expect(text).not.toContain("Only one word arrived");
      expect(text).not.toContain("First ask me for the patient description");
    });

    it("flags a one-word description as cut off and has the model use the full text or ask", () => {
      const text = buildCreateCharacterPrompt('"Adult');
      expect(text).toContain('as this prompt received it: ""Adult"');
      expect(text).toContain("Only one word arrived");
      expect(text).toContain("ask me for the full description");
      expect(text).not.toContain("Repeat the description you will build");
    });
  });

  it("builds in the CC5 order: stage 1 to stage 4 (I-06)", () => {
    expectInOrder(PROMPT, ["Stage 1", "Stage 2", "Stage 3", "Stage 4"]);
  });

  it("loads presets before the skin colour, then the condition on that colour, then the overlays (D2)", () => {
    const step3 = line(3);
    expectInOrder(step3, ["load_asset", "set_skin_color", "set_skin_condition", "apply_skin_overlay"]);
    expect(step3).toContain(IMAGE_TYPES_TEXT);
    expect(step3).toContain("base_rgb");
    // F-67 is open: the agent must not claim a cyanosis CC5 does not show.
    expect(step3).toContain("slightly darker");
  });

  it("carries the pick list, before/after and stage confirmation rules (I-03, F-34)", () => {
    expect(PROMPT).toContain("Pick list first");
    expect(PROMPT).toContain("wait for my go-ahead");
    expect(PROMPT).toContain("wait for my confirmation before the next stage");
    const before = rule("Before and after");
    expect(before).toContain("list_clothes, list_hair and list_accessories before and after");
    expect(before).toContain("offer undo");
    expect(before).toContain("CHECK");
    expect(before).toContain("NOT CHECKED");
    expect(before).toContain("set again by the skin colour step");
  });

  it("checks the fit from every default check_fit view after clothing (F-44)", () => {
    const step4 = line(4);
    expect(step4).toContain("check_fit");
    for (const view of FIT_DEFAULT_VIEWS) expect(step4).toContain(`'${view}'`);
    expect(step4).toContain("removed or replaced");
  });

  it("stops on a CC5 question and keeps Replace / Material Only to this character (D1, D3)", () => {
    const questions = rule("CC5 questions");
    expect(questions).toContain("run nothing else until it is answered");
    expect(questions).toContain("Timed out before CC5 started the command");
    expect(questions).toContain("get_cc5_dialog");
    expect(questions).toContain("plain confirmation");
    expect(questions).toContain("Replace / Material Only");
    expect(questions).toContain(`expect '${LAYER_EXPECT}'`);
    expect(questions).toContain("layer_answer");
    expect(questions).toContain("never carry it to another character");
  });

  // RB-6: layer_answer takes no Cancel, and a Cancel answers only the question it was picked for.
  it("never has a later question answered with Cancel, and says how to go on after one", () => {
    const questions = rule("CC5 questions");
    expect(questions).toContain("answer it yourself with my choice of Replace or Material Only");
    expect(questions).toContain("A Cancel is not carried: if I picked Cancel, the next time CC5 asks it, show me the " +
      "question and let me pick again.");
    expect(questions).toContain("if I picked Cancel, go on with continue_after and no layer_answer: a Cancel is not carried, " +
      "and the next identical question goes to me again");
    for (const text of [PROMPT, buildCreateCharacterPrompt(), buildCreateCharacterPrompt('"Adult')]) {
      expect(text).not.toMatch(/with Cancel/);
    }
  });

  it("uses real files, the user's Custom content, and only suggests store items (F-72, I-02)", () => {
    expect(PROMPT).toContain("Reallusion store");
    expect(PROMPT).toContain("I decide");
    expect(PROMPT).toContain("Reallusion Custom");
    expect(rule("Real files only")).toContain("never invent a path");
  });

  it("asks how injuries reach Unity for this character, then saves, then exports (F-75, F-76, F-77)", () => {
    const step6 = line(6);
    for (const choice of INJURY_CHOICES) expect(step6).toContain(`'${choice}'`);
    for (const words of ["sidecar", "there is no default", "for this character", "ProjectVersion.txt",
      "keeps neither the facial expression nor the pose", "wait_seconds 120", "job_status", "Not exported"]) {
      expect(step6).toContain(words);
    }
    expectInOrder(step6, ["reach Unity", "save_character", "export_for_unity"]);
    // In the source the path's backslash is escaped: the prompt holds one.
    expect(step6).toContain("ProjectSettings\\ProjectVersion.txt");
  });

  // F-86: an FBX export clears CC5's undo history.
  it("says after the export that undo cannot go back past it", () => {
    const step6 = line(6);
    expectInOrder(step6, ["export_for_unity", "clears its undo history"]);
    expect(step6).toContain("undo cannot take back anything done before the export");
  });

  it("describes wrinkle strength as expression wrinkles, not aging (F-70)", () => {
    expect(line(5)).toContain("does not age a resting face");
  });

  it("checks the budget with remove_tearline_occlusion when the export used it (F-73)", () => {
    expect(line(7)).toContain("remove_tearline_occlusion");
  });

  // Chad's ruling (2026-10-03): headshot_from_photo is switched off. Live CC5 lists only .iImgLayer files in image_layer.
  it("never suggests a headshot or image_layer content", () => {
    for (const text of [PROMPT, buildCreateCharacterPrompt(), buildCreateCharacterPrompt('"Adult'),
      buildCreateCharacterPrompt("40-year-old woman, photo attached")]) {
      expect(text.toLowerCase()).not.toContain("headshot");
      expect(text).not.toContain("image_layer");
    }
  });

  it("warns in the recipe schema that 'default' is a mannequin", () => {
    expect(RecipeSchema.shape.base.description).toContain("mannequin");
    expect(RecipeSchema.shape.base.description).toContain("browse_content('character')");
  });

  it("registers with an optional description and asks for one when it is left out", () => {
    const server = { prompt: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerCreateCharacterPrompt(server as any);
    expect(server.prompt).toHaveBeenCalledWith("create_character", expect.any(String), expect.any(Object), expect.any(Function));
    const [, description, shape, callback] = server.prompt.mock.calls[0];
    expect(description).toContain("stage by stage");
    expect(shape.description.isOptional()).toBe(true);
    const reply = callback({});
    expect(reply.messages).toHaveLength(1);
    expect(reply.messages[0].role).toBe("user");
    expect(reply.messages[0].content.text).toContain("First ask me for the patient description");
    expect(callback({ description: DESCRIPTION }).messages[0].content.text).toBe(PROMPT);
  });
});
