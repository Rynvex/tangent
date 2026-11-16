/**
 * F14 S3–S4: how the picked sessions (in the order of S2) become imports,
 * by the coordinator's decisions on the design's open issues:
 * - `timeline` (A): one main line, every session a chapter (§1 … §n), a
 *   milestone cut where each starts. An overlap only warns (#1: the
 *   server clamps dates that go back). Over 2,000 main-line messages blocks
 *   the import and recommends the tree, never switching by itself (#2).
 * - `tree` (B): sessions that start inside the latest chapter's time are
 *   branches brought back with a card, hanging on that chapter's last
 *   message at or before their start (#3); without any overlap the first
 *   sessions (up to 2,000 messages; only the first when all fit) stay
 *   chapters and the rest become branches; a default with no room (a
 *   branch over 500 messages or past 50 branches, a chapter past 2,000
 *   messages or 50 chapters) moves (B21). Every node's role and attach
 *   point can be changed. A card's question is the session's title, its
 *   conclusion the first sentence of its last reply, never a model (#6).
 * - `batch` (C) and `standalone` nodes: one import each, in order; related
 *   to their neighbours afterwards when relations are on (#7,
 *   import-assembly-run.ts).
 * Nothing here calls the server; problems (limits, an empty card, an
 * attach point on a session that is no longer a chapter) are listed and
 * keep the import buttons disabled.
 */
import { IMPORT_MAX_BRANCH_MESSAGES, IMPORT_MAX_BRANCHES, IMPORT_MAX_CHAPTER_CUTS, IMPORT_MAX_MESSAGES, normalizeFolder, normalizeTags, type ImportConversationInput } from "./b18-routes";
import { buildImportPlan, DEFAULT_BRANCH_LABELS, type ImportBranchLabels, type ImportEdits, type ImportProblem } from "./import-plan";
import { sessionEnding, sessionMessageTimes, sessionStartIso, sessionTimes, type Interleave, type TimelineSession } from "./import-timeline";

export type AssemblyMode = "timeline" | "tree" | "batch";
export type NodeRole = "chapter" | "merged_branch" | "open_branch" | "standalone";

/** Where a branch hangs: a message (its parsed `externalId`) of a chapter session. */
export interface AttachPoint {
  sessionKey: string;
  externalId: string;
}

/** What the user changed in S2 / S3, by session key. */
export interface AssemblyEdits {
  roles?: Readonly<Record<string, NodeRole>>;
  attach?: Readonly<Record<string, AttachPoint>>;
  /** A merged branch's conclusion as edited (the prefill otherwise). */
  conclusions?: Readonly<Record<string, string>>;
  /** Roles switched and messages removed in the mini expand. */
  messages?: Readonly<Record<string, ImportEdits>>;
}

export interface AssemblyOptions {
  /** The main line's title (timeline and tree); "" takes the first chapter's. */
  title: string;
  folder: string;
  tags: readonly string[];
  labels?: ImportBranchLabels;
}

const NO_EDITS: ImportEdits = { roles: {}, removed: new Set() };
const runes = (text: string) => Array.from(text).length;
export const cutText = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return runes(flat) <= max ? flat : `${Array.from(flat).slice(0, max - 1).join("")}…`;
};
export const CARD_QUESTION_RUNES = 60;

export const editsOf = (edits: AssemblyEdits, key: string): ImportEdits => edits.messages?.[key] ?? NO_EDITS;
export const keptOf = (session: TimelineSession, edits: AssemblyEdits) => session.conversation.messages.filter((message) => !editsOf(edits, session.key).removed.has(message.externalId));
export const keptCount = (session: TimelineSession, edits: AssemblyEdits) => keptOf(session, edits).length;

/** Decision #3: sessions starting inside the latest chapter's [start, end) hang on it; the rest are chapters. */
function overlapRoles(sessions: readonly TimelineSession[]): Record<string, NodeRole> {
  const roles: Record<string, NodeRole> = {};
  let trunk: { start: number; end: number } | null = null;
  for (const session of sessions) {
    const { start, end, kind } = sessionTimes(session);
    // Only real spans count: a file's date (often the same for every file unpacked together) is no conversation time.
    const real = kind === "exact" || kind === "manual";
    const inside = real && trunk !== null && start !== null && start >= trunk.start && start < trunk.end;
    roles[session.key] = inside ? "merged_branch" : "chapter";
    if (!inside && real && start !== null) trunk = { start, end: end ?? start };
  }
  return roles;
}

/** Tree without any overlap: the first sessions while they fit in the main line stay chapters (only the first when everything fits), the others merged branches. */
function fitRoles(sessions: readonly TimelineSession[], edits: AssemblyEdits): Record<string, NodeRole> {
  const total = sessions.reduce((sum, session) => sum + keptCount(session, edits), 0);
  let running = 0;
  return Object.fromEntries(
    sessions.map((session, index) => {
      running += keptCount(session, edits);
      const chapter = index === 0 || (total > IMPORT_MAX_MESSAGES && running <= IMPORT_MAX_MESSAGES);
      return [session.key, chapter ? ("chapter" as const) : ("merged_branch" as const)];
    }),
  );
}

/** What the main tree holds so far while roles are given in order. */
interface TreeRoom {
  main: number;
  chapters: number;
  branches: number;
}

const fitsChapter = (room: TreeRoom, count: number) => room.main + count <= IMPORT_MAX_MESSAGES && room.chapters < IMPORT_MAX_CHAPTER_CUTS;
const fitsBranch = (room: TreeRoom, count: number) => count <= IMPORT_MAX_BRANCH_MESSAGES && room.branches < IMPORT_MAX_BRANCHES;

/** B21: a default role the tree has no room for moves: a branch to a chapter (else standalone), a later chapter to a branch (else standalone). */
function roomyRole(wanted: NodeRole, index: number, room: TreeRoom, count: number): NodeRole {
  if (index === 0) return "chapter";
  if (wanted === "merged_branch" && !fitsBranch(room, count)) return fitsChapter(room, count) ? "chapter" : "standalone";
  if (wanted === "chapter" && !fitsChapter(room, count)) return fitsBranch(room, count) ? "merged_branch" : "standalone";
  return wanted;
}

/** B21: the tree's default roles kept within its limits (500 messages and 50 branches, 2,000 main-line messages and 50 chapters). */
function withinTreeLimits(sessions: readonly TimelineSession[], wanted: Readonly<Record<string, NodeRole>>, edits: AssemblyEdits): Record<string, NodeRole> {
  let room: TreeRoom = { main: 0, chapters: 0, branches: 0 };
  return Object.fromEntries(
    sessions.map((session, index) => {
      const count = keptCount(session, edits);
      const role = roomyRole(wanted[session.key] ?? "chapter", index, room, count);
      if (role === "chapter") room = { ...room, main: room.main + count, chapters: room.chapters + 1 };
      if (role === "merged_branch") room = { ...room, branches: room.branches + 1 };
      return [session.key, role];
    }),
  );
}

/**
 * The roles a mode starts from. Tree (decision #3): by overlap; without any, the first sessions while they fit in 2,000
 * messages stay chapters (only the first when everything fits) and the others become merged branches. Either way a
 * default the tree has no room for moves (B21, withinTreeLimits); the user's own choices (effectiveRoles) never do.
 */
export function defaultRoles(mode: AssemblyMode, sessions: readonly TimelineSession[], edits: AssemblyEdits = {}): Record<string, NodeRole> {
  if (mode === "batch") return Object.fromEntries(sessions.map((session) => [session.key, "standalone" as const]));
  if (mode === "timeline") return Object.fromEntries(sessions.map((session) => [session.key, "chapter" as const]));
  const byOverlap = overlapRoles(sessions);
  const wanted = Object.values(byOverlap).some((role) => role !== "chapter") ? byOverlap : fitRoles(sessions, edits);
  return withinTreeLimits(sessions, wanted, edits);
}

/** The roles in force: the mode's defaults with the user's choices (timeline keeps only `standalone`; batch none). */
export function effectiveRoles(mode: AssemblyMode, sessions: readonly TimelineSession[], edits: AssemblyEdits): Record<string, NodeRole> {
  const base = defaultRoles(mode, sessions, edits);
  if (mode === "batch") return base;
  const chosen = Object.entries(edits.roles ?? {}).filter(([key, role]) => key in base && (mode === "tree" || role === "standalone"));
  return { ...base, ...Object.fromEntries(chosen) };
}

/** Each kept message's date as the server would store it (an undated one takes the one above; the first the session's start). */
export function filledTimes(session: TimelineSession, edits: AssemblyEdits): Array<{ externalId: string; at: number | null; role: string }> {
  const times = sessionMessageTimes(session);
  let previous = sessionTimes(session).start;
  return keptOf(session, edits).map((message) => {
    const own = times.get(message.externalId);
    const at = own ? Math.max(Date.parse(own), previous ?? Number.NEGATIVE_INFINITY) : previous;
    previous = at;
    return { externalId: message.externalId, at, role: edits.messages?.[session.key]?.roles[message.externalId] ?? message.role };
  });
}

/**
 * The default attach point (decision #3): the chapter's last kept message at or before the branch's start; when the branch
 * is earlier than all of them, the chapter's first reply (else its first message). Undated branches take the last message.
 */
export function defaultAttachMessage(chapter: TimelineSession, branchStart: number | null, edits: AssemblyEdits = {}): string | null {
  const times = filledTimes(chapter, edits);
  if (times.length === 0) return null;
  if (branchStart === null) return times.at(-1)!.externalId;
  const before = times.filter((item) => item.at !== null && item.at <= branchStart).at(-1);
  if (before) return before.externalId;
  return (times.find((item) => item.role === "assistant") ?? times[0]!).externalId;
}

/** decision #6: the card a merged branch is prefilled with (no model): its title (else first prompt) and its ending. */
export function prefillSessionCard(session: TimelineSession, edits: AssemblyEdits = {}): { question: string; conclusion: string } {
  const kept = keptOf(session, edits);
  const prompt = kept.find((message) => message.role === "user")?.content ?? kept[0]?.content ?? "";
  return { question: cutText(session.conversation.title || prompt, CARD_QUESTION_RUNES), conclusion: sessionEnding(kept) };
}

export type AssemblyProblem =
  | { kind: "noChapter" }
  /** The main line is over IMPORT_MAX_MESSAGES (the kind keeps its name from when that was 200). */
  | { kind: "over200"; messages: number }
  | { kind: "branchTooLong"; key: string; messages: number }
  | { kind: "sessionTooLong"; key: string; messages: number }
  | { kind: "tooManyBranches"; count: number }
  | { kind: "tooManyOpen"; count: number }
  | { kind: "tooManyChapters"; count: number }
  | { kind: "cardEmpty"; key: string }
  | { kind: "invalidAttach"; key: string; target: string }
  | { kind: "emptySession"; key: string }
  | { kind: "messageTooLong"; key: string; numbers: number[] }
  | { kind: "bodyTooLarge"; bytes: number }
  /** A date the server refuses (before 1970 or more than a day ahead), in a session's messages or the time set. */
  | { kind: "dateOutOfRange"; key: string }
  | { kind: "folder" | "tags"; problem: string };

/** One session in the preview. */
export interface BlueprintNode {
  key: string;
  role: NodeRole;
  /** §n among the chapters (1-based); null for others. */
  chapter: number | null;
  /** A branch's attach point: the chapter, the message's number in its session and its time; `valid` false when not a chapter. */
  attach: { point: AttachPoint; chapter: number | null; number: number; at: number | null; auto: boolean; valid: boolean } | null;
  /** A merged branch's card. */
  card: { question: string; conclusion: string } | null;
  messages: number;
  /** Whether it overlaps an earlier session (decision #1's warning). */
  interleaved: boolean;
}

export interface AssemblySummary {
  /** Main lines created (1 + standalones; n in batch). */
  lines: number;
  chapters: number;
  /** Merged and open branches made from sessions. */
  branches: number;
  /** Merged ones (each leaves a card). */
  cards: number;
  /** Every kept message of every session. */
  messages: number;
  from: string | null;
  to: string | null;
  /** Relations between neighbouring main lines (when relations are on). */
  relations: number;
}

export interface AssemblyBlueprint {
  mode: AssemblyMode;
  nodes: BlueprintNode[];
  /** In order: the main tree first (timeline / tree), then one per standalone session; batch: one per session. */
  imports: ImportConversationInput[];
  /** The sessions each import holds (the first is the one placed in time). */
  importKeys: string[][];
  problems: AssemblyProblem[];
  interleaves: Interleave[];
  /** Overlap, or all sessions over 2,000 messages: the tree is marked 建議. */
  recommendTree: boolean;
  summary: AssemblySummary;
  /** Restored versions of chapters left out at 50 branches. */
  droppedVersions: number;
}

export interface BuildAssemblyInput {
  mode: AssemblyMode;
  /** In S2's order. */
  sessions: readonly TimelineSession[];
  edits: AssemblyEdits;
  options: AssemblyOptions;
  /** Whether relations can be made (#7: batch still works without, and says so). */
  relations: boolean;
  /** "Now" (ms) for the server's date range; Date.now() by default. */
  now?: number;
}

/** Problems of the shared folder and tags (once for every import). */
export function organizationProblems(options: AssemblyOptions): AssemblyProblem[] {
  const folder = normalizeFolder(options.folder);
  const tags = normalizeTags(options.tags);
  return [...(folder.problem ? [{ kind: "folder" as const, problem: folder.problem }] : []), ...(tags.problem ? [{ kind: "tags" as const, problem: tags.problem }] : [])];
}

/** A per-session plan's own problems, named for the session. */
export function sessionProblems(key: string, problems: readonly ImportProblem[]): AssemblyProblem[] {
  return problems.flatMap((problem): AssemblyProblem[] => {
    if (problem.kind === "noMessages") return [{ kind: "emptySession", key }];
    if (problem.kind === "tooLong") return [{ kind: "messageTooLong", key, numbers: problem.numbers }];
    if (problem.kind === "bodyTooLarge") return [{ kind: "bodyTooLarge", bytes: problem.bytes }];
    return [];
  });
}

/** One standalone import (batch, or a node set to 另存成獨立對話). */
export function standaloneImport(session: TimelineSession, input: BuildAssemblyInput): { input: ImportConversationInput; problems: AssemblyProblem[] } {
  const { edits, options } = input;
  const plan = buildImportPlan(
    session.conversation,
    editsOf(edits, session.key),
    { title: session.conversation.title, folder: options.folder, tags: options.tags, restoreBranches: true, source: session.source, messageTimes: sessionMessageTimes(session), createdAt: sessionStartIso(session) },
    options.labels ?? DEFAULT_BRANCH_LABELS,
  );
  const messages = keptCount(session, edits);
  const tooLong: AssemblyProblem[] = messages > IMPORT_MAX_MESSAGES ? [{ kind: "sessionTooLong", key: session.key, messages }] : [];
  return { input: plan.input, problems: [...tooLong, ...sessionProblems(session.key, plan.problems)] };
}

