/**
 * High-level character creation tools.
 * These tools provide semantic, natural-language-friendly interfaces
 * for character modification.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CC5Bridge } from "../cc5-bridge.js";
import { bridgeCall } from "../util.js";

/**
 * Preset body type mappings.
 * Maps descriptive terms to morph combinations.
 */
export const BODY_PRESETS: Record<string, Array<{ morph_id: string; value: number }>> = {
  athletic: [
    { morph_id: "cc embed morphs/embed_full_body6", value: 0.6 },   // Body Muscular A
    { morph_id: "essential body morphs/pack_full_body1", value: 0.1 }, // Body Fat A
    { morph_id: "cc embed morphs/embed_full_body5", value: 0.2 },   // Body Thin
  ],
  muscular: [
    { morph_id: "cc embed morphs/embed_full_body6", value: 0.9 },   // Body Muscular A
    { morph_id: "essential body morphs/pack_full_body1", value: 0.05 }, // Body Fat A
    { morph_id: "cc embed morphs/embed_full_body5", value: 0.1 },   // Body Thin
  ],
  slim: [
    { morph_id: "cc embed morphs/embed_full_body5", value: 0.7 },   // Body Thin
    { morph_id: "essential body morphs/pack_full_body1", value: 0.0 }, // Body Fat A
    { morph_id: "cc embed morphs/embed_full_body6", value: 0.1 },   // Body Muscular A
  ],
  heavy: [
    { morph_id: "essential body morphs/pack_full_body1", value: 0.7 }, // Body Fat A
    { morph_id: "cc embed morphs/embed_full_body5", value: 0.0 },   // Body Thin
    { morph_id: "cc embed morphs/embed_full_body6", value: 0.2 },   // Body Muscular A
  ],
  average: [
    { morph_id: "essential body morphs/pack_full_body1", value: 0.3 }, // Body Fat A
    { morph_id: "cc embed morphs/embed_full_body5", value: 0.3 },   // Body Thin
    { morph_id: "cc embed morphs/embed_full_body6", value: 0.3 },   // Body Muscular A
  ],
};

export function registerCharacterTools(server: McpServer, bridge: CC5Bridge) {
  server.tool(
    "apply_body_preset",
    "Apply a predefined body type to the current character. Available presets: athletic, muscular, slim, heavy, average.",
    {
      preset: z.enum(["athletic", "muscular", "slim", "heavy", "average"])
        .describe("Body type preset name"),
      intensity: z.number().min(0).max(1).default(1.0)
        .describe("How strongly to apply the preset (0.0-1.0). Default 1.0"),
    },
    async ({ preset, intensity }) => {
      const morphs = BODY_PRESETS[preset];
      const scaled = morphs.map(m => ({
        morph_id: m.morph_id,
        value: Math.max(-1, Math.min(1, m.value * intensity)),
      }));

      return bridgeCall(
        () => bridge.setMultipleMorphs(scaled),
        (result) => result.success
          ? `Applied '${preset}' body preset at ${Math.round(intensity * 100)}% intensity`
          : `Failed: ${result.error}`,
      );
    }
  );

  server.tool(
    "describe_character",
    "Describe the current character: build from the three build sliders (Body Fat A, Body Thin, Body Muscular A; a template's own shape is a separate identity morph and is not graded), head size, and the clothing, hair and accessories it wears. Skin, eye colour and face shape are not described: look with frame_camera('face') + capture_viewport.",
    {},
    async () => bridgeCall(
      async () => {
        const info = await bridge.getAvatarInfo();
        return { info, worn: info ? await describeWorn(bridge) : "" };
      },
      ({ info, worn }) => {
        if (!info) return "No avatar in the scene.";

        const morphs = info.active_morphs;
        const descriptions: string[] = [describeBuild(morphs)];

        const headScale = morphs["cc embed morphs/embed_full_head9"] ?? 0;
        if (headScale > 0.5) descriptions.push("larger head");
        else if (headScale < -0.3) descriptions.push("smaller head");

        const morphCount = Object.keys(morphs).length;
        let text = `Character: ${info.name}\n`;
        text += `Description: ${descriptions.join(", ")}\n`;
        text += worn;
        text += `Total active morphs: ${morphCount}\n\nDetailed morph values:\n`;
        for (const [id, value] of Object.entries(morphs)) {
          text += `  ${id}: ${(value * 100).toFixed(0)}%\n`;
        }
        return text;
      },
    )
  );
}

/**
 * The build from the three build sliders. Live (F-17): heavy at 50% (Body Fat A 0.35) read "average build"; now a
 * slider that leads the others reads "slightly ...". Live (F-60): the old "no body-shape slider set: the template's
 * own build" was also printed for small and negative values and above a template's identity morph, so the
 * wording now says only what the sliders show, and names a negative slider. A template's own shape is not graded.
 */
export function describeBuild(morphs: Record<string, number>): string {
  // Whole percent before any threshold: CC5 sends float32 weights (0.4 arrives as 0.4000000059604645), so a 10% gap
  // must not depend on rounding noise.
  const pct = (v: number | undefined) => Math.round((v ?? 0) * 100);
  const shapes: Array<[string, string, number]> = [
    ["muscular", "Body Muscular A", pct(morphs["cc embed morphs/embed_full_body6"] ?? morphs["essential body morphs/pack_full_body4"])],
    ["heavy", "Body Fat A", pct(morphs["essential body morphs/pack_full_body1"] ?? morphs["cc embed morphs/embed_full_body3"])],
    ["slim", "Body Thin", pct(morphs["cc embed morphs/embed_full_body5"])],
  ];
  if (shapes.every(([, , v]) => v === 0)) {
    return "build not graded: the build sliders are not set (a template's own shape comes from its identity morph)";
  }
  const negatives = shapes.filter(([, , v]) => v <= -15).map(([, label, v]) => `${label} at ${v}%`);
  const note = negatives.length ? ` (${negatives.join(", ")})` : "";
  const [[name, label, top], [name2, label2, second], [, , third]] = [...shapes].sort((a, b) => b[2] - a[2]);
  if (top < 15) return `average build${note || " (build sliders below 15%)"}`;
  const degree = top > 50 ? "" : "slightly ";
  if (top - second >= 10) return `${degree}${name} build${note}`;
  // All three close together, e.g. the average preset (30% each).
  if (top - third < 10) return `average build${note}`;
  // A runner-up under the 15% floor is not a build trait (alone it reads "below 15%").
  if (second < 15) return `${degree}${name} build${note}`;
  // Two close together above the third: both are named (Muscular 100% with Fat 100% used to read "average build").
  return `${degree}${name}, ${name2} build (${[`${label} ${top}%`, `${label2} ${second}%`, ...negatives].join(", ")})`;
}

/** "Wearing / Hair / Accessories" lines; a list CC5 could not give is left out rather than failing the description. */
async function describeWorn(bridge: CC5Bridge): Promise<string> {
  const names = async (load: () => Promise<Array<{ name: string }>>) => {
    try { return (await load()).map((i) => i.name); } catch { return null; }
  };
  const [clothes, hair, accessories] = await Promise.all([
    names(() => bridge.listClothes()), names(() => bridge.listHair()), names(() => bridge.listAccessories()),
  ]);
  const line = (label: string, items: string[] | null) =>
    items === null ? "" : `${label}: ${items.length ? items.join(", ") : "none"}\n`;
  return line("Wearing", clothes) + line("Hair", hair) + line("Accessories", accessories);
}
