/**
 * F14 S1–S2: several conversations, from several files, put in time order
 * before they are assembled (import-assembly.ts). Pure:
 * - each session's start and end (a time the user set > the source's
 *   createdAt > its first dated message > updatedAt > the file's time;
 *   none at all for pasted text without dates), oldest first, the
 *   undated after the dated in the order they were checked;
 * - time overlaps (a session that starts while an earlier one is still
 *   going: the interleave of decision #1);
 * - the "mini expand": a session cut into stretches wherever two messages
 *   are 30 minutes or more apart, with the gap, the turns, a first line,
 *   the regenerations hanging there and how it ends;
 * - search over titles and first prompts, the picked selection's summary,
 *   and already-imported detection (decision #10).
 */
import { firstSentence } from "./extract-range";
import type { ImportSourceKind, ParsedConversation } from "./import-tree";
import { SESSION_GAP_MS } from "./time-gaps";

const SUMMARY_RUNES = 40;
const ENDING_RUNES = 120;

/** One conversation picked for an assembly. */
export interface TimelineSession {
  /** Unique within the dialog (file and conversation). */
  key: string;
  conversation: ParsedConversation;
  source: ImportSourceKind;
  /** The file it came from ("" for pasted text). */
  fileName: string;
  /** In which order it was checked (0-based): the order of sessions without any time. */
  pickOrder: number;
  /** A start the user set (ISO); it moves the whole session. */
  manualTime?: string | null;
}

export type SessionTimeKind = "manual" | "exact" | "file" | "none";

export interface SessionTimes {
  kind: SessionTimeKind;
  /** ms; null without any time. */
  start: number | null;
  end: number | null;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
};

/** The source's own start and end, ignoring a time the user set. */
function ownTimes(conversation: ParsedConversation): { start: number | null; end: number | null } {
  const dated = conversation.messages.flatMap((message) => {
    const at = ms(message.createdAt);
    return at === null ? [] : [at];
  });
  const start = ms(conversation.createdAt) ?? (dated.length > 0 ? Math.min(...dated) : null) ?? ms(conversation.updatedAt);
  const end = dated.length > 0 ? Math.max(...dated) : (ms(conversation.updatedAt) ?? start);
  return { start, end: start !== null && end !== null ? Math.max(start, end) : end };
}

/** When a session starts and ends, and where that comes from. */
export function sessionTimes(session: TimelineSession): SessionTimes {
  const own = ownTimes(session.conversation);
  const manual = ms(session.manualTime);
  if (manual !== null) {
    const length = own.start !== null && own.end !== null ? own.end - own.start : 0;
    return { kind: "manual", start: manual, end: manual + length };
  }
  if (own.start !== null) return { kind: "exact", start: own.start, end: own.end ?? own.start };
  const file = ms(session.conversation.fileTime);
  if (file !== null) return { kind: "file", start: file, end: file };
  return { kind: "none", start: null, end: null };
}

/**
 * How much a session's own message times move: a start the user set shifts them all (0 otherwise). Messages without a
 * time stay without one; a session without any gets the user's time on its first message (`sessionMessageTimes`).
 */
export function sessionMessageTimes(session: TimelineSession): Map<string, string> {
  const own = ownTimes(session.conversation);
  const manual = ms(session.manualTime);
  const shift = manual !== null && own.start !== null ? manual - own.start : 0;
  const out = new Map<string, string>();
  for (const message of session.conversation.messages) {
    const at = ms(message.createdAt);
    if (at !== null) out.set(message.externalId, new Date(at + shift).toISOString());
  }
  const first = session.conversation.messages[0];
  if (manual !== null && out.size === 0 && first) out.set(first.externalId, new Date(manual).toISOString());
  return out;
}

/** The session's start as ISO for the import's `createdAt`; null without one or with only the file's time. */
export function sessionStartIso(session: TimelineSession): string | null {
  const times = sessionTimes(session);
  return times.start !== null && (times.kind === "manual" || times.kind === "exact") ? new Date(times.start).toISOString() : null;
}

/**
 * Oldest first: dated sessions by start (ties keep `previous` order, else the pick order), then the undated in that order.
 * `previous` is the current order when the user changed a time (re-sorting keeps what they dragged among equals).
 */
export function orderByTime(sessions: readonly TimelineSession[], previous: readonly string[] = []): string[] {
  const rank = (session: TimelineSession) => {
    const at = previous.indexOf(session.key);
    return at >= 0 ? at : previous.length + session.pickOrder;
  };
  const withTimes = sessions.map((session) => ({ session, start: sessionTimes(session).start, rank: rank(session) }));
  const dated = withTimes.filter((item) => item.start !== null).sort((a, b) => a.start! - b.start! || a.rank - b.rank);
  const undated = withTimes.filter((item) => item.start === null).sort((a, b) => a.rank - b.rank);
  return [...dated, ...undated].map((item) => item.session.key);
}

/** The order with `key` moved by `delta` places (drag, Alt+↑/↓, 上移／下移), clamped to the ends. */
export function moveSession(order: readonly string[], key: string, delta: number): string[] {
  const from = order.indexOf(key);
  if (from < 0 || delta === 0) return [...order];
  const to = Math.min(Math.max(from + delta, 0), order.length - 1);
  const rest = order.filter((item) => item !== key);
  return [...rest.slice(0, to), key, ...rest.slice(to)];
}

/** The order with `key` placed at `index` (drop). */
export function placeSession(order: readonly string[], key: string, index: number): string[] {
  return moveSession(order, key, index - order.indexOf(key));
}

/** Whether every session lacks any time (decision #4: kept in the order checked, and said so). */
export function allUntimed(sessions: readonly TimelineSession[]): boolean {
  return sessions.length > 0 && sessions.every((session) => sessionTimes(session).start === null);
}

/** A session starting while an earlier one in the order is still going (decision #1). */
export interface Interleave {
  /** The session that starts inside the other. */
  inner: string;
  /** The nearest earlier session it starts inside. */
  outer: string;
  /** When the inner one starts (ms). */
  at: number;
}

/** Every session that starts inside an earlier one's [start, end) (the nearest such earlier one), in order. */
export function findInterleaves(order: readonly string[], sessions: ReadonlyMap<string, TimelineSession>): Interleave[] {
  // Only real spans: a file's date says nothing about when the conversation happened (decision #4).
  const times = order.map((key) => ({ key, ...sessionTimes(sessions.get(key)!) })).map((item) => (item.kind === "exact" || item.kind === "manual" ? item : { ...item, start: null, end: null }));
  const out: Interleave[] = [];
  times.forEach((inner, index) => {
    if (inner.start === null) return;
    for (let i = index - 1; i >= 0; i -= 1) {
      const outer = times[i]!;
      if (outer.start !== null && outer.end !== null && outer.start <= inner.start && inner.start < outer.end) {
        out.push({ inner: inner.key, outer: outer.key, at: inner.start });
        return;
      }
    }
  });
  return out;
}

/** One stretch of a session (messages less than 30 minutes apart). */
export interface MiniSegment {
  /** 1-based numbers in the session (removed messages counted, as in the preview). */
  from: number;
  to: number;
  start: string | null;
  end: string | null;
  /** The user's messages in it. */
  turns: number;
  /** Its first prompt's first sentence (40 characters). */
  summary: string;
  /** Edits and regenerations hanging on its messages. */
  regenerations: number;
  /** The pause before it (ms); null for the first. */
  gapBeforeMs: number | null;
  messageIds: string[];
}

export interface MiniExpand {
  segments: MiniSegment[];
  /** Pauses of 30 minutes or more (segments − 1). */
  breaks: number;
  regenerations: number;
  /** The last reply's first sentence (the card a merged branch is prefilled with). */
  ending: string;
  /** Kept messages. */
  messageCount: number;
}

type Indexed = { message: ParsedConversation["messages"][number]; index: number };

/** The messages grouped where the dated ones are 30 minutes or more apart (undated ones stay with the group they are in). */
function groupByPause(messages: ParsedConversation["messages"]): Array<{ items: Indexed[]; gapBeforeMs: number | null }> {
  const groups: Array<{ items: Indexed[]; gapBeforeMs: number | null }> = [];
  let lastAt: number | null = null;
  messages.forEach((message, index) => {
    const at = ms(message.createdAt);
    const gap = at !== null && lastAt !== null ? at - lastAt : null;
    if (groups.length === 0 || (gap !== null && gap >= SESSION_GAP_MS)) groups.push({ items: [], gapBeforeMs: groups.length === 0 ? null : gap });
    groups.at(-1)!.items.push({ message, index });
    if (at !== null) lastAt = at;
  });
  return groups;
}

/** A session cut at its pauses of 30 minutes or more; one segment when it has no times. */
export function buildMiniExpand(conversation: ParsedConversation, removed: ReadonlySet<string> = new Set()): MiniExpand {
  const regenAt = new Map<string, number>();
  for (const branch of conversation.branches) regenAt.set(branch.anchorExternalId, (regenAt.get(branch.anchorExternalId) ?? 0) + 1);
  const segments = groupByPause(conversation.messages).map(({ items, gapBeforeMs }): MiniSegment => {
    const dated = items.flatMap(({ message }) => (message.createdAt && ms(message.createdAt) !== null ? [message.createdAt] : []));
    const prompt = items.find(({ message }) => message.role === "user")?.message ?? items[0]!.message;
    return {
      from: items[0]!.index + 1,
      to: items.at(-1)!.index + 1,
      start: dated[0] ?? null,
      end: dated.at(-1) ?? null,
      turns: Math.max(items.filter(({ message }) => message.role === "user").length, 1),
      summary: firstSentence(prompt.content, SUMMARY_RUNES),
      regenerations: items.reduce((sum, { message }) => sum + (regenAt.get(message.externalId) ?? 0), 0),
      gapBeforeMs,
      messageIds: items.map(({ message }) => message.externalId),
    };
  });
  const kept = conversation.messages.filter((message) => !removed.has(message.externalId));
  return { segments, breaks: Math.max(segments.length - 1, 0), regenerations: conversation.branches.length, ending: sessionEnding(kept), messageCount: kept.length };
}

/** The last reply's first sentence, else the last message's (decision #6; no model). */
export function sessionEnding(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const last = [...messages].reverse().find((message) => message.role === "assistant") ?? messages.at(-1);
  return last ? firstSentence(last.content, ENDING_RUNES) : "";
}

/** "問：… → 答：…": the first prompt and the first reply after it (first sentences). */
export function sessionGist(conversation: ParsedConversation): { question: string; answer: string } {
  const firstUser = conversation.messages.findIndex((message) => message.role === "user");
  const question = conversation.messages[Math.max(firstUser, 0)]?.content ?? "";
  const answer = conversation.messages.slice(firstUser + 1).find((message) => message.role === "assistant")?.content ?? "";
  return { question: firstSentence(question, SUMMARY_RUNES * 2), answer: firstSentence(answer, SUMMARY_RUNES * 2) };
}

// S1: search, selection and duplicates ---------------------------------------------

export interface SessionMatch {
  inTitle: boolean;
  /** The first prompt around the hit when only the prompt matches. */
  prompt: { before: string; hit: string; after: string } | null;
}

const PROMPT_CONTEXT = 24;

/** Whether a conversation matches a search (title, then first prompt; case-insensitive); null when it does not. */
export function matchSession(conversation: ParsedConversation, query: string): SessionMatch | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return { inTitle: false, prompt: null };
  if (conversation.title.toLowerCase().includes(needle)) return { inTitle: true, prompt: null };
  const prompt = (conversation.messages.find((message) => message.role === "user")?.content ?? "").replace(/\s+/g, " ").trim();
  const at = prompt.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  const before = prompt.slice(Math.max(0, at - PROMPT_CONTEXT), at);
  return { inTitle: false, prompt: { before: at > PROMPT_CONTEXT ? `…${before}` : before, hit: prompt.slice(at, at + needle.length), after: prompt.slice(at + needle.length, at + needle.length + PROMPT_CONTEXT * 2) } };
}

/** "已勾選 n 篇・共 m 則訊息・橫跨 from～to": every message (S1 has no removals yet) and the dated range (ISO). */
export function selectionSummary(sessions: readonly TimelineSession[]): { count: number; messages: number; from: string | null; to: string | null } {
  const times = sessions.map(sessionTimes).filter((item) => item.start !== null);
  const from = times.length > 0 ? Math.min(...times.map((item) => item.start!)) : null;
  const to = times.length > 0 ? Math.max(...times.map((item) => item.end ?? item.start!)) : null;
  return {
    count: sessions.length,
    messages: sessions.reduce((sum, session) => sum + session.conversation.messages.length, 0),
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
  };
}

/** Sources whose conversation ids are stable across exports (an id-based duplicate check makes sense for them). */
const STABLE_IDS: ReadonlySet<ImportSourceKind> = new Set(["chatgpt", "claude", "tangent"]);

/** "chatgpt:<id>" for a conversation with a stable id (remembered after it is imported); null otherwise. */
export function sessionSourceId(source: ImportSourceKind, conversation: ParsedConversation): string | null {
  return STABLE_IDS.has(source) && conversation.id ? `${source}:${conversation.id}` : null;
}

/** A line already in the list that a session would duplicate. */
export interface DuplicateOf {
  lineId: string | null;
  title: string;
  folder: string;
  /** The day it was imported for (ISO), when known. */
  date: string | null;
}

const sameTitle = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
const localDay = (at: number) => {
  const day = new Date(at);
  return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
};

/**
 * Decision #10: imported before when its source id was imported in this browser session, or a loaded main line has the
 * same title and was started the same day. Not blocking: the picker only warns and leaves it unchecked.
 */
export function findDuplicate(
  session: Pick<TimelineSession, "source" | "conversation" | "manualTime">,
  lines: ReadonlyArray<{ id: string; title: string; folder: string; createdAt: string }>,
  importedIds: ReadonlySet<string>,
): DuplicateOf | null {
  const id = sessionSourceId(session.source, session.conversation);
  const start = sessionTimes({ key: "", fileName: "", pickOrder: 0, ...session }).start;
  const line = start === null ? undefined : lines.find((item) => sameTitle(item.title, session.conversation.title) && ms(item.createdAt) !== null && localDay(ms(item.createdAt)!) === localDay(start));
  if (line) return { lineId: line.id, title: line.title, folder: line.folder, date: line.createdAt };
  if (id && importedIds.has(id)) return { lineId: null, title: session.conversation.title, folder: "", date: start === null ? null : new Date(start).toISOString() };
  return null;
}
