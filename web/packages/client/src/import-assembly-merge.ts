/**
 * F16.1: joining S2's sessions into one (an automatic topic cut that split
 * one subject in two, or several short talks) and splitting them back, plus
 * the batch role helpers of the assembly's multi-select. Pure.
 *
 * A merge never changes the sessions or the user's edits: it is a record
 * (`SessionMerge`) applied on top of them (`applySessionMerges`), so removing
 * it gives back the N sessions exactly as they were, with every edit made to
 * them before or while they were merged. The k-th absorbed session's
 * messages are renamed `m${k}_${externalId}` in the merged one (the
 * target's keep their ids); `mergedOrigin` maps such an id back, which is how
 * edits made on the merged session are stored under the original sessions.
 */
import { defaultAttachMessage, type AssemblyEdits, type AttachPoint, type NodeRole } from "./import-assembly";
import type { ImportEdits } from "./import-plan";
import type { ParsedConversation } from "./import-tree";
import { sessionMessageTimes, sessionStartIso, sessionTimes, type TimelineSession } from "./import-timeline";

export interface SessionMerge {
  /** The session kept (the first of the merged ones in S2's order, or the one dropped onto). */
  targetKey: string;
  /** The sessions joined into it, in S2's order. */
  absorbedKeys: readonly string[];
}

/** One session of a merge: `k` is 0 for the target, 1… for the absorbed ones in their order. */
interface MergePart {
  session: TimelineSession;
  k: number;
}

/** The id a message of the k-th part has in the merged session. */
export const mergedMessageId = (k: number, externalId: string): string => (k === 0 ? externalId : `m${k}_${externalId}`);

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** The merge `key` is the target of, or the one it was absorbed into (`key` itself otherwise). */
function rootOf(merges: readonly SessionMerge[], key: string): string {
  return merges.find((merge) => merge.absorbedKeys.includes(key))?.targetKey ?? key;
}

/** Every original session a visible session stands for: itself, then what was merged into it. */
export function mergeMembers(merges: readonly SessionMerge[], key: string): string[] {
  return [key, ...(merges.find((merge) => merge.targetKey === key)?.absorbedKeys ?? [])];
}

/**
 * Merges `keysToMerge` (two or more visible sessions; one already merged brings its own parts along). The target is
 * `preferredTargetKey` when it is one of them (a drop onto a session), else the first in `orderedKeys`. Fewer than two
 * distinct visible sessions leaves the merges as they are.
 */
export function addSessionMerge(merges: readonly SessionMerge[], orderedKeys: readonly string[], keysToMerge: readonly string[], preferredTargetKey?: string): SessionMerge[] {
  const position = (key: string) => orderedKeys.indexOf(key);
  const wanted = preferredTargetKey === undefined ? keysToMerge : [...keysToMerge, preferredTargetKey];
  const roots = unique(wanted.map((key) => rootOf(merges, key))).filter((key) => position(key) >= 0);
  if (roots.length < 2) return [...merges];
  const sorted = [...roots].sort((a, b) => position(a) - position(b));
  const preferred = preferredTargetKey === undefined ? undefined : rootOf(merges, preferredTargetKey);
  const targetKey = preferred !== undefined && roots.includes(preferred) ? preferred : sorted[0]!;
  const absorbedKeys = sorted.flatMap((root) => [...(root === targetKey ? [] : [root]), ...(merges.find((merge) => merge.targetKey === root)?.absorbedKeys ?? [])]);
  return [...merges.filter((merge) => !roots.includes(merge.targetKey)), { targetKey, absorbedKeys }];
}

/** Splits a merged session back into the sessions it was made of. */
export function removeSessionMerge(merges: readonly SessionMerge[], targetKey: string): SessionMerge[] {
  return merges.filter((merge) => merge.targetKey !== targetKey);
}

/** The parts of a merge still picked (the target first); fewer than two means nothing to merge. */
function mergeParts(byKey: ReadonlyMap<string, TimelineSession>, merge: SessionMerge): MergePart[] {
  const target = byKey.get(merge.targetKey);
  if (!target) return [];
  const absorbed = unique(merge.absorbedKeys).filter((key) => key !== merge.targetKey && byKey.has(key));
  return [{ session: target, k: 0 }, ...absorbed.map((key, index) => ({ session: byKey.get(key)!, k: index + 1 }))];
}

/** Real starts only (a file's date says nothing about the conversation): the order the parts are joined in. */
const startOf = (session: TimelineSession): number => {
  const times = sessionTimes(session);
  return (times.kind === "exact" || times.kind === "manual") && times.start !== null ? times.start : Number.POSITIVE_INFINITY;
};

const msOf = (iso: string | null | undefined): number | null => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(at) ? null : at;
};

const isoOfMax = (values: ReadonlyArray<string | null | undefined>): string | null => {
  const times = values.flatMap((value) => {
    const at = msOf(value);
    return at === null ? [] : [at];
  });
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
};

/** A part's messages and versions under their merged ids, each message's time as the part placed it (a set time moves it). */
function partConversation(part: MergePart): Pick<ParsedConversation, "messages" | "branches"> {
  const times = sessionMessageTimes(part.session);
  const { messages, branches } = part.session.conversation;
  return {
    messages: messages.map((message) => ({ ...message, externalId: mergedMessageId(part.k, message.externalId), createdAt: times.get(message.externalId) ?? message.createdAt ?? null })),
    branches: branches.map((branch) => ({ ...branch, anchorExternalId: mergedMessageId(part.k, branch.anchorExternalId) })),
  };
}

/**
 * The merged session: the target's key, title, source and file, every part's messages joined oldest part first (by
 * real start; parts without one after, in the merge's order), the earliest start and the latest update. A time set on
 * any part is kept in its messages, so the merged one counts as set at its start.
 */
function mergedSession(parts: readonly MergePart[]): TimelineSession {
  const target = parts[0]!.session;
  const joined = [...parts].sort((a, b) => startOf(a.session) - startOf(b.session) || a.k - b.k).map(partConversation);
  const starts = parts.flatMap((part) => {
    const at = msOf(sessionStartIso(part.session));
    return at === null ? [] : [at];
  });
  const start = starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : null;
  const manual = parts.some((part) => msOf(part.session.manualTime) !== null);
  const conversation: ParsedConversation = {
    ...target.conversation,
    createdAt: start ?? target.conversation.createdAt,
    updatedAt: isoOfMax(parts.map((part) => part.session.conversation.updatedAt)) ?? target.conversation.updatedAt,
    messages: joined.flatMap((part) => part.messages),
    branches: joined.flatMap((part) => part.branches),
    skippedBranches: parts.reduce((sum, part) => sum + part.session.conversation.skippedBranches, 0),
    ...(start ? { timeSource: "exact" as const } : {}),
  };
  return { ...target, conversation, manualTime: manual && start ? start : target.manualTime };
}

/** Every part's message edits under the merged ids; undefined when no part has any. */
function mergedMessageEdits(parts: readonly MergePart[], messages: AssemblyEdits["messages"]): ImportEdits | undefined {
  const own = parts.flatMap((part) => {
    const edits = messages?.[part.session.key];
    return edits ? [{ k: part.k, edits }] : [];
  });
  if (own.length === 0) return undefined;
  return {
    roles: Object.fromEntries(own.flatMap(({ k, edits }) => Object.entries(edits.roles).map(([id, role]) => [mergedMessageId(k, id), role]))),
    removed: new Set(own.flatMap(({ k, edits }) => [...edits.removed].map((id) => mergedMessageId(k, id)))),
  };
}

type Absorbed = ReadonlyMap<string, { targetKey: string; k: number }>;

const withoutAbsorbed = <T>(record: Readonly<Record<string, T>> | undefined, absorbed: Absorbed): Record<string, T> | undefined =>
  record && Object.fromEntries(Object.entries(record).filter(([key]) => !absorbed.has(key)));

/** Attach points on an absorbed session move to the merged one (its renamed message); one that would hang a session on itself goes. */
function redirectAttach(attach: AssemblyEdits["attach"], absorbed: Absorbed): Record<string, AttachPoint> | undefined {
  const kept = withoutAbsorbed(attach, absorbed);
  if (!kept) return undefined;
  return Object.fromEntries(
    Object.entries(kept).flatMap(([key, point]) => {
      const into = absorbed.get(point.sessionKey);
      const next = into ? { sessionKey: into.targetKey, externalId: mergedMessageId(into.k, point.externalId) } : point;
      return next.sessionKey === key ? [] : [[key, next] as const];
    }),
  );
}

/** The edits as the merged sessions see them: an absorbed session's own entries leave, its message edits join the target's. */
function mergedEdits(edits: AssemblyEdits, applied: ReadonlyArray<{ targetKey: string; parts: readonly MergePart[] }>): AssemblyEdits {
  const absorbed: Absorbed = new Map(applied.flatMap(({ targetKey, parts }) => parts.slice(1).map((part) => [part.session.key, { targetKey, k: part.k }] as const)));
  const joinedMessages = applied.flatMap(({ targetKey, parts }) => {
    const joined = mergedMessageEdits(parts, edits.messages);
    return joined ? [[targetKey, joined] as const] : [];
  });
  const messages = { ...withoutAbsorbed(edits.messages, absorbed), ...Object.fromEntries(joinedMessages) };
  const roles = withoutAbsorbed(edits.roles, absorbed);
  const attach = redirectAttach(edits.attach, absorbed);
  const conclusions = withoutAbsorbed(edits.conclusions, absorbed);
  return {
    ...(roles ? { roles } : {}),
    ...(attach ? { attach } : {}),
    ...(conclusions ? { conclusions } : {}),
    ...(edits.messages || joinedMessages.length > 0 ? { messages } : {}),
  };
}

export interface AppliedMerges {
  /** In the given order, each merged session in its target's place and the absorbed ones left out. */
  sessions: TimelineSession[];
  /** How many original sessions each merged one is made of (absent: not merged). */
  mergedCounts: ReadonlyMap<string, number>;
  /** The edits in the merged sessions' terms. */
  edits: AssemblyEdits;
}

/** The sessions and edits with the merges applied (unchanged without any merge that still has two picked parts). */
export function applySessionMerges(sessions: readonly TimelineSession[], merges: readonly SessionMerge[], edits: AssemblyEdits = {}): AppliedMerges {
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const applied = merges.map((merge) => ({ targetKey: merge.targetKey, parts: mergeParts(byKey, merge) })).filter(({ parts }) => parts.length > 1);
  if (applied.length === 0) return { sessions: [...sessions], mergedCounts: new Map(), edits };
  const merged = new Map(applied.map(({ targetKey, parts }) => [targetKey, mergedSession(parts)]));
  const absorbed = new Set(applied.flatMap(({ parts }) => parts.slice(1).map((part) => part.session.key)));
  return {
    sessions: sessions.filter((session) => !absorbed.has(session.key)).map((session) => merged.get(session.key) ?? session),
    mergedCounts: new Map(applied.map(({ targetKey, parts }) => [targetKey, parts.length])),
    edits: mergedEdits(edits, applied),
  };
}

/**
 * Which original session and message a merged session's message is (`m2_0-user` of the merged A → the second absorbed
 * session's `0-user`); the point itself when `key` is not merged or the id is the target's own.
 */
export function mergedOrigin(sessions: readonly TimelineSession[], merges: readonly SessionMerge[], key: string, externalId: string): AttachPoint {
  const merge = merges.find((item) => item.targetKey === key);
  if (!merge) return { sessionKey: key, externalId };
  const parts = mergeParts(new Map(sessions.map((session) => [session.key, session])), merge);
  for (const part of parts.slice(1)) {
    const prefix = `m${part.k}_`;
    const own = externalId.startsWith(prefix) ? externalId.slice(prefix.length) : null;
    if (own !== null && part.session.conversation.messages.some((message) => message.externalId === own)) return { sessionKey: part.session.key, externalId: own };
  }
  return { sessionKey: key, externalId };
}

const isBranch = (role: NodeRole) => role === "merged_branch" || role === "open_branch";

/**
 * Gives every session of `keys` the role. A branch role with `targetChapterKey` (a drop on §N, or 掛在 §N in the batch
 * bar) also hangs each on that chapter at decision #3's default point for its start; the chapter itself is left out.
 */
export function applyBatchRole(edits: AssemblyEdits, sessions: readonly TimelineSession[], keys: readonly string[], role: NodeRole, targetChapterKey?: string): AssemblyEdits {
  const chapter = targetChapterKey === undefined || !isBranch(role) ? undefined : sessions.find((session) => session.key === targetChapterKey);
  const changed = chapter ? keys.filter((key) => key !== chapter.key) : [...keys];
  const roles = { ...edits.roles, ...Object.fromEntries(changed.map((key) => [key, role])) };
  if (!chapter) return { ...edits, roles };
  const points = changed.flatMap((key) => {
    const session = sessions.find((item) => item.key === key);
    const externalId = session ? defaultAttachMessage(chapter, sessionTimes(session).start, edits) : null;
    return externalId ? [[key, { sessionKey: chapter.key, externalId }] as const] : [];
  });
  return { ...edits, roles, attach: { ...edits.attach, ...Object.fromEntries(points) } };
}

/**
 * The order with `keysToMove` (kept in their relative order) placed as a group starting at `targetIndex` (as
 * `placeSession` places one), clamped to the end; keys not in the order are ignored.
 */
export function moveSessionsToIndex(order: readonly string[], keysToMove: readonly string[], targetIndex: number): string[] {
  const moving = new Set(keysToMove);
  const group = order.filter((key) => moving.has(key));
  if (group.length === 0) return [...order];
  const rest = order.filter((key) => !moving.has(key));
  const at = Math.min(Math.max(targetIndex, 0), rest.length);
  return [...rest.slice(0, at), ...group, ...rest.slice(at)];
}
