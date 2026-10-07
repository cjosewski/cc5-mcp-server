/**
 * F-34: what a character-content load changed besides what it was for. The plugin reads the target character just
 * before and just after the load, in the same command (cc5_changes.py), and returns plain facts in `changes`; this
 * module turns them into CHECK lines (changes the load was not for), info lines (what it applied) and NOT CHECKED
 * lines (what the comparison cannot see). The result is JSON from another process, so nothing here trusts its
 * shape and nothing throws: an unknown fact becomes a "Changed: <JSON>" line.
 */

import { warningNotes, type ToolResult } from "./util.js";

export type WornGroup = "clothing" | "hair" | "accessory";

export type ChangeFact =
  | { kind: "worn_added" | "worn_removed"; group: WornGroup; id: string; name: string }
  /** A shaping morph slider (4 dp; a slider missing from one read counts as 0). */
  | { kind: "morph"; id: string; before: number; after: number }
  /**
   * diffuse: [r, g, b] in 0-255; opacity: 0-1; blend_image: whether the Diffuse Blend channel has an image;
   * param: a shader parameter's values (name says which); present: whether the material is listed.
   */
  | {
    kind: "material"; mesh: string; material: string;
    field: "present" | "shader" | "diffuse" | "opacity" | "blend_image" | "param";
    name?: string; before: unknown; after: unknown;
  }
  | { kind: "subdivision"; before: number; after: number };

/**
 * complete: false when the comparison was switched off (CC5_CHANGE_CHECK=0), the character could not be read before
 * the load, was not found after it, or a part could not be read (a WARNING note says which). truncated: more than
 * 300 facts. skipped: materials not compared because a read ran out of time.
 */
export type ChangeFacts = {
  complete?: boolean;
  target?: string;
  target_is_first?: boolean;
  elapsed_ms?: number;
  compared?: { worn?: number; morphs?: number; materials?: number };
  skipped?: number;
  truncated?: boolean;
  facts?: ChangeFact[];
};

export type LoadJobResult = {
  success?: boolean; error?: string; path?: string; target?: string; changes?: ChangeFacts; notes?: string[];
};

/**
 * checks: every CHECK line (RB-2: a recipe supersedes some of them before it shows them, so they are capped only
 * when shown: capChecks); changed: what the load applied or changed as expected, at most MAX_LINES_PER_KIND of a
 * kind; notChecked: what it cannot see; text: the report as load_asset shows it (CHECK lines capped).
 */
export type LoadReport = { checks: string[]; changed: string[]; notChecked: string[]; text: string };

export type ContentKind =
  | "eye" | "hair" | "clothing" | "shoes" | "gloves" | "accessory" | "teeth" | "skin" | "full_skin" | "makeup" | "unknown";

const EXTENSION_KINDS: Record<string, ContentKind> = {
  ".cceye": "eye",
  ".rlhair": "hair", ".cchair": "hair", ".ihair": "hair",
  ".cccloth": "clothing", ".iclothes": "clothing", ".iclothing": "clothing",
  ".ccshoes": "shoes", ".ishoe": "shoes",
  ".ccgloves": "gloves",
  ".ccacc": "accessory", ".iacc": "accessory", ".iaccessory": "accessory",
  ".ccteeth": "teeth",
  ".ccskin": "skin", ".iskin": "skin",
};

/** The worn-item group a wearable load is for. */
const WEARABLE_GROUP: Partial<Record<ContentKind, WornGroup>> = {
  clothing: "clothing", shoes: "clothing", gloves: "clothing", hair: "hair", accessory: "accessory",
};
const SKIN_LOADS: ReadonlySet<ContentKind> = new Set<ContentKind>(["skin", "full_skin"]);
/** The skin shader's pallor offsets (cc5_skin.py), which set_skin_condition 'pale' writes. */
const PALLOR_PARAMS: ReadonlySet<string> = new Set(["_BaseColorMap Brightness", "_BaseColorMap Saturation"]);
const MAX_LINES_PER_KIND = 12;

const OLD_PLUGIN = "the installed CC5 plugin predates the change report (reinstall it with install-plugin.ps1)";
const NOTHING_CHANGED = "WARNING: CC5 reported the load as done, but nothing was added and nothing compared changed " +
  "(a Cancel answer, content already applied, or content CC5 did not apply)";
const FIT_LINE = "how it sits on the character (skin or scalp showing through, floating items): run check_fit";
const LOOK_LINE = "what CC5 shows but cannot report (hair or brows hidden, makeup or skin layers): capture the face " +
  "(frame_camera face) and the whole body (home) and compare them with captures from before the load";

/** What a content file is, by its extension (and, for a .ccSkinGenPreset, its folder). */
export function contentKind(filePath: string): ContentKind {
  const p = typeof filePath === "string" ? filePath : "";
  const ext = /\.[^./\\]+$/.exec(p)?.[0].toLowerCase() ?? "";
  if (ext === ".ccskingenpreset") {
    const folder = p.replace(/\\/g, "/").toLowerCase();
    return folder.includes("/skin/full skin/") || folder.includes("/skin/skin base/") ? "full_skin" : "makeup";
  }
  return EXTENSION_KINDS[ext] ?? "unknown";
}

/** The rule set_skin_color (cc5_api.py) and skin_targets (cc5_skin.py) use for skin materials. */
export function isSkinMaterial(name: string): boolean {
  return /skin/i.test(name) && !/eyelash/i.test(name);
}

/** The skin setting a CHECK line is about, so a recipe step that sets it again later can supersede the line. */
export function skinCheckTopic(line: string): "skin_colour" | "pallor" | null {
  if (/^skin colour on /.test(line)) return "skin_colour";
  if (/^pallor \(/.test(line)) return "pallor";
  return null;
}

type Line = { list: "checks" | "changed"; kind: string; text: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.map(fmt).join(", ");
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "none";
  return json(v);
}

/** A 0-255 colour as 0-1 values, 3 dp without trailing zeros: (0.8, 0.6, 0.502). */
function colour(v: unknown): string | undefined {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => typeof c === "number" && Number.isFinite(c))) return undefined;
  return `(${v.map((c: number) => String(Number((c / 255).toFixed(3)))).join(", ")})`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function unknownLine(f: unknown): Line {
  return { list: "changed", kind: "unknown", text: `Changed: ${json(f)}` };
}

type FactContext = { kind: ContentKind; expected?: WornGroup; skinLoad: boolean; pairs: Map<unknown, string> };

function materialLine(f: Record<string, unknown>, ctx: FactContext): Line {
  const mesh = text(f.mesh);
  const mat = text(f.material);
  const field = text(f.field);
  if (mesh === undefined || mat === undefined || field === undefined || !("before" in f) || !("after" in f)) {
    return unknownLine(f);
  }
  const { before, after } = f;
  const where = `${mesh}/${mat}`;
  const skin = isSkinMaterial(mat);
  const paramName = text(f.name);
  if (field === "diffuse" && skin) {
    const b = colour(before);
    const a = colour(after);
    if (b !== undefined && a !== undefined) {
      return ctx.skinLoad
        ? { list: "changed", kind: "material", text: `Applied: skin colour on ${mat}: ${a}` }
        : { list: "checks", kind: "material", text: `skin colour on ${mat}: ${b} -> ${a}` };
    }
  }
  if (field === "param" && skin && paramName !== undefined && PALLOR_PARAMS.has(paramName)) {
    return ctx.skinLoad
      ? { list: "changed", kind: "material", text: `Applied: ${paramName} on ${mat}: ${fmt(after)}` }
      : { list: "checks", kind: "material", text: `pallor (${paramName}) on ${mat}: ${fmt(before)} -> ${fmt(after)}` };
  }
  if (field === "blend_image" && typeof before === "boolean" && typeof after === "boolean" && before !== after) {
    // CC4 Kevin's corneas carry a Diffuse Blend image at strength 0 (F-66): only a skin material's is an injury.
    if (before && skin) {
      return { list: "checks", kind: "material", text: `injury overlay (Diffuse Blend image) removed from ${mat}` };
    }
    return { list: "changed", kind: "material", text: `Changed: ${where} Diffuse Blend image ${before ? "removed" : "added"}` };
  }
  if (field === "opacity" && typeof before === "number" && typeof after === "number" && after < before) {
    return { list: "checks", kind: "material", text: `opacity on ${where}: ${fmt(before)} -> ${fmt(after)}` };
  }
  if (field === "present" && typeof before === "boolean" && typeof after === "boolean" && before !== after) {
    return before
      ? { list: "checks", kind: "material", text: `material ${where} is gone` }
      : { list: "changed", kind: "material", text: `Changed: material ${where} added` };
  }
  const label = field === "param" ? paramName ?? "param" : field;
  return { list: "changed", kind: "material", text: `Changed: ${where} ${label}: ${fmt(before)} -> ${fmt(after)}` };
}

function factLine(f: unknown, ctx: FactContext): Line | null {
  if (!isRecord(f)) return unknownLine(f);
  const kind = f.kind;
  if (kind === "worn_added" || kind === "worn_removed") {
    const name = text(f.name);
    const group = f.group;
    if (name === undefined || (group !== "clothing" && group !== "hair" && group !== "accessory")) return unknownLine(f);
    if (kind === "worn_added") {
      if (ctx.pairs.has(f)) return null;  // reported with the hair it replaced
      return group === ctx.expected
        ? { list: "changed", kind, text: `Applied: added ${name} (${group})` }
        : { list: "checks", kind, text: `added ${name} (${group}), which this ${ctx.kind.replace(/_/g, " ")} load was not for` };
    }
    const replacement = ctx.pairs.get(f);
    if (replacement !== undefined) return { list: "changed", kind, text: `Applied: ${name} replaced by ${replacement} (hair)` };
    if (ctx.expected !== undefined && ctx.expected !== "hair" && (group === "clothing" || group === "accessory")) {
      return { list: "checks", kind, text: `removed ${name} (${group}): CC5 may have swapped it out for this item` };
    }
    return { list: "checks", kind, text: `removed ${name} (${group})` };
  }
  if (kind === "morph") {
    const id = text(f.id);
    if (id === undefined || !("before" in f) || !("after" in f)) return unknownLine(f);
    return { list: "checks", kind, text: `shaping morph ${id}: ${fmt(f.before)} -> ${fmt(f.after)}` };
  }
  if (kind === "material") return materialLine(f, ctx);
  if (kind === "subdivision") {
    if (!("before" in f) || !("after" in f)) return unknownLine(f);
    return { list: "checks", kind, text: `subdivision level: ${fmt(f.before)} -> ${fmt(f.after)}` };
  }
  return unknownLine(f);
}

/**
 * A hair load that swapped hair: removed and added hair items, paired in order. Each pair maps both facts: the
 * removed one to the new hair's name (its line), the added one to "" (no line of its own).
 */
function hairPairs(facts: unknown[]): Map<unknown, string> {
  const pairs = new Map<unknown, string>();
  const hair = (k: string) => facts.filter((f) => isRecord(f) && f.kind === k && f.group === "hair" && text(f.name) !== undefined);
  const removed = hair("worn_removed");
  const added = hair("worn_added");
  removed.forEach((r, i) => {
    const a = added[i];
    if (a === undefined) return;
    pairs.set(r, text((a as Record<string, unknown>).name) ?? "");
    pairs.set(a, "");
  });
  return pairs;
}

/** At most MAX_LINES_PER_KIND lines of each kind, then "... and <n> more" where that kind's next line was. */
function capByKind(lines: Array<{ kind: string; text: string }>): string[] {
  const out: Array<string | { more: string }> = [];
  const counts = new Map<string, number>();
  for (const l of lines) {
    const n = (counts.get(l.kind) ?? 0) + 1;
    counts.set(l.kind, n);
    if (n <= MAX_LINES_PER_KIND) out.push(l.text);
    else if (n === MAX_LINES_PER_KIND + 1) out.push({ more: l.kind });
  }
  return out.map((o) => (typeof o === "string" ? o : `... and ${(counts.get(o.more) ?? 0) - MAX_LINES_PER_KIND} more`));
}

/** The fact kind a CHECK line of this module's reports is about (worn items, shaping morphs, materials, ...). */
function checkKind(line: string): string {
  if (/^added .* \((clothing|hair|accessory)\), which this .* load was not for$/.test(line)) return "worn_added";
  if (/^removed .* \((clothing|hair|accessory)\)(: CC5 may have swapped it out for this item)?$/.test(line)) return "worn_removed";
  if (line.startsWith("shaping morph ")) return "morph";
  if (line.startsWith("subdivision level: ")) return "subdivision";
  if (/^(skin colour on |pallor \(|injury overlay \(Diffuse Blend image\) removed from |opacity on |material .* is gone$)/.test(line)) {
    return "material";
  }
  return "other";
}

/**
 * CHECK lines as a reply shows them (RB-2): at most MAX_LINES_PER_KIND of each kind of change, then "... and <n>
 * more". buildReport keeps every line, so a recipe can supersede some first and the count is of the lines left.
 */
export function capChecks(lines: string[]): string[] {
  return capByKind(lines.map((text) => ({ kind: checkKind(text), text })));
}

function closingLine(kind: ContentKind): string | undefined {
  if (kind === "unknown") return undefined;
  return WEARABLE_GROUP[kind] !== undefined ? FIT_LINE : LOOK_LINE;
}

function render(head: string | undefined, checks: string[], changed: string[], notChecked: string[]): string {
  return [
    ...(head !== undefined ? [head] : []),
    ...checks.map((l) => `CHECK ${l}`),
    ...changed,
    ...notChecked.map((l) => `NOT CHECKED: ${l}`),
  ].join("\n");
}

/** The report for one load_asset result of the file at `filePath`. Scene content (no changes, no target) has none. */
export function buildReport(result: LoadJobResult, filePath: string): LoadReport {
  const empty: LoadReport = { checks: [], changed: [], notChecked: [], text: "" };
  try {
    const r: Record<string, unknown> = isRecord(result) ? result : {};
    const kind = contentKind(filePath);
    const closing = closingLine(kind);
    const changes = isRecord(r.changes) ? r.changes : undefined;
    if (!changes) {
      if (typeof r.target !== "string" || !r.target) return empty;
      const notChecked = [OLD_PLUGIN, ...(closing !== undefined ? [closing] : [])];
      return { checks: [], changed: [], notChecked, text: render(undefined, [], [], notChecked) };
    }
    const facts: unknown[] = Array.isArray(changes.facts) ? changes.facts : [];
    const expected = WEARABLE_GROUP[kind];
    const ctx: FactContext = {
      kind, expected, skinLoad: SKIN_LOADS.has(kind), pairs: kind === "hair" ? hairPairs(facts) : new Map(),
    };
    const lines = facts.map((f) => factLine(f, ctx)).filter((l): l is Line => l !== null);
    const checks = lines.filter((l) => l.list === "checks").map((l) => l.text);
    const changed = capByKind(lines.filter((l) => l.list === "changed"));
    const complete = changes.complete === true;
    if (complete && facts.length === 0 && expected !== undefined && r.success !== false) checks.push(NOTHING_CHANGED);
    const notChecked: string[] = [];
    if (changes.truncated === true) notChecked.push("more changes than listed: the comparison stops at 300");
    const skipped = count(changes.skipped);
    if (skipped > 0) {
      notChecked.push(`${plural(skipped, "material")} ${skipped === 1 ? "was" : "were"} not compared: the comparison ran out of time`);
    }
    notChecked.push(...warningNotes(r));
    if (closing !== undefined) notChecked.push(closing);
    let head: string | undefined;
    if (complete) {
      const compared: Record<string, unknown> = isRecord(changes.compared) ? changes.compared : {};
      const seconds = (count(changes.elapsed_ms) / 1000).toFixed(1);
      head = `Compared before and after: ${plural(count(compared.worn), "worn item")}, ` +
        `${plural(count(compared.morphs), "shaping morph")}, ${plural(count(compared.materials), "material")} (${seconds} s).`;
    }
    return { checks, changed, notChecked, text: render(head, capChecks(checks), changed, notChecked) };
  } catch (err) {
    console.error("[CC5 MCP] could not read a load's change report:", err);
    return empty;
  }
}

/**
 * load_asset's reply: "Asset loaded: <path> (applied to <target>)" and the report, or the failure and, when the
 * failed load still changed something (its error says so), the report with what it changed (TS-3: also an item
 * it added as expected, so nobody loads it twice).
 */
export function formatLoadResult(result: LoadJobResult, filePath: string): ToolResult {
  const r: Record<string, unknown> = isRecord(result) ? result : {};
  const report = buildReport(result, filePath);
  if (r.success !== false) {
    const target = typeof r.target === "string" && r.target ? ` (applied to ${r.target})` : "";
    const content = [{ type: "text" as const, text: `Asset loaded: ${filePath}${target}` }];
    if (report.text) content.push({ type: "text" as const, text: report.text });
    return { content };
  }
  const content = [{ type: "text" as const, text: `Failed to load asset: ${typeof r.error === "string" ? r.error : "unknown error"}` }];
  if (report.checks.length || report.changed.length) content.push({ type: "text" as const, text: report.text });
  return { content, isError: true };
}
