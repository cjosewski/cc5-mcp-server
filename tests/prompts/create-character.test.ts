import { describe, it, expect, vi } from "vitest";
import { registerCreateCharacterPrompt, buildCreateCharacterPrompt } from "../../src/prompts/create-character.js";
import { SKINGEN_QUESTION } from "../../src/prompts/content-rules.js";
import { RecipeSchema } from "../../src/recipe.js";
import { LAYER_EXPECT } from "../../src/build-session.js";
import { IMAGE_TYPES_TEXT } from "../../src/tools/pipeline.js";
import { INJURY_CHOICES, registerUnityTools } from "../../src/tools/unity.js";
import { registerAssetTools } from "../../src/tools/asset.js";
import { FIT_DEFAULT_VIEWS } from "../../src/tools/fit.js";
import { createMockBridge } from "../helpers/mock-bridge.js";
import { createMockServer } from "../helpers/mock-server.js";

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
        expect(text).toContain("First ask me for the character description");
        expect(text).not.toContain("as this prompt received it");
      }
    });

    it("restates a description of several words, trimmed, and uses the full typed text", () => {
      const text = buildCreateCharacterPrompt("  Adult male soldier, about 30  ");
      expect(text).toContain('Character description, as this prompt received it: "Adult male soldier, about 30"');
      expect(text).toContain("Repeat the description you will build");
      expect(text).not.toContain("Only one word arrived");
      expect(text).not.toContain("First ask me for the character description");
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

  // I-07 (Chad, 2026-10-07): the Lite Hair sets are low-poly versions made for mobile games, a fallback only.
  it("offers Lite Hair only when nothing else fits or the budget needs it (I-07)", () => {
    const step3 = line(3);
    expect(step3).toContain("Lite Hair sets are low-poly mobile versions: offer them only when nothing else fits or " +
      "when my budget needs them.");
    expectInOrder(step3, ["then a hairstyle ('hair', .rlHair)", "Lite Hair sets", "set_skin_color"]);
    // A budget the hair breaks gets the same fallback among the budget fixes.
    expect(line(7)).toContain("a Lite Hair style if the hair's triangles are the problem");
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

  // F-91 (live CC5 5.13, 2026-10-07): a .ccSkinGenPreset load starts a SkinGen session, which hides hair, brows and
  // clothing in the viewport until a content load or a delete ends it; a content load asks first, and OK is a plain confirmation.
  it("says a SkinGen session hides hair, brows and clothing, and that its question is a plain confirmation (F-91)", () => {
    const before = rule("Before and after");
    expect(before).toContain("A SkinGen or makeup preset starts a SkinGen session: until a later content load or a " +
      "delete ends it, the viewport hides hair, brows and clothing, which stay on the character and in an export (set_item_visible " +
      "does not bring them back)");
    expect(before).not.toContain("hair or brows can stop showing");
    const questions = rule("CC5 questions");
    expect(questions).toContain(`A content load after a SkinGen or makeup preset can ask "${SKINGEN_QUESTION}": for a ` +
      "load I asked for it is a plain confirmation, so answer OK and tell me (OK ends the SkinGen session, the makeup " +
      "stays and the load goes on).");
    // Answered before the Replace / Material Only rules, which stay a real choice for the user.
    expectInOrder(questions, ["for a real choice", SKINGEN_QUESTION, "'Replace / Material Only'"]);
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

  // F-89 (live CC5 5.13, corrects F-86): an FBX export does not clear CC5's undo history. The save before the session's
  // first FBX export stays: CC5 5.13 often crashes on that export (Task 18).
  it("saves before the first FBX export because CC5 may crash on it, and claims nothing about the undo history", () => {
    const step6 = line(6);
    expectInOrder(step6, ["save_character", "before the first FBX export of this CC5 session",
      "CC5 5.13 often crashes on that export", "export_for_unity"]);
    for (const text of [PROMPT, buildCreateCharacterPrompt(), buildCreateCharacterPrompt('"Adult')]) {
      expect(text).not.toContain("undo history");
      expect(text).not.toContain("undo cannot");
    }
  });

  // I-08 (Chad, 2026-10-07): "Quest 3 export is just 1 option. This is not a MilExTS specific tool. This will be
  // published as a General Use MCP eventually."
  describe("any character, any export target (I-08)", () => {
    it("builds a character, not a patient, and asks for any injuries or special looks", () => {
      for (const text of [PROMPT, buildCreateCharacterPrompt(), buildCreateCharacterPrompt('"Adult'),
        buildCreateCharacterPrompt("an elf archer in green leather")]) {
        expect(text.toLowerCase()).not.toContain("patient");
        expect(text.split("\n")[0]).toMatch(/^Build this character in Character Creator 5 /);
      }
      expect(buildCreateCharacterPrompt()).toContain("First ask me for the character description (age, sex, build, " +
        "skin, clothing, and any injuries or special looks) and wait for it.");
    });

    it("asks where the character goes and for any budget, before the Unity questions, the save and the export", () => {
      const step6 = line(6);
      expect(step6.startsWith("6. Export: first ask me where the character goes, unless I already said: Unity, " +
        "Unreal, Blender, another tool, or no export (then skip the rest of this step).")).toBe(true);
      expect(step6).toContain("Ask me too whether it must meet a budget (triangles, materials, texture size)");
      expectInOrder(step6, ["where the character goes", "For Unity", "For any other target", "save_character",
        "Then export. Unity: export_for_unity", "Unreal: export_fbx"]);
      // The save before the session's first FBX export is for every target, not only Unity.
      expect(step6).toContain("Then, whatever the target, call save_character");
    });

    it("exports to Unreal with the recommended call, to Blender or another tool with export_fbx", () => {
      const step6 = line(6);
      expect(step6).toContain("Unreal: export_fbx with target_tool 'UE5', export_motion true, sub_d_level 0, " +
        "embed_textures true and fps 30.");
      expect(step6).toContain("Blender: export_fbx with target_tool 'Blender' and sub_d_level 0");
      expect(step6).toContain("Another tool: export_fbx with target_tool 'Maya' for Maya, else 'Default', and sub_d_level 0.");
      expect(step6).toContain("include_current_pose true, export_motion true and motion_range [0, 0]");
      // An FBX carries neither skin overlays nor skin conditions, and export_fbx has no option for them (F-75).
      expect(step6).toContain("For any other target, ask me for the .fbx path; if this character has injury overlays " +
        "or a skin condition, tell me that the FBX will carry neither, because export_fbx has no option for them");
      // Quest 3 is one option: no Quest texture size on every export.
      expect(step6).not.toContain("texture_size 2048");
      expect(step6).toContain("texture_size only when my budget limits the texture size");
    });

    it("checks a budget only when I named one, and the Quest 3 budget only for Quest", () => {
      const step7 = line(7);
      expect(step7.startsWith("7. Budget, only if I named one: check_quest_budget")).toBe(true);
      expect(step7).toContain("Quest 3 (or a Quest budget): use its defaults, which are the Quest budget.");
      expect(step7).toContain("Another budget: pass my limits instead of its Quest defaults (max_faces for triangles, " +
        "max_materials, max_texture_px) and compare only the lines for the limits I named");
      expect(step7).toContain("its verdict line still says 'Quest budget'");
      for (const n of [1, 2, 3, 4, 5, 6, 8]) expect(line(n)).not.toContain("check_quest_budget");
      expect(line(8)).toContain("where the character was exported");
    });

    // Only presets, parameters and values the tools take (src/tools/asset.ts, src/tools/unity.ts).
    it("names only export presets, parameters and values that export_fbx, export_for_unity and check_quest_budget take", () => {
      const server = createMockServer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerAssetTools(server as any, createMockBridge() as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerUnityTools(server as any, createMockBridge() as any);
      type Shape = Record<string, { safeParse: (v: unknown) => { success: boolean } } | undefined>;
      const accepts = (tool: string, values: Record<string, unknown>) => {
        const shape = server.tool.mock.calls.find((c) => c[0] === tool)?.[2] as Shape | undefined;
        expect(shape, `${tool} is not registered`).toBeDefined();
        for (const [key, value] of Object.entries(values)) {
          const param = shape?.[key];
          expect(param, `${tool} has no ${key}`).toBeDefined();
          expect(param?.safeParse(value).success, `${tool} ${key} = ${JSON.stringify(value)}`).toBe(true);
        }
      };
      const step6 = line(6);
      const presets = new Set([...step6.matchAll(/target_tool '([^']+)'/g)].map((m) => m[1]));
      expect([...presets].sort()).toEqual(["Blender", "Maya", "UE5"]);
      expect(step6).toContain("else 'Default'");
      for (const preset of [...presets, "Default"]) accepts("export_fbx", { target_tool: preset });
      accepts("export_fbx", { export_motion: true, sub_d_level: 0, embed_textures: true, fps: 30,
        include_current_pose: true, motion_range: [0, 0] });
      accepts("export_for_unity", { sub_d_level: 0, wait_seconds: 120, include_current_pose: true });
      for (const choice of INJURY_CHOICES) accepts("export_for_unity", { injuries: choice });
      for (const size of [512, 1024, 2048, 4096]) {
        accepts("export_fbx", { texture_size: size });
        accepts("export_for_unity", { texture_size: size });
      }
      accepts("check_quest_budget", { export_folder: "C:/Exports/Archer", remove_tearline_occlusion: true,
        max_faces: 100_000, max_materials: 30, max_texture_px: 4096 });
    });
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
    // I-08: any character, exported where the user wants it.
    expect(description).toContain("then export it for Unity, Unreal, Blender or another tool, or not at all");
    expect(description).not.toMatch(/patient/i);
    expect(shape.description.isOptional()).toBe(true);
    expect(shape.description.description).toBe("The character: age, sex, build, skin, clothing, and any injuries or " +
      "special looks. Optional: left out, you are asked for it");
    const reply = callback({});
    expect(reply.messages).toHaveLength(1);
    expect(reply.messages[0].role).toBe("user");
    expect(reply.messages[0].content.text).toContain("First ask me for the character description");
    expect(callback({ description: DESCRIPTION }).messages[0].content.text).toBe(PROMPT);
  });
});
