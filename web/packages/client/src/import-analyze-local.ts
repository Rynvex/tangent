/**
 * B22: the import analysis without the server (the mock client's
 * `analyzeImport`): the same checks and the same deterministic algorithm as
 * `domain.NormalizeImportAnalyzeInput` and `domain.AnalyzeImportDeterministic`
 * (domain/import_analyze*.go; keep them equal), so a plan made here is the
 * server's heuristic plan. Threading is import-topics.ts `threadUnits`. Pure;
 * no network. One known difference: the server also strips protocol markers,
 * control and zero-width characters and code fences from the texts
 * (`CleanCardText`, `FlattenUntrusted`); here they are only trimmed, so text
 * holding those can give other words or titles than the server's.
 */
import { IMPORT_MAX_BRANCH_MESSAGES, IMPORT_MAX_BRANCHES, IMPORT_MAX_CHAPTER_CUTS, IMPORT_MAX_MESSAGES } from "./b18-routes";
import { TangentError } from "./errors";
import { firstSentence } from "./extract-range";
import {
  IMPORT_ANALYZE_KEY_RUNES,
  IMPORT_ANALYZE_MAX_UNIT_MESSAGES,
  IMPORT_ANALYZE_MAX_UNITS,
  IMPORT_ANALYZE_NODE_TITLE_RUNES,
  IMPORT_ANALYZE_TEXT_RUNES,
  IMPORT_ANALYZE_TITLE_RUNES,
  isBranchRole,
  type ImportAnalyzeInput,
  type ImportAnalyzeNode,
  type ImportAnalyzePlan,
  type ImportAnalyzeUnit,
} from "./import-analyze";
import type { NodeRole } from "./import-assembly";
import { threadUnits } from "./import-topics";

/** A one-unit topic of this many messages (two rounds) is a core topic. */
const CORE_MESSAGES = 4;
/** A heuristic conclusion's runes (the assembly's ENDING_RUNES). */
const ENDING_RUNES = 120;

const runeCount = (text: string) => Array.from(text).length;

/** `domain.CutRunes`: at most `max` runes, ending with "…" when cut. */
export function cutRunes(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max || max < 1 ? text : `${chars.slice(0, max - 1).join("").trim()}…`;
}

const flatten = (text: string) => text.replace(/\s+/g, " ").trim();

function invalid(field: string, message: string): TangentError {
  return new TangentError(400, `${field}: ${message}`, "invalid_input", { field });
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Whether the server would take `value` as a unit's `startAt` (an RFC 3339 time that is a real date). */
export function isAnalyzeStartAt(value: string): boolean {
  return RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * `domain.analyzeExcerpts`: the units as the deterministic analyzer and every
 * local repair read them — question and answer cut to the 300-rune excerpt,
 * whatever was sent to the server (B26 sends more). Cutting an already cut
 * text again gives the same excerpt, so this is safe to apply twice.
 */
export function analyzeExcerpts(units: readonly ImportAnalyzeUnit[]): ImportAnalyzeUnit[] {
  return units.map((unit) => ({ ...unit, question: cutRunes(unit.question.trim(), IMPORT_ANALYZE_TEXT_RUNES), answer: cutRunes(unit.answer.trim(), IMPORT_ANALYZE_TEXT_RUNES) }));
}

function normalizeUnit(unit: ImportAnalyzeUnit, index: number, seen: Set<string>): ImportAnalyzeUnit {
  const field = `units[${index}]`;
  const key = (unit.key ?? "").trim();
  if (key === "") throw invalid(`${field}.key`, "a unit needs a key");
  if (runeCount(key) > IMPORT_ANALYZE_KEY_RUNES) throw invalid(`${field}.key`, `a key has at most ${IMPORT_ANALYZE_KEY_RUNES} characters`);
  if (seen.has(key)) throw invalid(`${field}.key`, `the key ${key} is used twice`);
  const count = unit.messageCount ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > IMPORT_ANALYZE_MAX_UNIT_MESSAGES) throw invalid(`${field}.messageCount`, `messageCount is 0 to ${IMPORT_ANALYZE_MAX_UNIT_MESSAGES}`);
  const startAt = (unit.startAt ?? "").trim();
  if (startAt !== "" && (!RFC3339.test(startAt) || Number.isNaN(Date.parse(startAt)))) throw invalid(`${field}.startAt`, "startAt is an RFC 3339 time");
  seen.add(key);
  return {
    key,
    ...(unit.title ? { title: cutRunes(flatten(unit.title), IMPORT_ANALYZE_TITLE_RUNES) } : {}),
    question: cutRunes((unit.question ?? "").trim(), IMPORT_ANALYZE_TEXT_RUNES),
    answer: cutRunes((unit.answer ?? "").trim(), IMPORT_ANALYZE_TEXT_RUNES),
    messageCount: count,
    ...(startAt ? { startAt } : {}),
  };
}

/** `domain.NormalizeImportAnalyzeInput`: the input checked (a `400 invalid_input` TangentError naming the field) and its texts cut. */
export function normalizeImportAnalyzeInput(input: ImportAnalyzeInput): ImportAnalyzeInput {
  const units = Array.isArray(input.units) ? input.units : [];
  if (units.length === 0 || units.length > IMPORT_ANALYZE_MAX_UNITS) throw invalid("units", `an analysis has 1 to ${IMPORT_ANALYZE_MAX_UNITS} units`);
  const seen = new Set<string>();
  return { ...(input.title ? { title: cutRunes(flatten(input.title), IMPORT_ANALYZE_TITLE_RUNES) } : {}), units: units.map((unit, index) => normalizeUnit(unit, index, seen)) };
}

/** What the main tree holds so far while roles are given (the assembly's TreeRoom). */
interface Room {
  main: number;
  chapters: number;
  branches: number;
}

const fitsChapter = (room: Room, count: number) => room.main + count <= IMPORT_MAX_MESSAGES && room.chapters < IMPORT_MAX_CHAPTER_CUTS;
const fitsBranch = (room: Room, count: number) => count <= IMPORT_MAX_BRANCH_MESSAGES && room.branches < IMPORT_MAX_BRANCHES;

/** `analyzeRoom.roomyRole`: a role the tree has no room for moves (`must` keeps a heuristic plan's first chapter a chapter). */
export function roomyRole(room: Room, wanted: NodeRole, must: boolean, count: number): NodeRole {
  if (must) return "chapter";
  if (isBranchRole(wanted) && !fitsBranch(room, count)) return fitsChapter(room, count) ? "chapter" : "standalone";
  if (wanted === "chapter" && !fitsChapter(room, count)) return fitsBranch(room, count) ? "merged_branch" : "standalone";
  return wanted;
}

export function roomWith(room: Room, role: NodeRole, count: number): Room {
  if (role === "chapter") return { ...room, main: room.main + count, chapters: room.chapters + 1 };
  if (isBranchRole(role)) return { ...room, branches: room.branches + 1 };
  return room;
}

export const EMPTY_ROOM: Room = { main: 0, chapters: 0, branches: 0 };

/** A node's title: its first unit's title, else question, else its answer's first sentence, else its key. */
export function unitTitle(unit: ImportAnalyzeUnit): string {
  for (const text of [unit.title ?? "", unit.question, firstSentence(unit.answer, IMPORT_ANALYZE_NODE_TITLE_RUNES)]) {
    const flat = flatten(text);
    if (flat !== "") return cutRunes(flat, IMPORT_ANALYZE_NODE_TITLE_RUNES);
  }
  return cutRunes(unit.key, IMPORT_ANALYZE_NODE_TITLE_RUNES);
}

/** A heuristic conclusion: the first sentence of a unit's answer. */
export const unitEnding = (unit: ImportAnalyzeUnit): string => firstSentence(unit.answer, ENDING_RUNES);

/** The key of a chapter's latest unit (indices) before `index`; "" when none. */
export function lastUnitBefore(units: readonly ImportAnalyzeUnit[], chapter: readonly number[], index: number): string {
  return chapter.filter((i) => i < index).map((i) => units[i]!.key).at(-1) ?? "";
}

function analyzeReason(role: NodeRole, indices: readonly number[], detour: boolean): string {
  const threaded = indices.length > 1 ? `跨段縫合 ${indices.map((i) => `#${i + 1}`).join("、")} 的同主題問答；` : "";
  if (role === "chapter") return `${threaded}貫穿對話的主題，作為主幹章節`;
  if (role === "merged_branch") return `${threaded}${detour ? "穿插於主幹期間的延伸話題，掛為支線" : "主幹放不下，改掛為支線"}`;
  return `${threaded}不在主幹範圍內的單獨話題，另存為獨立對話`;
}

/** The plan's one line (`domain.analyzeSummary`). */
export function analyzeSummary(nodes: readonly ImportAnalyzeNode[]): string {
  const chapters = nodes.filter((node) => node.role === "chapter").length;
  const branches = nodes.filter((node) => isBranchRole(node.role)).length;
  return `跨段縫合為 ${nodes.length} 個主題：${chapters} 個主幹章節、${branches} 條支線、${nodes.length - chapters - branches} 篇獨立對話`;
}

/** The innermost chapter (cluster index) whose span holds `first` strictly inside; -1 when none. */
function detourHost(first: number, clusters: readonly number[][], chapters: readonly number[]): number {
  let host = -1;
  for (const h of chapters) {
    const span = clusters[h]!;
    if (span[0]! < first && first < span.at(-1)! && (host < 0 || span[0]! > clusters[host]![0]!)) host = h;
  }
  return host;
}

function messagesOf(units: readonly ImportAnalyzeUnit[], indices: readonly number[]): number {
  return indices.reduce((sum, i) => sum + units[i]!.messageCount, 0);
}

const isCore = (units: readonly ImportAnalyzeUnit[], indices: readonly number[]) => indices.length >= 2 || messagesOf(units, indices) >= CORE_MESSAGES;

/** `domain.firstChapter`: the first core cluster, else the largest (the earliest on a tie); opening small talk is not the chapter for coming first. */
function firstChapter(units: readonly ImportAnalyzeUnit[], clusters: readonly number[][]): number {
  let largest = 0;
  for (const [i, indices] of clusters.entries()) {
    if (isCore(units, indices)) return i;
    if (indices.length > clusters[largest]!.length) largest = i;
  }
  return largest;
}

/** `domain.assignAnalyzeRoles`: the clusters' nodes and roles. */
function assignRoles(units: readonly ImportAnalyzeUnit[], clusters: readonly number[][]): ImportAnalyzeNode[] {
  const chapters: number[] = [];
  let room = EMPTY_ROOM;
  const first = firstChapter(units, clusters);
  return clusters.map((indices, ci) => {
    const host = detourHost(indices[0]!, clusters, chapters);
    const count = messagesOf(units, indices);
    const wanted: NodeRole = ci === first || (host < 0 && isCore(units, indices)) ? "chapter" : host >= 0 ? "merged_branch" : "standalone";
    const role = roomyRole(room, wanted, ci === first, count);
    room = roomWith(room, role, count);
    const node: ImportAnalyzeNode = { key: units[indices[0]!]!.key, unitKeys: indices.map((i) => units[i]!.key), title: unitTitle(units[indices[0]!]!), role };
    if (role === "chapter") chapters.push(ci);
    const attach = role === "merged_branch" ? (host >= 0 ? host : chapters.at(-1)!) : -1;
    const branch =
      attach >= 0
        ? {
            attachToKey: units[clusters[attach]![0]!]!.key,
            ...(lastUnitBefore(units, clusters[attach]!, indices[0]!) ? { attachAfterUnitKey: lastUnitBefore(units, clusters[attach]!, indices[0]!) } : {}),
            ...(unitEnding(units[indices.at(-1)!]!) ? { conclusion: unitEnding(units[indices.at(-1)!]!) } : {}),
          }
        : {};
    return { ...node, ...branch, reason: analyzeReason(role, indices, host >= 0 && role === "merged_branch") };
  });
}

/**
 * The deterministic plan of `input` (`source: "heuristic"`), as the server makes it when no model answers: units
 * threaded by topic words (threadUnits), then roles: the first core topic a chapter (else the largest), a topic starting
 * inside a chapter's span a merged branch of the innermost such chapter, other topics of two or more units (or four or
 * more messages) chapters, the rest conversations of their own, all within the import's limits. Throws a `400 invalid_input` TangentError for
 * an input the server refuses.
 */
export function analyzeImportLocal(input: ImportAnalyzeInput): ImportAnalyzePlan {
  const { title, units } = normalizeImportAnalyzeInput(input);
  const clusters = threadUnits(
    units.map((unit) => ({ title: unit.title ?? "", question: unit.question, reply: unit.answer, messages: unit.messageCount })),
    { title: title ?? "" },
  );
  const nodes = assignRoles(units, clusters);
  return { mode: "tree", source: "heuristic", summary: analyzeSummary(nodes), nodes };
}
