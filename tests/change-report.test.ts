/**
 * F-34: the load change report (src/change-report.ts) turns the plugin's before/after facts into CHECK lines (what a
 * load changed besides what it was for), info lines and NOT CHECKED lines. The facts are JSON from the plugin, so
 * malformed input must never throw.
 */

import { describe, it, expect } from "vitest";
import { buildReport, capChecks, contentKind, formatLoadResult, isSkinMaterial, skinCheckTopic } from "../src/change-report.js";

const RED_VELVET = "C:/Templates/Makeup/Lip Makeup/Makeup & SFX/Red Velvet.ccSkinGenPreset";
const FULL_SKIN = "C:/Templates/SkinGen/Skin/Full Skin/Tan.ccSkinGenPreset";
const PANTS = "C:/Users/Public/Documents/Reallusion/Reallusion Custom/Cloth/Pants/US_Army_Uniform_Pants.ccCloth";
const AFRO = "C:/Templates/Hair/Afro.rlHair";
const EYES = "C:/Templates/Eye/Eyes_02.ccEye";
const SHOES = "C:/Templates/Shoes/Boots.ccShoes";
const SKIN = "C:/Templates/Skin/Pale.ccSkin";

const FIT_LINE = "how it sits on the character (skin or scalp showing through, floating items): run check_fit";
const LOOK_LINE = "what CC5 shows but cannot report (hair or brows hidden, makeup or skin layers): capture the face " +
  "(frame_camera face) and the whole body (home) and compare them with captures from before the load";
const NOTHING = "WARNING: CC5 reported the load as done, but nothing was added and nothing compared changed (a Cancel " +
  "answer, content already applied, or content CC5 did not apply)";

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

  it("pallor offsets are a CHECK unless the load is a skin preset", () => {
    const pallor = material("CC_Base_Body", "Std_Skin_Body", "param", [0], [-0.1], "_BaseColorMap Saturation");
    expect(report(loaded(RED_VELVET, [pallor]), RED_VELVET).checks)
      .toEqual(["pallor (_BaseColorMap Saturation) on Std_Skin_Body: 0 -> -0.1"]);
    const skin = report(loaded(SKIN, [pallor]), SKIN);
    expect(skin.checks).toEqual([]);
    expect(skin.changed).toEqual(["Applied: _BaseColorMap Saturation on Std_Skin_Body: -0.1"]);
  });

  it("a removed Diffuse Blend image is an injury overlay only on skin (corneas carry one, F-66)", () => {
    const r = report(loaded(EYES, [
      material("CC_Base_Body", "Std_Skin_Arm", "blend_image", true, false),
      material("CC_Base_Eye", "Std_Cornea_R", "blend_image", true, false),
      material("CC_Base_Body", "Std_Skin_Leg", "blend_image", false, true),
    ]), EYES);
    expect(r.checks).toEqual(["injury overlay (Diffuse Blend image) removed from Std_Skin_Arm"]);
    expect(r.changed).toEqual(["Changed: CC_Base_Eye/Std_Cornea_R Diffuse Blend image removed",
      "Changed: CC_Base_Body/Std_Skin_Leg Diffuse Blend image added"]);
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

describe("buildReport: other facts", () => {
  it("materials that came or went, shaping morphs, opacity, subdivision and other values", () => {
    const r = report(loaded(EYES, [
      { kind: "morph", id: "Body Fat A", before: 0.35, after: 0 },
      material("CC_Base_Body", "Std_Nails", "present", true, false),
      material("CC_Base_Body", "Std_Extra", "present", false, true),
      material("CC_Base_Body", "Std_Skin_Head", "opacity", 1, 0.5),
      material("Hair", "Hair_Transparency", "opacity", 0.5, 1),
      material("CC_Base_Body", "Std_Skin_Head", "shader", "Pbr", "Digital_Human Skin"),
      material("CC_Base_Body", "Std_Skin_Head", "param", [0.85], [0.7], "Original Roughness Strength"),
      material("CC_Base_Eye", "Std_Cornea_R", "diffuse", [255, 255, 255], [200, 200, 200]),
      { kind: "subdivision", before: 0, after: 1 },
    ]), EYES);
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
      .toEqual({ checks: [], changed: [], notChecked: [], text: "" });
  });

  it("never throws on malformed input, and shows unknown facts as they are", () => {
    expect(report(null, PANTS)).toEqual({ checks: [], changed: [], notChecked: [], text: "" });
    expect(report({ success: true, target: "Kevin", changes: { facts: "nope", compared: 3, skipped: "x" } }, PANTS))
      .toEqual({ checks: [], changed: [], notChecked: [FIT_LINE], text: `NOT CHECKED: ${FIT_LINE}` });
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

describe("formatLoadResult", () => {
  it("keeps load_asset's first line exactly and adds the report", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = formatLoadResult(loaded(PANTS, [added("clothing", "Pants"), removed("clothing", "Boxers")]) as any, PANTS);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe(`Asset loaded: ${PANTS} (applied to Kevin)`);
    expect(r.content[1].text).toContain("CHECK removed Boxers (clothing): CC5 may have swapped it out for this item");
    expect(formatLoadResult({ success: true, path: "C:/a/Kevin.ccAvatar" }, "C:/a/Kevin.ccAvatar"))
      .toEqual({ content: [{ type: "text", text: "Asset loaded: C:/a/Kevin.ccAvatar" }] });
  });

  // TS-3: the error said the load changed something, and the reply never said what.
  it("shows what a failed load still applied, also when nothing of it needs a check", () => {
    const applied = formatLoadResult({ success: false, error: "LoadFile failed (CC5 reported an error, but it changed 1 thing)",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      changes: changes([added("clothing", "Pants")]) as any }, PANTS);
    expect(applied.isError).toBe(true);
    expect(applied.content).toHaveLength(2);
    expect(applied.content[1].text).toBe([
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
    expect(changedThings.content[0].text).toBe("Failed to load asset: boom (CC5 reported an error, but it changed 1 thing)");
    expect(changedThings.content[1].text).toContain("CHECK removed Boxers (clothing): CC5 may have swapped it out for this item");
    expect(formatLoadResult({ success: false, error: "File not found: C:/x.ccCloth" }, "C:/x.ccCloth"))
      .toEqual({ content: [{ type: "text", text: "Failed to load asset: File not found: C:/x.ccCloth" }], isError: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nothing = formatLoadResult({ success: false, error: "x", changes: changes([]) as any }, SHOES);
    expect(nothing.content).toHaveLength(1);  // no nothing-changed WARNING for a load that failed
    expect(formatLoadResult({ success: false }, PANTS).content[0].text).toBe("Failed to load asset: unknown error");
  });
});
