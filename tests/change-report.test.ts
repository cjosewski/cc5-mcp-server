/**
 * F-34: the load change report (src/change-report.ts) turns the plugin's before/after facts into CHECK lines (what a
 * load changed besides what it was for), info lines, NOTE lines and NOT CHECKED lines. The facts are JSON from the
 * plugin, so malformed input must never throw.
 */

import { describe, it, expect } from "vitest";
import {
  buildReport, capChecks, comparedNothing, contentKind, formatLoadResult, isEyeMaterial, isSkinMaterial, skinCheckTopic,
  SKINGEN_SESSION_NOTE,
} from "../src/change-report.js";

const RED_VELVET = "C:/Templates/Makeup/Lip Makeup/Makeup & SFX/Red Velvet.ccSkinGenPreset";
const FULL_SKIN = "C:/Templates/SkinGen/Skin/Full Skin/Tan.ccSkinGenPreset";
const PANTS = "C:/Users/Public/Documents/Reallusion/Reallusion Custom/Cloth/Pants/US_Army_Uniform_Pants.ccCloth";
const AFRO = "C:/Templates/Hair/Afro.rlHair";
const EYES = "C:/Templates/Eye/Eyes_02.ccEye";
const SHOES = "C:/Templates/Shoes/Boots.ccShoes";
const SKIN = "C:/Templates/Skin/Pale.ccSkin";

const FIT_LINE = "how it sits on the character (skin or scalp showing through, floating items): run check_fit";
// F-91: a makeup preset hid the hair, the brows and all clothing in the viewport.
const LOOK_LINE = "what CC5 shows but cannot report (hair, brows or clothing hidden in the viewport, makeup or skin " +
  "layers): capture the face (frame_camera face) and the whole body (home) and compare them with captures from " +
  "before the load";
const NOTHING = "WARNING: CC5 reported the load as done, but nothing was added and nothing compared changed (a Cancel " +
  "answer, content already applied, or content CC5 did not apply)";
// F-91, cause (live 2026-10-07): a .ccSkinGenPreset load starts a SkinGen session, which hides hair, brows and clothing
// until a later content load or a delete ends it; a prop load during it asked to end it, a prop delete ended it without
// a question. Batch F review #13: the NOTE said every next content load asks, and that only a content load ends it.
const SKINGEN_NOTE = "NOTE: this SkinGen preset started a SkinGen session in CC5: the viewport hides hair, brows and " +
  "clothing (they stay worn and are exported) until a later content load or a delete ends it (live: a prop delete " +
  "ended it without a question). A content load during the session can ask \"Applying this content will deactivate " +
  "the current SkinGen session. Would you like to continue?\" (seen for a prop load): for a load the user asked for, " +
  "answer OK and say so.";

const changes = (facts: unknown[], over: Record<string, unknown> = {}) => ({
  complete: true, target: "Kevin", target_is_first: true, elapsed_ms: 1234, compared: { worn: 3, morphs: 12, materials: 30 },
  skipped: 0, truncated: false, facts, ...over,
});
const loaded = (path: string, facts: unknown[], over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ success: true, path, target: "Kevin", changes: changes(facts, over), ...extra });
const added = (group: string, name: string, id = "20") => ({ kind: "worn_added", group, id, name });
const removed = (group: string, name: string, id = "11") => ({ kind: "worn_removed", group, id, name });
const material = (mesh: string, mat: string, field: string, before: unknown, after: unknown, name?: string) =>
  ({ kind: "material", mesh, material: mat, field, ...(name ? { name } : {}), before, after });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const report = (result: unknown, path: string) => buildReport(result as any, path);

describe("contentKind", () => {
  it("tells content kinds apart by extension, and a SkinGen preset by its folder", () => {
    const kinds: Array<[string, string]> = [
      ["C:/e/Eyes.ccEye", "eye"],
      ["C:/h/Buzz Cut.rlHair", "hair"], ["C:/h/a.ccHair", "hair"], ["C:/h/a.iHair", "hair"],
      ["C:/c/a.ccCloth", "clothing"], ["C:/c/a.iClothes", "clothing"], ["C:/c/a.iClothing", "clothing"],
      ["C:/s/a.ccShoes", "shoes"], ["C:/s/a.iShoe", "shoes"],
      ["C:/g/a.ccGloves", "gloves"],
      ["C:/a/a.ccAcc", "accessory"], ["C:/a/a.iAcc", "accessory"], ["C:/a/a.iAccessory", "accessory"],
      ["C:/t/a.ccTeeth", "teeth"],
      ["C:/k/a.ccSkin", "skin"], ["C:/k/a.iSkin", "skin"],
      [FULL_SKIN, "full_skin"], ["C:\\T\\SkinGen\\Skin\\Skin Base\\Pale.ccSkinGenPreset", "full_skin"],
      [RED_VELVET, "makeup"],
      ["C:/a/Kevin.ccAvatar", "unknown"], ["C:/a/Box.iProp", "unknown"], ["C:/a/noext", "unknown"], ["", "unknown"],
    ];
    for (const [path, kind] of kinds) expect([path, contentKind(path)]).toEqual([path, kind]);
  });

  it("isSkinMaterial is the plugin's skin rule (skin, not eyelash)", () => {
    expect(isSkinMaterial("Std_Skin_Head")).toBe(true);
    expect(isSkinMaterial("std_skin_arm")).toBe(true);
    expect(isSkinMaterial("Std_Eyelash")).toBe(false);
    expect(isSkinMaterial("Std_Skin_Eyelash")).toBe(false);
    expect(isSkinMaterial("Std_Nails")).toBe(false);
  });

  it("skinCheckTopic names the skin setting a CHECK line is about", () => {
    expect(skinCheckTopic("skin colour on Std_Skin_Head: (1, 1, 1) -> (0.5, 0.5, 0.5)")).toBe("skin_colour");
    expect(skinCheckTopic("pallor (_BaseColorMap Brightness) on Std_Skin_Head: 0 -> 0.2")).toBe("pallor");
    expect(skinCheckTopic("removed Boxers (clothing)")).toBeNull();
    expect(skinCheckTopic("Applied: skin colour on Std_Skin_Head: (1, 1, 1)")).toBeNull();
  });
});

describe("buildReport: skin", () => {
  const diffuse = material("CC_Base_Body", "Std_Skin_Head", "diffuse", [204, 153, 128], [255, 255, 255]);

  it("a makeup preset that changed the skin colour gets a CHECK; a full-skin preset applied it", () => {
    const makeup = report(loaded(RED_VELVET, [diffuse]), RED_VELVET);
    expect(makeup.checks).toEqual(["skin colour on Std_Skin_Head: (0.8, 0.6, 0.502) -> (1, 1, 1)"]);
    expect(makeup.changed).toEqual([]);
    expect(makeup.notChecked).toEqual([LOOK_LINE]);
    const fullSkin = report(loaded(FULL_SKIN, [diffuse]), FULL_SKIN);
    expect(fullSkin.checks).toEqual([]);
    expect(fullSkin.changed).toEqual(["Applied: skin colour on Std_Skin_Head: (1, 1, 1)"]);
  });

  // F-91 (live): Red Velvet hid the hair, the brows and all clothing, which list_clothes still listed; no CHECK line.
  it("a makeup preset's NOT CHECKED line names hair, brows or clothing hidden in the viewport", () => {
    const r = report(loaded(RED_VELVET, []), RED_VELVET);
    expect(r.checks).toEqual([]);
    expect(r.notChecked).toEqual([LOOK_LINE]);
    expect(r.text).toContain("\nNOT CHECKED: what CC5 shows but cannot report (hair, brows or clothing hidden in the " +
      "viewport, makeup or skin layers): capture the face (frame_camera face) and the whole body (home)");
  });

  it("pallor offsets are a CHECK unless the load is a skin preset", () => {
    const pallor = material("CC_Base_Body", "Std_Skin_Body", "param", [0], [-0.1], "_BaseColorMap Saturation");
    expect(report(loaded(RED_VELVET, [pallor]), RED_VELVET).checks)
      .toEqual(["pallor (_BaseColorMap Saturation) on Std_Skin_Body: 0 -> -0.1"]);
    const skin = report(loaded(SKIN, [pallor]), SKIN);
    expect(skin.checks).toEqual([]);
    expect(skin.changed).toEqual(["Applied: _BaseColorMap Saturation on Std_Skin_Body: -0.1"]);
  });

  it("a removed Diffuse Blend image is an injury overlay only on skin (corneas carry one, F-66)", () => {
    const r = report(loaded(RED_VELVET, [
      material("CC_Base_Body", "Std_Skin_Arm", "blend_image", true, false),
      material("CC_Base_Eye", "Std_Cornea_R", "blend_image", true, false),
      material("CC_Base_Body", "Std_Skin_Leg", "blend_image", false, true),
    ]), RED_VELVET);
    expect(r.checks).toEqual(["injury overlay (Diffuse Blend image) removed from Std_Skin_Arm"]);
    expect(r.changed).toEqual(["Changed: CC_Base_Eye/Std_Cornea_R Diffuse Blend image removed",
      "Changed: CC_Base_Body/Std_Skin_Leg Diffuse Blend image added"]);
  });
});

// F-91, cause (live 2026-10-07): Red Velvet and Cordial each started a SkinGen session, which hid hair, brows and
// clothing; a prop load asked to end it, and after OK they showed again; a prop delete also ended it, without a question.
describe("buildReport: the SkinGen session a SkinGen preset starts (F-91)", () => {
  it("adds one NOTE line before the NOT CHECKED line, which it keeps", () => {
    const r = report(loaded(RED_VELVET, []), RED_VELVET);
    expect(r.notes).toEqual([SKINGEN_SESSION_NOTE]);
    expect(`NOTE: ${SKINGEN_SESSION_NOTE}`).toBe(SKINGEN_NOTE);
    // Batch F review #13: no more than F-91 saw. A delete ends it too, and only a prop load was seen asking.
    expect(SKINGEN_SESSION_NOTE).toContain("until a later content load or a delete ends it");
    expect(SKINGEN_SESSION_NOTE).toContain("can ask");
    expect(SKINGEN_SESSION_NOTE).not.toContain("That next load asks");
    expect(r.checks).toEqual([]);
    expect(r.notChecked).toEqual([LOOK_LINE]);
    expect(r.text).toBe([
      "Compared before and after: 3 worn items, 12 shaping morphs, 30 materials (1.2 s).",
      SKINGEN_NOTE,
      `NOT CHECKED: ${LOOK_LINE}`,
    ].join("\n"));
  });

  it("comes after the CHECK and Applied lines, for a makeup and a full-skin SkinGen preset alike", () => {
    const diffuse = material("CC_Base_Body", "Std_Skin_Head", "diffuse", [204, 153, 128], [255, 255, 255]);
    expect(report(loaded(RED_VELVET, [diffuse]), RED_VELVET).text.split("\n").slice(1)).toEqual([
      "CHECK skin colour on Std_Skin_Head: (0.8, 0.6, 0.502) -> (1, 1, 1)", SKINGEN_NOTE, `NOT CHECKED: ${LOOK_LINE}`]);
    const fullSkin = report(loaded(FULL_SKIN, [diffuse]), FULL_SKIN);
    expect(fullSkin.notes).toEqual([SKINGEN_SESSION_NOTE]);
    expect(fullSkin.text.split("\n").slice(1)).toEqual([
      "Applied: skin colour on Std_Skin_Head: (1, 1, 1)", SKINGEN_NOTE, `NOT CHECKED: ${LOOK_LINE}`]);
  });

  it("is there with an older plugin too; a failed load and other content have none", () => {
    const old = report({ success: true, path: RED_VELVET, target: "Kevin" }, RED_VELVET);
    expect(old.notes).toEqual([SKINGEN_SESSION_NOTE]);
    expect(old.text).toBe(`${SKINGEN_NOTE}\nNOT CHECKED: the installed CC5 plugin predates the change report (reinstall ` +
      `it with install-plugin.ps1)\nNOT CHECKED: ${LOOK_LINE}`);
    const failed = report(loaded(RED_VELVET, [], {}, { success: false, error: "boom" }), RED_VELVET);
    expect(failed.notes).toEqual([]);
    expect(failed.text).not.toContain("SkinGen session");
    for (const path of [SKIN, EYES, PANTS, AFRO, SHOES]) {
      const r = report(loaded(path, [added("clothing", "Socks")]), path);
      expect([path, r.notes]).toEqual([path, []]);
      expect(r.text).not.toContain("NOTE:");
    }
  });
});

describe("buildReport: worn items", () => {
  it("clothing that removed the template's Boxers says CC5 may have swapped them", () => {
    const r = report(loaded(PANTS, [added("clothing", "US_Army_Uniform_Pants"), removed("clothing", "Boxers")]), PANTS);
    expect(r.checks).toEqual(["removed Boxers (clothing): CC5 may have swapped it out for this item"]);
    expect(r.changed).toEqual(["Applied: added US_Army_Uniform_Pants (clothing)"]);
    expect(r.notChecked).toEqual([FIT_LINE]);
    expect(r.text).toBe([
      "Compared before and after: 3 worn items, 12 shaping morphs, 30 materials (1.2 s).",
      "CHECK removed Boxers (clothing): CC5 may have swapped it out for this item",
      "Applied: added US_Army_Uniform_Pants (clothing)",
      `NOT CHECKED: ${FIT_LINE}`,
    ].join("\n"));
  });

  it("a hairstyle that replaced the hair is what it was for; an extra removed hair is a CHECK", () => {
    const r = report(loaded(AFRO, [added("hair", "Afro", "30"), removed("hair", "Buzz_Cut", "12")]), AFRO);
    expect(r.checks).toEqual([]);
    expect(r.changed).toEqual(["Applied: Buzz_Cut replaced by Afro (hair)"]);
    const two = report(loaded(AFRO, [added("hair", "Afro", "30"), removed("hair", "Buzz_Cut", "12"), removed("hair", "Beard", "13")]), AFRO);
    expect(two.changed).toEqual(["Applied: Buzz_Cut replaced by Afro (hair)"]);
    expect(two.checks).toEqual(["removed Beard (hair)"]);
  });

  it("worn items a load was not for are CHECK lines", () => {
    const eye = report(loaded(EYES, [added("accessory", "Glasses"), removed("hair", "Buzz_Cut")]), EYES);
    expect(eye.checks).toEqual(["added Glasses (accessory), which this eye load was not for", "removed Buzz_Cut (hair)"]);
    const skin = report(loaded(FULL_SKIN, [added("clothing", "Socks")]), FULL_SKIN);
    expect(skin.checks).toEqual(["added Socks (clothing), which this full skin load was not for"]);
    const pantsHair = report(loaded(PANTS, [removed("hair", "Buzz_Cut")]), PANTS);
    expect(pantsHair.checks).toEqual(["removed Buzz_Cut (hair)"]);
  });

  it("a wearable load that added nothing and changed nothing gets the WARNING; an eye preset does not", () => {
    expect(report(loaded(SHOES, []), SHOES).checks).toEqual([NOTHING]);
    expect(report(loaded(EYES, []), EYES).checks).toEqual([]);
  });
});

// F-97 (live): _Blue1 Eyes on CC4 Kevin reported "CHECK opacity on CC_Base_Eye/Std_Cornea_R: 1 -> 0.8" (and _L), the
// eye preset's own setting.
describe("buildReport: an eye preset's own materials (F-97)", () => {
  it("reports the corneas' opacity as what the eye preset applied, not as a CHECK line", () => {
    const r = report(loaded(EYES, [
      material("CC_Base_Eye", "Std_Cornea_R", "opacity", 1, 0.8),
      material("CC_Base_Eye", "Std_Cornea_L", "opacity", 1, 0.8),
    ]), EYES);
    expect(r.checks).toEqual([]);
    expect(r.text).toBe([
      "Compared before and after: 3 worn items, 12 shaping morphs, 30 materials (1.2 s).",
      "Applied: opacity on CC_Base_Eye/Std_Cornea_R: 0.8",
      "Applied: opacity on CC_Base_Eye/Std_Cornea_L: 0.8",
      `NOT CHECKED: ${LOOK_LINE}`,
    ].join("\n"));
    expect(r.text).not.toContain("CHECK opacity");
  });

  it("words each change to the eye's materials as applied: colour, shader, values, images, materials, occlusion, tear line", () => {
    const r = report(loaded(EYES, [
      material("CC_Base_Eye", "Std_Eye_R", "diffuse", [255, 255, 255], [204, 153, 128]),
      material("CC_Base_Eye", "Std_Eye_L", "param", [0.5, 0.5, 0.5], [0.2, 0.4, 0.6], "Iris Color"),
      material("CC_Base_Eye", "Std_Eye_L", "shader", "Pbr", "Digital_Human Eye"),
      material("CC_Base_Eye", "Std_Cornea_R", "blend_image", true, false),
      material("CC_Base_Eye", "Std_Cornea_L", "blend_image", false, true),
      material("CC_Base_Eye", "Std_Eye_Old_R", "present", true, false),
      material("CC_Base_Eye", "Std_Eye_New_R", "present", false, true),
      material("CC_Base_EyeOcclusion", "Std_Eye_Occlusion_R", "opacity", 1, 0.5),
      material("CC_Base_TearLine", "Std_Tearline_L", "param", [0.1], [0.3], "Detail Scale"),
    ]), EYES);
    expect(r.checks).toEqual([]);
    expect(r.changed).toEqual([
      "Applied: diffuse colour on CC_Base_Eye/Std_Eye_R: (0.8, 0.6, 0.502)",
      "Applied: Iris Color on CC_Base_Eye/Std_Eye_L: 0.2, 0.4, 0.6",
      "Applied: shader on CC_Base_Eye/Std_Eye_L: Digital_Human Eye",
      "Applied: Diffuse Blend image removed from CC_Base_Eye/Std_Cornea_R",
      "Applied: Diffuse Blend image added to CC_Base_Eye/Std_Cornea_L",
      "Applied: material CC_Base_Eye/Std_Eye_Old_R removed",
      "Applied: material CC_Base_Eye/Std_Eye_New_R added",
      "Applied: opacity on CC_Base_EyeOcclusion/Std_Eye_Occlusion_R: 0.5",
      "Applied: Detail Scale on CC_Base_TearLine/Std_Tearline_L: 0.3",
    ]);
  });

  it("keeps the CHECK lines for changes outside the eye: skin, eyelashes, brows, glasses, worn items, morphs", () => {
    const r = report(loaded(EYES, [
      material("CC_Base_Body", "Std_Skin_Head", "opacity", 1, 0.5),
      material("CC_Base_Body", "Std_Eyelash", "opacity", 1, 0),
      material("CC_Base_Eyebrow", "Std_Eyebrow", "opacity", 1, 0),
      material("Eyeglasses", "Glass_Lens", "present", true, false),
      material("CC_Base_Body", "Std_Skin_Head", "diffuse", [255, 255, 255], [204, 153, 128]),
      added("accessory", "Glasses"),
      { kind: "morph", id: "Eye Size", before: 0, after: 0.2 },
    ]), EYES);
    expect(r.checks).toEqual([
      "opacity on CC_Base_Body/Std_Skin_Head: 1 -> 0.5",
      "opacity on CC_Base_Body/Std_Eyelash: 1 -> 0",
      "opacity on CC_Base_Eyebrow/Std_Eyebrow: 1 -> 0",
      "material Eyeglasses/Glass_Lens is gone",
      "skin colour on Std_Skin_Head: (1, 1, 1) -> (0.8, 0.6, 0.502)",
      "added Glasses (accessory), which this eye load was not for",
      "shaping morph Eye Size: 0 -> 0.2",
    ]);
    expect(r.changed).toEqual([]);
  });

  it("keeps an eye material's CHECK line on a load that is not an eye preset", () => {
    const r = report(loaded(RED_VELVET, [material("CC_Base_Eye", "Std_Cornea_R", "opacity", 1, 0.8)]), RED_VELVET);
    expect(r.checks).toEqual(["opacity on CC_Base_Eye/Std_Cornea_R: 1 -> 0.8"]);
    expect(r.changed).toEqual([]);
  });

  it("isEyeMaterial takes the eye, its corneas, occlusion and tear line, never eyelashes, brows or glasses", () => {
    const eye: Array<[string, string]> = [["CC_Base_Eye", "Std_Eye_R"], ["CC_Base_Eye", "Std_Cornea_L"],
      ["CC_Base_EyeOcclusion", "Std_Eye_Occlusion_R"], ["CC_Base_TearLine", "Std_Tearline_L"], ["Eye_2", "Iris"],
      ["CC_Base_Body", "Std_Cornea_R"]];
    for (const [mesh, mat] of eye) expect([mesh, mat, isEyeMaterial(mesh, mat)]).toEqual([mesh, mat, true]);
    const notEye: Array<[string, string]> = [["CC_Base_Body", "Std_Eyelash"], ["CC_Base_Eyebrow", "Std_Eyebrow"],
      ["Eyeglasses", "Glass_Lens"], ["CC_Base_Body", "Std_Skin_Head"], ["Hat_DarkBlue", "Hat"],
      ["CC_Base_Teeth", "Std_Upper_Teeth"]];
    for (const [mesh, mat] of notEye) expect([mesh, mat, isEyeMaterial(mesh, mat)]).toEqual([mesh, mat, false]);
  });
});

describe("buildReport: other facts", () => {
  // A shoes load: on an eye preset's load the eye materials' changes are what it applied (F-97).
  it("materials that came or went, shaping morphs, opacity, subdivision and other values", () => {
    const r = report(loaded(SHOES, [
      { kind: "morph", id: "Body Fat A", before: 0.35, after: 0 },
      material("CC_Base_Body", "Std_Nails", "present", true, false),
      material("CC_Base_Body", "Std_Extra", "present", false, true),
      material("CC_Base_Body", "Std_Skin_Head", "opacity", 1, 0.5),
      material("Hair", "Hair_Transparency", "opacity", 0.5, 1),
      material("CC_Base_Body", "Std_Skin_Head", "shader", "Pbr", "Digital_Human Skin"),
      material("CC_Base_Body", "Std_Skin_Head", "param", [0.85], [0.7], "Original Roughness Strength"),
      material("CC_Base_Eye", "Std_Cornea_R", "diffuse", [255, 255, 255], [200, 200, 200]),
      { kind: "subdivision", before: 0, after: 1 },
    ]), SHOES);
    expect(r.checks).toEqual([
      "shaping morph Body Fat A: 0.35 -> 0",
      "material CC_Base_Body/Std_Nails is gone",
      "opacity on CC_Base_Body/Std_Skin_Head: 1 -> 0.5",
      "subdivision level: 0 -> 1",
    ]);
    expect(r.changed).toEqual([
      "Changed: material CC_Base_Body/Std_Extra added",
      "Changed: Hair/Hair_Transparency opacity: 0.5 -> 1",
      "Changed: CC_Base_Body/Std_Skin_Head shader: Pbr -> Digital_Human Skin",
      "Changed: CC_Base_Body/Std_Skin_Head Original Roughness Strength: 0.85 -> 0.7",
      "Changed: CC_Base_Eye/Std_Cornea_R diffuse: 255, 255, 255 -> 200, 200, 200",
    ]);
  });

  it("shows at most 12 lines of a kind in each list, then how many more, and keeps every CHECK line (RB-2)", () => {
    const morphs = Array.from({ length: 13 }, (_, i) => ({ kind: "morph", id: `m${i}`, before: 0, after: 0.1 }));
    const r = report(loaded(PANTS, [added("clothing", "Pants"), ...morphs]), PANTS);
    // Every CHECK line stays: a recipe supersedes some of them before it shows the rest.
    expect(r.checks).toEqual(morphs.map((m) => `shaping morph ${m.id}: 0 -> 0.1`));
    expect(capChecks(r.checks)).toEqual([...morphs.slice(0, 12).map((m) => `shaping morph ${m.id}: 0 -> 0.1`), "... and 1 more"]);
    expect(r.text).toContain("CHECK shaping morph m11: 0 -> 0.1\nCHECK ... and 1 more\nApplied: added Pants (clothing)");
    expect(r.text).not.toContain("shaping morph m12:");
    const extras = Array.from({ length: 14 }, (_, i) => material("CC_Base_Body", `Std_Extra_${i}`, "present", false, true));
    const many = report(loaded(PANTS, [added("clothing", "Pants"), ...extras]), PANTS);
    expect(many.changed).toHaveLength(14);  // the Applied line, 12 material lines, the rest counted
    expect(many.changed.at(-1)).toBe("... and 2 more");
  });

  it("capChecks caps each kind of CHECK line on its own, where that kind's next line was", () => {
    const morphs = Array.from({ length: 13 }, (_, i) => `shaping morph m${i}: 0 -> 0.1`);
    const materials = Array.from({ length: 13 }, (_, i) => `opacity on Hair/Hair_${i}: 1 -> 0.5`);
    const removed = "removed Boxers (clothing): CC5 may have swapped it out for this item";
    expect(capChecks([removed, ...morphs, ...materials])).toEqual([
      removed, ...morphs.slice(0, 12), "... and 1 more", ...materials.slice(0, 12), "... and 1 more"]);
    const skin = [
      ...Array.from({ length: 6 }, (_, i) => `skin colour on Std_Skin_${i}: (1, 1, 1) -> (0.5, 0.5, 0.5)`),
      ...Array.from({ length: 6 }, (_, i) => `pallor (_BaseColorMap Brightness) on Std_Skin_${i}: 0 -> 0.2`),
      "injury overlay (Diffuse Blend image) removed from Std_Skin_Arm",
    ];
    // All material lines: the 13th is counted, even with other kinds in between.
    expect(capChecks([...skin.slice(0, 12), "subdivision level: 0 -> 1", skin[12]]))
      .toEqual([...skin.slice(0, 12), "subdivision level: 0 -> 1", "... and 1 more"]);
    expect(capChecks([])).toEqual([]);
  });

  it("says what was not compared: past 300 facts, out of time, the plugin's warnings", () => {
    const facts = [added("clothing", "Pants")];
    const r = report(loaded(PANTS, facts, { truncated: true, skipped: 4 }, { notes: ["WARNING: not compared, because CC5 " +
      "could not read them before or after the load: hair", "an info note"] }), PANTS);
    expect(r.notChecked).toEqual([
      "more changes than listed: the comparison stops at 300",
      "4 materials were not compared: the comparison ran out of time",
      "WARNING: not compared, because CC5 could not read them before or after the load: hair",
      FIT_LINE,
    ]);
    expect(report(loaded(PANTS, facts, { skipped: 1 }), PANTS).notChecked[0])
      .toBe("1 material was not compared: the comparison ran out of time");
  });

  it("an incomplete comparison has no 'Compared' line and no nothing-changed WARNING; its notes are NOT CHECKED", () => {
    const off = "WARNING: the before/after comparison is switched off (CC5_CHANGE_CHECK=0): nothing was compared";
    const r = report(loaded(SHOES, [], { complete: false, elapsed_ms: 0 }, { notes: [off] }), SHOES);
    expect(r.checks).toEqual([]);
    expect(r.notChecked).toEqual([off, FIT_LINE]);
    expect(r.text).toBe(`NOT CHECKED: ${off}\nNOT CHECKED: ${FIT_LINE}`);
  });

  it("says when the installed plugin predates the report, and has nothing for scene content", () => {
    const old = report({ success: true, path: EYES, target: "Kevin" }, EYES);
    expect(old.notChecked).toEqual(["the installed CC5 plugin predates the change report (reinstall it with install-plugin.ps1)", LOOK_LINE]);
    expect(old.text).toBe(old.notChecked.map((l) => `NOT CHECKED: ${l}`).join("\n"));
    expect(report({ success: true, path: "C:/a/Kevin.ccAvatar" }, "C:/a/Kevin.ccAvatar"))
      .toEqual({ checks: [], changed: [], notes: [], notChecked: [], text: "" });
  });

  it("never throws on malformed input, and shows unknown facts as they are", () => {
    expect(report(null, PANTS)).toEqual({ checks: [], changed: [], notes: [], notChecked: [], text: "" });
    expect(report({ success: true, target: "Kevin", changes: { facts: "nope", compared: 3, skipped: "x" } }, PANTS))
      .toEqual({ checks: [], changed: [], notes: [], notChecked: [FIT_LINE], text: `NOT CHECKED: ${FIT_LINE}` });
    const r = report(loaded(EYES, [
      { kind: "colour", value: 1 },
      null,
      "text",
      { kind: "material", mesh: "CC_Base_Body" },
      { kind: "worn_added", group: "hat", id: "1", name: "Cap" },
      { kind: "morph", before: 0, after: 1 },
    ]), EYES);
    expect(r.checks).toEqual([]);
    expect(r.changed).toEqual([
      'Changed: {"kind":"colour","value":1}',
      "Changed: null",
      'Changed: "text"',
      'Changed: {"kind":"material","mesh":"CC_Base_Body"}',
      'Changed: {"kind":"worn_added","group":"hat","id":"1","name":"Cap"}',
      'Changed: {"kind":"morph","before":0,"after":1}',
    ]);
  });

  it("never calls a report clean", () => {
    const texts = [
      report(loaded(PANTS, [added("clothing", "Pants")]), PANTS).text,
      report(loaded(EYES, []), EYES).text,
      report(loaded(SHOES, []), SHOES).text,
      report({ success: true, path: EYES, target: "Kevin" }, EYES).text,
    ];
    for (const text of texts) expect(text).not.toMatch(/clean/i);
  });
});

// F-95 (live): Claude Code shows adjacent text blocks with no separator, so a reply in two blocks read
// "... (applied to Kevin)Compared before and after: ...". The reply is one text block, its lines joined by newlines.
describe("formatLoadResult", () => {
  it("keeps load_asset's first line exactly and adds the report on the next lines of the same text block", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = formatLoadResult(loaded(PANTS, [added("clothing", "Pants"), removed("clothing", "Boxers")]) as any, PANTS);
    expect(r.isError).toBeUndefined();
    expect(r.content).toEqual([{ type: "text", text: [
      `Asset loaded: ${PANTS} (applied to Kevin)`,
      "Compared before and after: 3 worn items, 12 shaping morphs, 30 materials (1.2 s).",
      "CHECK removed Boxers (clothing): CC5 may have swapped it out for this item",
      "Applied: added Pants (clothing)",
      `NOT CHECKED: ${FIT_LINE}`,
    ].join("\n") }]);
    expect(formatLoadResult({ success: true, path: "C:/a/Kevin.ccAvatar" }, "C:/a/Kevin.ccAvatar"))
      .toEqual({ content: [{ type: "text", text: "Asset loaded: C:/a/Kevin.ccAvatar" }] });
  });

  it("puts a SkinGen preset's session NOTE in the reply, and none after a failed load (F-91)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatLoadResult(loaded(RED_VELVET, []) as any, RED_VELVET)).toEqual({ content: [{ type: "text", text: [
      `Asset loaded: ${RED_VELVET} (applied to Kevin)`,
      "Compared before and after: 3 worn items, 12 shaping morphs, 30 materials (1.2 s).",
      SKINGEN_NOTE,
      `NOT CHECKED: ${LOOK_LINE}`,
    ].join("\n") }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatLoadResult({ success: false, error: "x", changes: changes([]) as any }, RED_VELVET))
      .toEqual({ content: [{ type: "text", text: "Failed to load asset: x" }], isError: true });
  });

  it("puts an older plugin's NOT CHECKED lines in the same text block", () => {
    expect(formatLoadResult({ success: true, path: EYES, target: "Kevin" }, EYES)).toEqual({ content: [{ type: "text",
      text: `Asset loaded: ${EYES} (applied to Kevin)\nNOT CHECKED: the installed CC5 plugin predates the change report ` +
        `(reinstall it with install-plugin.ps1)\nNOT CHECKED: ${LOOK_LINE}` }] });
  });

  // F-92 precaution (cc5_api.load_asset): a .ccProject load clears CC5's selection first and names what was selected,
  // or warns that it could not; scene content has no report, so the notes were never shown.
  it("shows the plugin's notes on a scene-content load after its first line, also after a failure", () => {
    const PROJECT = "C:/p/Scene.ccProject";
    const cleared = "CC5's selection (Pants) was cleared before the project load: a project replaces the scene, and " +
      "deleting a character while one of its worn items is selected can crash CC5 (F-92).";
    const warning = "WARNING: CC5's selection could not be cleared before the project load (SWIG): a project replaces " +
      "the scene, and deleting a character while one of its worn items is selected can crash CC5 (F-92).";
    expect(formatLoadResult({ success: true, path: PROJECT, notes: [cleared] }, PROJECT))
      .toEqual({ content: [{ type: "text", text: `Asset loaded: ${PROJECT}\n${cleared}` }] });
    // The load ran: a WARNING note about the selection makes it no error.
    expect(formatLoadResult({ success: true, path: PROJECT, notes: [warning] }, PROJECT))
      .toEqual({ content: [{ type: "text", text: `Asset loaded: ${PROJECT}\n${warning}` }] });
    expect(formatLoadResult({ success: false, error: "LoadFile failed", notes: [cleared] }, PROJECT))
      .toEqual({ content: [{ type: "text", text: `Failed to load asset: LoadFile failed\n${cleared}` }], isError: true });
    // The result is JSON from another process: only its text notes are shown.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatLoadResult({ success: true, path: PROJECT, notes: [cleared, 7, null] } as any, PROJECT).content[0].text)
      .toBe(`Asset loaded: ${PROJECT}\n${cleared}`);
  });

  it("does not repeat a character-content load's notes: its WARNING notes stay NOT CHECKED lines", () => {
    const warning = "WARNING: not compared, because CC5 could not read them before or after the load: hair";
    const text = formatLoadResult(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loaded(PANTS, [added("clothing", "Pants")], {}, { notes: [warning, "an info note"] }) as any, PANTS).content[0].text;
    expect(text.split(warning)).toHaveLength(2);
    expect(text).toContain(`NOT CHECKED: ${warning}`);
    expect(text).not.toContain("an info note");
    // An older plugin's result for character content names its target: its notes are not shown either.
    expect(formatLoadResult({ success: true, path: EYES, target: "Kevin", notes: ["an info note"] }, EYES).content[0].text)
      .not.toContain("an info note");
  });

  // TS-3: the error said the load changed something, and the reply never said what.
  it("shows what a failed load still applied, also when nothing of it needs a check", () => {
    const applied = formatLoadResult({ success: false, error: "LoadFile failed (CC5 reported an error, but it changed 1 thing)",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      changes: changes([added("clothing", "Pants")]) as any }, PANTS);
    expect(applied.isError).toBe(true);
    expect(applied.content).toHaveLength(1);
    expect(applied.content[0].text).toBe([
      "Failed to load asset: LoadFile failed (CC5 reported an error, but it changed 1 thing)",
      "Compared before and after: 3 worn items, 12 shaping morphs, 30 materials (1.2 s).",
      "Applied: added Pants (clothing)",
      `NOT CHECKED: ${FIT_LINE}`,
    ].join("\n"));
  });

  it("reports a failure as an error, with the report only when the failed load changed something", () => {
    const changedThings = formatLoadResult({ success: false, error: "boom (CC5 reported an error, but it changed 1 thing)",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      changes: changes([removed("clothing", "Boxers")]) as any }, PANTS);
    expect(changedThings.isError).toBe(true);
    expect(changedThings.content).toHaveLength(1);
    const lines = changedThings.content[0].text.split("\n");
    expect(lines[0]).toBe("Failed to load asset: boom (CC5 reported an error, but it changed 1 thing)");
    expect(lines).toContain("CHECK removed Boxers (clothing): CC5 may have swapped it out for this item");
    expect(formatLoadResult({ success: false, error: "File not found: C:/x.ccCloth" }, "C:/x.ccCloth"))
      .toEqual({ content: [{ type: "text", text: "Failed to load asset: File not found: C:/x.ccCloth" }], isError: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nothing = formatLoadResult({ success: false, error: "x", changes: changes([]) as any }, SHOES);
    // No nothing-changed WARNING for a load that failed, and no report.
    expect(nothing).toEqual({ content: [{ type: "text", text: "Failed to load asset: x" }], isError: true });
    expect(formatLoadResult({ success: false }, PANTS).content[0].text).toBe("Failed to load asset: unknown error");
  });
});

// F-98 (batch F review #8, #28): CC5 reports a load done after answer_cc5_dialog clicked Cancel in its question (live:
// the user's Cancel in an eye preset's Replace / Material Only applied nothing). load_asset and job_status read such a
// load as "Asset loaded: ... (applied to Kevin)", and a SkinGen preset's still claimed a SkinGen session.
describe("a load answered Cancel in CC5 (F-98)", () => {
  /** Markers for the words load_asset and job_status pass (CANCELLED_LOAD in src/tools/asset.ts): which one is picked. */
  const WORDS = { changed: "CHANGED words", nothing: "NOTHING words", unsure: "UNSURE words" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cancelled = (result: unknown, path: string) => formatLoadResult(result as any, path, WORDS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cancelledReport = (result: unknown, path: string) => buildReport(result as any, path, true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nothingFound = (result: unknown) => comparedNothing(result as any);
  const COMPARED = "Compared before and after: 3 worn items, 12 shaping morphs, 30 materials (1.2 s).";

  it("claims no SkinGen session and gives no nothing-changed WARNING: the Cancel is why nothing changed", () => {
    const makeup = cancelledReport(loaded(RED_VELVET, []), RED_VELVET);
    expect(makeup.notes).toEqual([]);
    expect(makeup.text).toBe(`${COMPARED}\nNOT CHECKED: ${LOOK_LINE}`);
    expect(cancelledReport(loaded(SHOES, []), SHOES).checks).toEqual([]);
    // The same results, not cancelled, keep the NOTE and the WARNING.
    expect(report(loaded(RED_VELVET, []), RED_VELVET).notes).toEqual([SKINGEN_SESSION_NOTE]);
    expect(report(loaded(SHOES, []), SHOES).checks).toEqual([NOTHING]);
  });

  it("comparedNothing: a comparison that ran in full, with no fact, no material out of time and no WARNING note", () => {
    expect(nothingFound(loaded(EYES, []))).toBe(true);
    expect(nothingFound(loaded(EYES, [], {}, { notes: ["an info note"] }))).toBe(true);
    expect(nothingFound(loaded(EYES, [added("accessory", "Glasses")]))).toBe(false);
    expect(nothingFound(loaded(EYES, [], { complete: false }))).toBe(false);
    expect(nothingFound(loaded(EYES, [], { skipped: 2 }))).toBe(false);
    expect(nothingFound(loaded(EYES, [], {}, { notes: ["WARNING: CC5 reports material colours late after an undo or " +
      "redo, so whether this load changed the colour of CC_Base_Eye/Std_Cornea_R was not checked: capture, then compare"] })))
      .toBe(false);
    // A plugin from before the change report, scene content, and results that are not what the plugin sends.
    expect(nothingFound({ success: true, path: EYES, target: "Kevin" })).toBe(false);
    expect(nothingFound({ success: true, path: "C:/a/Box.iProp" })).toBe(false);
    expect(nothingFound(null)).toBe(false);
    expect(nothingFound({ success: true, changes: { complete: true, facts: "nope" } })).toBe(false);
  });

  it("says CC5 applied nothing only when the comparison ran in full and found nothing; the reply is an error", () => {
    expect(cancelled(loaded(EYES, []), EYES)).toEqual({ isError: true, content: [{ type: "text", text: [
      `Asset load cancelled: ${EYES} for Kevin (NOTHING words)`, COMPARED, `NOT CHECKED: ${LOOK_LINE}`,
    ].join("\n") }] });
  });

  it("says what CC5 still changed, with its CHECK and Applied lines", () => {
    expect(cancelled(loaded(PANTS, [added("clothing", "Pants"), removed("clothing", "Boxers")]), PANTS).content[0].text)
      .toBe([
        `Asset load cancelled: ${PANTS} for Kevin (CHANGED words)`,
        COMPARED,
        "CHECK removed Boxers (clothing): CC5 may have swapped it out for this item",
        "Applied: added Pants (clothing)",
        `NOT CHECKED: ${FIT_LINE}`,
      ].join("\n"));
    // An Applied line alone (an eye preset's own material, F-97) is a change too.
    const cornea = material("CC_Base_Eye", "Std_Cornea_R", "opacity", 1, 0.8);
    expect(cancelled(loaded(EYES, [cornea]), EYES).content[0].text.split("\n").slice(0, 3)).toEqual([
      `Asset load cancelled: ${EYES} for Kevin (CHANGED words)`, COMPARED, "Applied: opacity on CC_Base_Eye/Std_Cornea_R: 0.8"]);
  });

  it("leaves out a SkinGen preset's session NOTE", () => {
    const text = cancelled(loaded(RED_VELVET, []), RED_VELVET).content[0].text;
    expect(text).toBe([`Asset load cancelled: ${RED_VELVET} for Kevin (NOTHING words)`, COMPARED, `NOT CHECKED: ${LOOK_LINE}`]
      .join("\n"));
    expect(text).not.toContain("SkinGen session");
  });

  it("says CC5 may not have done it without a full comparison: off, out of time, an older plugin, scene content", () => {
    const off = "WARNING: the before/after comparison is switched off (CC5_CHANGE_CHECK=0): nothing was compared";
    expect(cancelled(loaded(SHOES, [], { complete: false, elapsed_ms: 0 }, { notes: [off] }), SHOES).content[0].text).toBe([
      `Asset load cancelled: ${SHOES} for Kevin (UNSURE words)`, `NOT CHECKED: ${off}`, `NOT CHECKED: ${FIT_LINE}`,
    ].join("\n"));
    expect(cancelled(loaded(EYES, [], { skipped: 3 }), EYES).content[0].text.split("\n")[0])
      .toBe(`Asset load cancelled: ${EYES} for Kevin (UNSURE words)`);
    expect(cancelled({ success: true, path: EYES, target: "Kevin" }, EYES).content[0].text.split("\n")[0])
      .toBe(`Asset load cancelled: ${EYES} for Kevin (UNSURE words)`);
    // F-91 (live): a prop load during a SkinGen session asked CC5's question; scene content names no character.
    const PROP = "C:/Props/Box_001.iProp";
    expect(cancelled({ success: true, path: PROP }, PROP))
      .toEqual({ isError: true, content: [{ type: "text", text: `Asset load cancelled: ${PROP} (UNSURE words)` }] });
  });

  it("puts a failure after the words, and a scene-content load's notes after the first line", () => {
    expect(cancelled({ success: false, error: "LoadFile failed", target: "Kevin", changes: changes([]) }, EYES).content[0].text)
      .toBe([`Asset load cancelled: ${EYES} for Kevin (NOTHING words; LoadFile failed)`, COMPARED, `NOT CHECKED: ${LOOK_LINE}`]
        .join("\n"));
    expect(cancelled({ success: false }, "C:/a/Box.iProp").content[0].text)
      .toBe("Asset load cancelled: C:/a/Box.iProp (UNSURE words; unknown error)");
    const PROJECT = "C:/p/Scene.ccProject";
    const cleared = "CC5's selection (Pants) was cleared before the project load: a project replaces the scene, and " +
      "deleting a character while one of its worn items is selected can crash CC5 (F-92).";
    expect(cancelled({ success: true, path: PROJECT, notes: [cleared] }, PROJECT).content[0].text)
      .toBe(`Asset load cancelled: ${PROJECT} (UNSURE words)\n${cleared}`);
  });

  it("is the reply only with the words: without them the same results read as before", () => {
    expect(formatLoadResult({ success: true, path: "C:/a/Box.iProp" }, "C:/a/Box.iProp"))
      .toEqual({ content: [{ type: "text", text: "Asset loaded: C:/a/Box.iProp" }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(formatLoadResult(loaded(EYES, []) as any, EYES).content[0].text.split("\n")[0])
      .toBe(`Asset loaded: ${EYES} (applied to Kevin)`);
  });
});
