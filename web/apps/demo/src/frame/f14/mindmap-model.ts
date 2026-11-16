/**
 * F17: step 2's assembly as the mind map sees it. The assembly (and, after
 * an analysis, its units) stays the one source of truth; this only reads it:
 * every visible node's role, title, time span, rounds (#n once analyzed),
 * the chapter a branch hangs on and the round it forks after, its card and
 * the analysis' reason. Pure.
 */
import {
  extractSessionRounds,
  isBranchRole,
  mergedOrigin,
  sessionTimes,
  type AssemblyBlueprint,
  type BlueprintNode,
  type ImportMindMapInput,
  type NodeRole,
  type SessionMerge,
  type TimelineSession,
} from "@tangent/client";
import { planNodeOf, unitsOfNode, type AiAnalysis } from "./ai-tree-plan";
import { clockOf, dayOf } from "./time-format";

export interface MindMapModelNode {
  key: string;
  role: NodeRole;
  /** §n of a chapter. */
  chapter: number | null;
  title: string;
  /** "13:42–14:31" (another day: "11/03 13:42–11/04 09:10"), or "" without a time. */
  when: string;
  messages: number;
  /** Its questions (rounds) as a whole session. */
  rounds: number;
  /** The analysis' units it holds and their numbers (#n); empty before an analysis. */
  units: string[];
  turns: number[];
  /** A branch's chapter (a visible key), when it hangs on one. */
  attachTo: string | null;
  /** Analyzed: the round (#n) it forks after; before: the round of its chapter's own (1-based). */
  forkTurn: number | null;
  forkRound: number | null;
  forkMoved: boolean;
  card: { question: string; conclusion: string } | null;
  reason: string | null;
  /** Its attach point is not on a chapter. */
  invalid: boolean;
}

export interface MindMapModel {
  nodes: MindMapModelNode[];
  byKey: ReadonlyMap<string, MindMapModelNode>;
  input: ImportMindMapInput;
  /** Which node holds each round (#n), once analyzed. */
  turnHome: ReadonlyMap<number, string>;
  /** Root statistics: chapters, branches, separate conversations and messages. */
  stats: { c: number; b: number; s: number; m: number };
}

export interface MindMapSource {
  blueprint: AssemblyBlueprint;
  /** The visible sessions by key, and the picked sessions (or rounds) before merging. */
  sessions: ReadonlyMap<string, TimelineSession>;
  orderedOriginal: readonly TimelineSession[];
  merges: readonly SessionMerge[];
  analysis: AiAnalysis | null;
  forkMoved: ReadonlySet<string>;
  untitled: string;
}

/** A session's span as clock times (a day is added when it ends on another one). */
export function spanOf(session: TimelineSession): string {
  const { start, end } = sessionTimes(session);
  if (start === null) return "";
  const last = end ?? start;
  if (last <= start) return clockOf(start);
  const sameDay = new Date(start).toDateString() === new Date(last).toDateString();
  return sameDay ? `${clockOf(start)}–${clockOf(last)}` : `${dayOf(start)} ${clockOf(start)}–${dayOf(last)} ${clockOf(last)}`;
}

/** Where a branch forks: the analyzed round (#n) holding its attach point, or the round of the chapter's own session. */
function forkOf(node: BlueprintNode, source: MindMapSource, numberOf: (unit: string) => number): { turn: number | null; round: number | null } {
  const point = node.attach?.point;
  if (!point || !node.attach?.valid) return { turn: null, round: null };
  if (source.analysis) {
    const origin = mergedOrigin(source.orderedOriginal, source.merges, point.sessionKey, point.externalId);
    const turn = numberOf(origin.sessionKey);
    return { turn: turn > 0 ? turn : null, round: null };
  }
  const chapter = source.sessions.get(point.sessionKey);
  const round = chapter ? extractSessionRounds(chapter).find((item) => item.messageIds.includes(point.externalId))?.n : undefined;
  return { turn: null, round: round ?? null };
}

export function buildMindMapModel(source: MindMapSource): MindMapModel {
  const { blueprint, sessions, analysis, merges } = source;
  const numberOf = (unit: string) => (analysis ? analysis.units.findIndex((item) => item.key === unit) + 1 : 0);
  const chapters = new Set(blueprint.nodes.filter((node) => node.role === "chapter").map((node) => node.key));
  const nodes = blueprint.nodes.map((node): MindMapModelNode => {
    const session = sessions.get(node.key);
    const units = analysis ? unitsOfNode(analysis, merges, node.key).map((unit) => unit.key) : [];
    const branch = isBranchRole(node.role);
    const host = branch && node.attach?.valid && chapters.has(node.attach.point.sessionKey) ? node.attach.point.sessionKey : null;
    const fork = branch ? forkOf(node, source, numberOf) : { turn: null, round: null };
    return {
      key: node.key,
      role: node.role,
      chapter: node.chapter,
      title: session?.conversation.title || source.untitled,
      when: session ? spanOf(session) : "",
      messages: node.messages,
      rounds: session ? session.conversation.messages.filter((message) => message.role === "user").length : 0,
      units,
      turns: units.map(numberOf),
      attachTo: host,
      forkTurn: fork.turn,
      forkRound: fork.round,
      forkMoved: source.forkMoved.has(node.key),
      card: node.card,
      reason: analysis ? (planNodeOf(analysis, merges, node.key)?.reason ?? null) : null,
      invalid: branch && node.attach !== null && !node.attach.valid,
    };
  });
  const input: ImportMindMapInput = {
    mode: blueprint.mode,
    nodes: nodes.map((node) => ({ key: node.key, role: node.role, turns: node.turns, attachTo: node.attachTo, forkTurn: node.forkTurn, forkMoved: node.forkMoved })),
  };
  const turnHome = new Map(nodes.flatMap((node) => node.turns.map((turn) => [turn, node.key] as const)));
  const stats = { c: blueprint.summary.chapters, b: blueprint.summary.branches, s: nodes.filter((node) => node.role === "standalone").length, m: blueprint.summary.messages };
  return { nodes, byKey: new Map(nodes.map((node) => [node.key, node])), input, turnHome, stats };
}
