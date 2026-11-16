/**
 * B22 / F16.2: the analysis and the F14 assembly. Sessions become units
 * (each Q&A round of a mixed conversation its own session first, so even one
 * conversation can grow a tree: `expandSessionsToTurnUnits`), and a plan
 * becomes the assembly's state (`applyAnalyzePlanToAssembly`): each node's
 * units joined by a SessionMerge (lossless: removing it gives the units back),
 * its role, a branch's attach point and card, in the order of the plan. Pure.
 */
import { IMPORT_ANALYZE_ANSWER_RUNES, IMPORT_ANALYZE_QUESTION_RUNES, isBranchRole, type ImportAnalyzePlan, type ImportAnalyzeUnit } from "./import-analyze";
import { cutRunes, isAnalyzeStartAt } from "./import-analyze-local";
import { editsOf, type AssemblyEdits, type AssemblyMode, type AttachPoint, type NodeRole } from "./import-assembly";
import { addSessionMerge, mergeMembers, type SessionMerge } from "./import-assembly-merge";
import type { ParsedConversation, ParsedMessage } from "./import-tree";
import { sessionMessageTimes, sessionStartIso, type TimelineSession } from "./import-timeline";
import { groupTurns } from "./import-topics";

/** A turn session's key: `${session.key}#turn-${k}` (k from 1). */
export const turnKey = (sessionKey: string, k: number): string => `${sessionKey}#turn-${k}`;

/** Pick orders of one session's turns stay together and in order. */
const TURN_PICK_STRIDE = 10_000;

/** A session's messages as the import would send them: removed ones left out, switched roles applied, set times kept. */
function keptMessages(session: TimelineSession, edits: AssemblyEdits): ParsedMessage[] {
  const own = editsOf(edits, session.key);
  const times = sessionMessageTimes(session);
  return session.conversation.messages
    .filter((message) => !own.removed.has(message.externalId))
    .map((message) => ({ ...message, role: own.roles[message.externalId] ?? message.role, createdAt: times.get(message.externalId) ?? message.createdAt ?? null }));
}

/** A turn's conversation: its messages, the versions hanging on them, and its own times (the session's start when undated). */
function turnConversation(session: TimelineSession, messages: readonly ParsedMessage[], k: number): ParsedConversation {
  const ids = new Set(messages.map((message) => message.externalId));
  const dated = messages.flatMap((message) => (message.createdAt ? [message.createdAt] : []));
  const start = dated[0] ?? sessionStartIso(session) ?? null;
  const { conversation } = session;
  const question = messages.find((message) => message.role === "user")?.content ?? messages[0]?.content ?? "";
  return {
    ...conversation,
    title: cutRunes(question.replace(/\s+/g, " ").trim(), 60) || `${conversation.title} #${k}`,
    createdAt: start,
    updatedAt: dated.at(-1) ?? start,
    messages: [...messages],
    branches: conversation.branches.filter((branch) => ids.has(branch.anchorExternalId)),
    skippedBranches: k === 1 ? conversation.skippedBranches : 0,
  };
}

/**
 * A session or a turn as the unit sent to the server (B26): its first
 * question and its replies, cut to what the server takes (600 / 2,000 runes),
 * and when it began if its first message has a real time. Anything that
 * analyses locally reads the 300-rune excerpts instead (`analyzeExcerpts`).
 */
function unitOf(key: string, messages: readonly ParsedMessage[], title = ""): ImportAnalyzeUnit {
  const [turn] = groupTurns(messages);
  const question = turn?.question ?? "";
  const answer = messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n");
  const startAt = messages[0]?.createdAt ?? "";
  return {
    key,
    ...(title ? { title } : {}),
    question: cutRunes(question.trim(), IMPORT_ANALYZE_QUESTION_RUNES),
    answer: cutRunes(answer.trim(), IMPORT_ANALYZE_ANSWER_RUNES),
    messageCount: messages.length,
    ...(isAnalyzeStartAt(startAt) ? { startAt } : {}),
  };
}

export interface TurnExpansion {
  /** One session per round, in the sessions' order (each keeps its source, file and id: importing it remembers its source). */
  turnSessions: TimelineSession[];
  units: ImportAnalyzeUnit[];
}

/**
 * Every round (a question and the replies after it) of the sessions as its own session (`${key}#turn-${k}`) and unit,
 * so interleaved topics inside one conversation can be threaded. The edits' removed messages are left out and its
 * switched roles and set times applied (the turn sessions carry them; the edits are not needed again).
 */
export function expandSessionsToTurnUnits(sessions: readonly TimelineSession[], edits: AssemblyEdits = {}): TurnExpansion {
  const turnSessions: TimelineSession[] = [];
  const units: ImportAnalyzeUnit[] = [];
  for (const session of sessions) {
    groupTurns(keptMessages(session, edits)).forEach((turn, index) => {
      const key = turnKey(session.key, index + 1);
      turnSessions.push({ ...session, key, conversation: turnConversation(session, turn.messages, index + 1), pickOrder: session.pickOrder * TURN_PICK_STRIDE + index, manualTime: null });
      units.push(unitOf(key, turn.messages));
    });
  }
  return { turnSessions, units };
}

/** The sessions themselves as units (one unit each: title, first question, replies), when rounds are not expanded. */
export function sessionsToUnits(sessions: readonly TimelineSession[], edits: AssemblyEdits = {}): ImportAnalyzeUnit[] {
  return sessions.map((session) => unitOf(session.key, keptMessages(session, edits), session.conversation.title));
}

export interface AppliedAnalyzePlan {
  /** The sessions in the plan's order (each node's units together), a node's first session titled as the node. */
  sessions: TimelineSession[];
  /** The order for the assembly: every node's sessions, each merged one followed by its parts. */
  order: string[];
  mode: AssemblyMode;
  merges: SessionMerge[];
  /** By node key. */
  roles: Record<string, NodeRole>;
  /** A branch's point, in the original sessions' terms (the chapter's unit the branch forked after, its last message). */
  attach: Record<string, AttachPoint>;
  conclusions: Record<string, string>;
  reasons: Record<string, string>;
  titles: Record<string, string>;
  /** Every node's units. */
  unitMap: Record<string, string[]>;
}

/** The message a branch hangs after in a unit: its last reply (else its last message). */
function lastMessageOf(session: TimelineSession | undefined): string | null {
  const messages = session?.conversation.messages ?? [];
  return ([...messages].reverse().find((message) => message.role === "assistant") ?? messages.at(-1))?.externalId ?? null;
}

/** A branch node's point: after `attachAfterUnitKey` (else the chapter's first unit), in the original terms. */
function attachPointOf(byKey: ReadonlyMap<string, TimelineSession>, chapterUnits: readonly string[], afterKey: string | undefined): AttachPoint | null {
  const unit = afterKey && chapterUnits.includes(afterKey) ? afterKey : chapterUnits[0];
  const externalId = unit ? lastMessageOf(byKey.get(unit)) : null;
  return unit && externalId ? { sessionKey: unit, externalId } : null;
}

/**
 * The assembly state of a plan over `sessions` (the units' sessions: turn sessions, or the picked ones). Each node of
 * two or more units is one SessionMerge (its first unit the target; `baseMerges` already made are folded in), with the
 * node's role, title and reason; a branch hangs after its `attachAfterUnitKey` with the plan's conclusion. Sessions
 * the plan leaves out stay, after the plan's.
 */
export function applyAnalyzePlanToAssembly(sessions: readonly TimelineSession[], plan: ImportAnalyzePlan, baseMerges: readonly SessionMerge[] = []): AppliedAnalyzePlan {
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const nodes = plan.nodes.map((node) => ({ ...node, unitKeys: node.unitKeys.filter((key) => byKey.has(key)) })).filter((node) => node.unitKeys.length > 0);
  const planned = nodes.flatMap((node) => node.unitKeys);
  const merges = nodes.reduce<SessionMerge[]>((all, node) => (node.unitKeys.length > 1 ? addSessionMerge(all, planned, node.unitKeys, node.unitKeys[0]) : all), [...baseMerges]);
  const keyOf = (node: (typeof nodes)[number]) => node.unitKeys[0]!;
  // A branch's chapter, by the chapter's key or any of its units.
  const chapterOf = new Map(nodes.filter((node) => node.role === "chapter").flatMap((node) => [node.key, ...node.unitKeys].map((key) => [key, node.unitKeys] as const)));
  const covered = new Set(nodes.flatMap((node) => node.unitKeys.flatMap((key) => mergeMembers(merges, key))));
  const order = [...nodes.flatMap((node) => mergeMembers(merges, keyOf(node))), ...sessions.map((session) => session.key).filter((key) => !covered.has(key))];
  const titles = Object.fromEntries(nodes.flatMap((node) => (node.title ? [[keyOf(node), node.title] as const] : [])));
  const attach = Object.fromEntries(
    nodes.flatMap((node) => {
      const chapter = isBranchRole(node.role) && node.attachToKey ? chapterOf.get(node.attachToKey) : undefined;
      const point = chapter ? attachPointOf(byKey, chapter, node.attachAfterUnitKey) : null;
      return point ? [[keyOf(node), point] as const] : [];
    }),
  );
  const ordered = order.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []));
  return {
    sessions: ordered.map((session) => (titles[session.key] ? { ...session, conversation: { ...session.conversation, title: titles[session.key]! } } : session)),
    order,
    mode: nodes.some((node) => isBranchRole(node.role)) ? "tree" : plan.mode,
    merges,
    roles: Object.fromEntries(nodes.map((node) => [keyOf(node), node.role])),
    attach,
    conclusions: Object.fromEntries(nodes.flatMap((node) => (node.role === "merged_branch" && node.conclusion ? [[keyOf(node), node.conclusion] as const] : []))),
    reasons: Object.fromEntries(nodes.flatMap((node) => (node.reason ? [[keyOf(node), node.reason] as const] : []))),
    titles,
    unitMap: Object.fromEntries(nodes.map((node) => [keyOf(node), [...node.unitKeys]])),
  };
}
