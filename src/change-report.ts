/**
 * F-34: what a character-content load changed besides what it was for. The plugin reads the target character just
 * before and just after the load, in the same command (cc5_changes.py), and returns plain facts in `changes`; this
 * module turns them into CHECK lines (changes the load was not for), info lines (what it applied), NOTE lines (what
 * CC5 does after such a load that the comparison cannot show) and NOT CHECKED lines (what the comparison cannot see).
 * The result is JSON from another process, so nothing here trusts its shape and nothing throws: an unknown fact
 * becomes a "Changed: <JSON>" line.
 */

import { errorResult, warningNotes, type ToolResult } from "./util.js";
import { SKINGEN_QUESTION } from "./prompts/content-rules.js";

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
 * kind; notes: what CC5 does after this load (F-91: the SkinGen session a SkinGen preset starts), shown as "NOTE: "
 * lines; notChecked: what it cannot see; text: the report as load_asset shows it (CHECK lines capped).
 */
export type LoadReport = { checks: string[]; changed: string[]; notes: string[]; notChecked: string[]; text: string };

/**
 * F-98 (batch F review #8, #28): the words for a load whose job was answered Cancel in CC5, picked by what its
 * before/after comparison saw: `changed` when the report shows a change (a CHECK or Applied line), `nothing` when the
 * comparison ran in full and found none (comparedNothing), else `unsure`: there was no comparison, or not all of one.
 */
export type CancelWords = { changed: string; nothing: string; unsure: string };

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
// F-91 (live): a makeup preset (Red Velvet) hid the hair, the brows and all clothing in the viewport, while list_hair
// and list_clothes still listed every item.
const LOOK_LINE = "what CC5 shows but cannot report (hair, brows or clothing hidden in the viewport, makeup or " +
  "skin layers): capture the face (frame_camera face) and the whole body (home) and compare them with captures " +
  "from before the load";
// F-91, cause (live 2026-10-07; Chad: "SkinGen editing mode"): a .ccSkinGenPreset load starts what CC5 calls a SkinGen
// session. While it lasts the viewport hides hair, brows and clothing (still worn and exported; set_item_visible does
// not show them). A prop load during it asked SKINGEN_QUESTION (OK / Cancel); after OK they showed again and the makeup
// stayed. A prop delete ended it too, without a question. Not tested: whether another SkinGen preset loaded during a
// session asks, so a content load "can ask" (batch F review #13). Shown after a SkinGen preset's load as "NOTE: <this>".
export const SKINGEN_SESSION_NOTE = "this SkinGen preset started a SkinGen session in CC5: the viewport hides hair, " +
  "brows and clothing (they stay worn and are exported) until a later content load or a delete ends it (live: a prop " +
  `delete ended it without a question). A content load during the session can ask "${SKINGEN_QUESTION}" (seen for a ` +
  "prop load): for a load the user asked for, answer OK and say so.";
/** Content kinds a .ccSkinGenPreset file has (contentKind); no other file has them. */
const SKINGEN_KINDS: ReadonlySet<ContentKind> = new Set<ContentKind>(["makeup", "full_skin"]);

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

/**
 * F-97: the eye's own meshes and materials, which an eye preset sets: CC_Base_Eye with Std_Eye_L/R and
 * Std_Cornea_L/R, and the eye occlusion and tear line beside them. The mesh or the material has the word eye, cornea,
 * eye occlusion or tear line (an underscore or a digit ends a word), so eyelashes, eyebrows and eyeglasses are not.
 */
export function isEyeMaterial(mesh: string, material: string): boolean {
  return [mesh, material].some((n) => /(^|[^a-z])(eye(_?occlusion)?|cornea|tear_?line)([^a-z]|$)/i.test(n));
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

/**
 * F-97 (live): an eye preset sets the eye's own materials (_Blue1 Eyes: the corneas' opacity 1 -> 0.8, which the
 * report showed as a CHECK line), so on an eye load a change to them is what the load applied: the value after it.
 */
function appliedEyeLine(where: string, field: string, label: string, after: unknown): Line {
  let what: string;
  if (field === "present" && typeof after === "boolean") what = `material ${where} ${after ? "added" : "removed"}`;
  else if (field === "blend_image" && typeof after === "boolean") {
    what = `Diffuse Blend image ${after ? "added to" : "removed from"} ${where}`;
  } else if (field === "diffuse") what = `diffuse colour on ${where}: ${colour(after) ?? fmt(after)}`;
  else what = `${label} on ${where}: ${fmt(after)}`;
  return { list: "changed", kind: "material", text: `Applied: ${what}` };
}

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
  const label = field === "param" ? paramName ?? "param" : field;
  if (ctx.kind === "eye" && isEyeMaterial(mesh, mat)) return appliedEyeLine(where, field, label, after);
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

function render(
  head: string | undefined, checks: string[], changed: string[], notes: string[], notChecked: string[],
): string {
  return [
    ...(head !== undefined ? [head] : []),
    ...checks.map((l) => `CHECK ${l}`),
    ...changed,
    ...notes.map((l) => `NOTE: ${l}`),
    ...notChecked.map((l) => `NOT CHECKED: ${l}`),
  ].join("\n");
}

/**
 * The report for one load_asset result of the file at `filePath`. Scene content (no changes, no target) has none.
 * `cancelled`: the load's job was answered Cancel in CC5 (F-98, batch F review #8): the report claims no SkinGen session
 * and has no nothing-changed WARNING, since the Cancel is why nothing changed.
 */
export function buildReport(result: LoadJobResult, filePath: string, cancelled = false): LoadReport {
  const empty: LoadReport = { checks: [], changed: [], notes: [], notChecked: [], text: "" };
  try {
    const r: Record<string, unknown> = isRecord(result) ? result : {};
    const kind = contentKind(filePath);
    const closing = closingLine(kind);
    // F-91: a SkinGen preset that loaded started a SkinGen session (live: Red Velvet and Cordial); a failed load claims
    // none, and neither does one answered Cancel in CC5, which may not have been done (F-98, batch F review #8).
    const notes = SKINGEN_KINDS.has(kind) && r.success !== false && !cancelled ? [SKINGEN_SESSION_NOTE] : [];
    const changes = isRecord(r.changes) ? r.changes : undefined;
    if (!changes) {
      if (typeof r.target !== "string" || !r.target) return empty;
      const notChecked = [OLD_PLUGIN, ...(closing !== undefined ? [closing] : [])];
      return { checks: [], changed: [], notes, notChecked, text: render(undefined, [], [], notes, notChecked) };
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
    if (!cancelled && complete && facts.length === 0 && expected !== undefined && r.success !== false) {
      checks.push(NOTHING_CHANGED);
    }
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
    return { checks, changed, notes, notChecked, text: render(head, capChecks(checks), changed, notes, notChecked) };
  } catch (err) {
    console.error("[CC5 MCP] could not read a load's change report:", err);
    return empty;
  }
}

/**
 * The plugin's notes on a load of scene content (no comparison and no target: a .ccAvatar, .iProp or .ccProject),
 * which buildReport has no report for, in their order (strings only). F-92 precaution: a .ccProject load clears CC5's
 * selection first, and its note names what was selected, or a WARNING note says the clear failed (the load ran).
 */
function sceneContentNotes(r: Record<string, unknown>): string[] {
  if (isRecord(r.changes) || (typeof r.target === "string" && r.target)) return [];
  return Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === "string") : [];
}

/**
 * F-98 (batch F review #8, #11): whether a load's before/after comparison ran in full and found no change: complete
 * (every part read before and after), no material left out for time, no WARNING note (such as colours CC5 reports late,
 * F-90) and no fact. Only then is a load answered Cancel in CC5 said to have applied nothing.
 */
export function comparedNothing(result: LoadJobResult): boolean {
  const r: Record<string, unknown> = isRecord(result) ? result : {};
  const changes = isRecord(r.changes) ? r.changes : undefined;
  return changes !== undefined && changes.complete === true && count(changes.skipped) === 0 &&
    Array.isArray(changes.facts) && changes.facts.length === 0 && warningNotes(r).length === 0;
}

/**
 * load_asset's reply: "Asset loaded: <path> (applied to <target>)" and the report, or the failure and, when the
 * failed load still changed something (its error says so), the report with what it changed (TS-3: also an item
 * it added as expected, so nobody loads it twice). A scene-content load has no report: the plugin's notes on it follow
 * the first line instead, also after a failure (sceneContentNotes). One text block, its lines joined by newlines:
 * Claude Code shows adjacent text blocks with no separator, so the first line and the report ran together (F-95).
 * `cancelled` (F-98, batch F review #8, #28): the load's job was answered Cancel in CC5, which CC5 still reports as
 * done. The reply is then "Asset load cancelled: <path> for <target> (<words>)", with the failure after the words when
 * the load also failed, and the report without the SkinGen session NOTE; it is an error, as a recipe step answered
 * Cancel is no step done.
 */
export function formatLoadResult(result: LoadJobResult, filePath: string, cancelled?: CancelWords): ToolResult {
  const r: Record<string, unknown> = isRecord(result) ? result : {};
  const report = buildReport(result, filePath, cancelled !== undefined);
  const notes = sceneContentNotes(r);
  const error = typeof r.error === "string" ? r.error : "unknown error";
  if (cancelled !== undefined) {
    const words = report.checks.length || report.changed.length ? cancelled.changed
      : comparedNothing(result) ? cancelled.nothing : cancelled.unsure;
    const target = typeof r.target === "string" && r.target ? ` for ${r.target}` : "";
    const head = `Asset load cancelled: ${filePath}${target} (${r.success === false ? `${words}; ${error}` : words})`;
    return errorResult([head, ...(report.text ? [report.text] : []), ...notes].join("\n"));
  }
  if (r.success !== false) {
    const target = typeof r.target === "string" && r.target ? ` (applied to ${r.target})` : "";
    const text = [`Asset loaded: ${filePath}${target}`, ...(report.text ? [report.text] : []), ...notes].join("\n");
    return { content: [{ type: "text" as const, text }] };
  }
  const failed = `Failed to load asset: ${error}`;
  return errorResult([failed, ...(report.checks.length || report.changed.length ? [report.text] : []), ...notes]
    .join("\n"));
}
