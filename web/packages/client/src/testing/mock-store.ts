/**
 * The mock client's state and pure, immutable updates of it. Every change
 * returns a new state; the client swaps it in and then publishes events.
 */
import type { Comparison } from "../comparison-routes";
import type { Memory } from "../memory-routes";
import type { Memo } from "../memo-routes";
import type { Term } from "../glossary-routes";
import type { Fold } from "../fold-routes";
import { TangentError } from "../errors";
import type { BranchCard, BranchPack, BranchView, Delta, Goal, Leaf, LineView, Link, Message, Note, Seed, Suggestion } from "../types";
import type { Group } from "../group-routes";
import type { MockChapters, MockScenario } from "./scenario";

export interface MockImportBatch {
  id: string;
  label: string;
  createdAt: string;
}

export interface MockImportBaseline {
  activityAt: string;
  seq: number;
}

export interface MockState {
  lines: readonly LineView[];
  messages: readonly Message[];
  branches: readonly BranchView[];
  draftCards: Readonly<Record<string, BranchCard>>;
  /** The parent's newest message when each branch's draft was made (`draft.parentTipMessageId`). */
  draftTips: Readonly<Record<string, string>>;
  /** B17: the pack a branch opened here got (a snapshot: a card edited later does not change it). */
  packs: Readonly<Record<string, BranchPack>>;
  notesByRoot: Readonly<Record<string, readonly Note[]>>;
  notesRevision: Readonly<Record<string, number>>;
  chaptersByLine: Readonly<Record<string, MockChapters>>;
  /** B8: every branch's leaf (mirrored as `BranchView.leaf`), the parked seeds and the suggestions of every tree. */
  leaves: Readonly<Record<string, Leaf>>;
  seeds: readonly Seed[];
  /** B13: memos of every tree, oldest first. */
  memos: readonly Memo[];
  /** B24: glossary terms of every tree. */
  terms: readonly Term[];
  /** B25: client-named import batches and per-line baselines for change detection. */
  importBatches: readonly MockImportBatch[];
  importBaselines: Readonly<Record<string, MockImportBaseline>>;
  suggestions: readonly Suggestion[];
  /** B8 phase B: spinoff links, oldest first; B9: relations too (kind `relation`). */
  links: readonly Link[];
  /** B9 phase C: groups of every tree. */
  groups: readonly Group[];
  /** B10 phase A: folds of every line (removed ones kept, as the server keeps them). */
  folds: readonly Fold[];
  /** B10 phase B: comparisons of every parent line, oldest first. */
  comparisons: readonly Comparison[];
  /** B10 phase C: the tenant's memories, oldest first (superseded ones kept). */
  memories: readonly Memory[];
  /** B9: each tree's goal, by main line. */
  goals: Readonly<Record<string, Goal>>;
  /**
   * B9: the "now" open loops are measured from (the scenario's own present,
   * so whether its branches are stale does not depend on when the demo runs).
   */
  openLoopsNow: string;
  /** Deltas of the running turn, per line. */
  deltas: Readonly<Record<string, readonly Delta[]>>;
  /** Delta seqs come from their own counter, far above message seqs (like the server's). */
  deltaSeq: number;
  seq: number;
  ids: number;
}

const DELTA_SEQ_START = 1_000_000;

/** Days without activity after which an open branch is stale (domain `Limits.OpenLoops.StaleAfter`). */
export const MOCK_STALE_DAYS = 3;
const DAY_MS = 86_400_000;

/** ISO time `days` before `iso`. */
export function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * DAY_MS).toISOString();
}

export function initialState(scenario: MockScenario, now: string = new Date().toISOString()): MockState {
  const seq = scenario.messages.reduce((max, message) => Math.max(max, message.seq), 0);
  const notesRevision = Object.fromEntries(Object.entries(scenario.notesByRoot).map(([root, notes]) => [root, notes.length]));
  return {
    lines: scenario.lines,
    messages: scenario.messages,
    branches: scenario.branches,
    draftCards: scenario.draftCards,
    draftTips: {},
    packs: {},
    notesByRoot: scenario.notesByRoot,
    notesRevision,
    chaptersByLine: scenario.chaptersByLine,
    leaves: scenario.leaves ?? {},
    seeds: scenario.seeds ?? [],
    memos: scenario.memos ?? [],
    terms: scenario.terms ?? [],
    importBatches: [],
    importBaselines: {},
    suggestions: scenario.suggestions ?? [],
    links: [],
    goals: scenario.goals ?? {},
    groups: [],
    folds: [],
    comparisons: [],
    memories: [],
    openLoopsNow: scenario.now ?? now,
    deltas: {},
    deltaSeq: DELTA_SEQ_START,
    seq,
    ids: 0,
  };
}

/** A fresh id; returns the next state too, because ids are part of it. */
export function newId(state: MockState, prefix: string): [string, MockState] {
  const ids = state.ids + 1;
  return [`${prefix}-mock-${ids}`, { ...state, ids }];
}

export function findLine(state: MockState, lineId: string): LineView {
  const line = state.lines.find((item) => item.id === lineId);
  if (!line) throw new TangentError(404, `line ${lineId} not found`, "line_not_found");
  return line;
}

export function findBranch(state: MockState, lineId: string): BranchView {
  const branch = state.branches.find((item) => item.lineId === lineId);
  if (!branch) throw new TangentError(404, `line ${lineId} is not a branch`, "branch_not_found");
  return branch;
}

export function rootOf(line: LineView): string {
  return line.conversationBranch?.rootLineId || line.id;
}

/** Messages of one line, ordered by seq (never by created_at). */
export function messagesOf(state: MockState, lineId: string): Message[] {
  return state.messages.filter((message) => message.lineId === lineId).sort((a, b) => a.seq - b.seq);
}

export function withLine(state: MockState, line: LineView): MockState {
  const exists = state.lines.some((item) => item.id === line.id);
  return { ...state, lines: exists ? state.lines.map((item) => (item.id === line.id ? line : item)) : [...state.lines, line] };
}

export function withMessage(state: MockState, message: Message): MockState {
  const exists = state.messages.some((item) => item.id === message.id);
  return { ...state, messages: exists ? state.messages.map((item) => (item.id === message.id ? message : item)) : [...state.messages, message] };
}

export function withBranch(state: MockState, branch: BranchView): MockState {
  const exists = state.branches.some((item) => item.lineId === branch.lineId);
  return { ...state, branches: exists ? state.branches.map((item) => (item.lineId === branch.lineId ? branch : item)) : [...state.branches, branch] };
}

export function withDeltas(state: MockState, lineId: string, deltas: readonly Delta[]): MockState {
  return { ...state, deltas: { ...state.deltas, [lineId]: deltas } };
}

/** The line with its direct-branch counts and branch unread recomputed. */
export function recount(state: MockState, lineId: string): LineView {
  const line = findLine(state, lineId);
  const children = state.branches.filter((branch) => branch.parentLineId === lineId);
  const counts = { open: 0, merged: 0, discarded: 0, promoted: 0 };
  for (const child of children) counts[child.status] += 1;
  const branchUnread = state.branches.filter((branch) => branch.rootLineId === rootOf(line) && branch.lineId !== lineId).reduce((sum, branch) => sum + branch.unread, 0);
  // B8.2: whether the conversation it came from still exists, checked when read.
  const spunOffFrom = line.spunOffFrom ? { ...line.spunOffFrom, available: state.lines.some((item) => item.id === line.spunOffFrom?.lineId) } : null;
  if (line.conversationBranch) return { ...line, branchCounts: counts, openSeeds: 0, openSuggestions: 0, staleBranches: 0, spunOffFrom };
  // B8: the 待處理 counts live on the main line only; B9 adds the stale branches.
  const openSeeds = state.seeds.filter((seed) => seed.rootLineId === lineId && seed.status === "open").length;
  const openSuggestions = state.suggestions.filter((suggestion) => suggestion.rootLineId === lineId && suggestion.status === "open").length;
  const staleBranches = staleBranchesOf(state, lineId, MOCK_STALE_DAYS).length;
  return { ...line, branchCounts: counts, branchUnread, openSeeds, openSuggestions, staleBranches, spunOffFrom };
}

/** Open branches of a tree (or every tree, `root` null) idle for `days`, the longest-idle first; archived trees are left out. */
export function staleBranchesOf(state: MockState, root: string | null, days: number): BranchView[] {
  const before = daysBefore(state.openLoopsNow, days);
  const archived = new Set(state.lines.filter((line) => line.archivedAt).map((line) => line.id));
  // A turn moves the branch line's activity, not the stored view's (the server reads the line's).
  const activity = new Map(state.lines.map((line) => [line.id, line.lastActivityAt]));
  return state.branches
    .filter((branch) => branch.status === "open" && (root === null || branch.rootLineId === root) && !archived.has(branch.rootLineId))
    .map((branch) => ({ ...branch, lastActivityAt: activity.get(branch.lineId) ?? branch.lastActivityAt }))
    .filter((branch) => branch.lastActivityAt < before)
    .sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt));
}

/** Takes the next global seq. */
export function takeSeq(state: MockState): [number, MockState] {
  const seq = state.seq + 1;
  return [seq, { ...state, seq }];
}
