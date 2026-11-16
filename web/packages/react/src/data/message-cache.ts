/**
 * Pure updates of a cached `MessagePage` (F1). Messages are ordered by seq,
 * never by time (DESIGN §5); every helper returns a new page, or the same one
 * when nothing changed, so React Query does not re-render for nothing.
 */
import type { Message, MessagePage } from "@tangent/client";

const OPTIMISTIC_PREFIX = "tg-optimistic:";
let optimisticCount = 0;

/** True for the placeholder of a message the user just sent (not yet confirmed by the server). */
export function isOptimisticMessage(message: Message): boolean {
  return message.id.startsWith(OPTIMISTIC_PREFIX);
}

/** A user message shown at once while the send request runs; replaced by the server's copy. */
export function optimisticUserMessage(lineId: string, content: string, afterSeq: number): Message {
  optimisticCount += 1;
  return {
    id: `${OPTIMISTIC_PREFIX}${optimisticCount}`,
    seq: afterSeq + 1,
    lineId,
    role: "user",
    kind: "chat",
    content,
    status: "done",
    meta: {},
    hostMeta: {},
    createdAt: new Date().toISOString(),
    pinned: false,
  };
}

/** Every field, so a change of meta, content, status or seq is never mistaken for "unchanged". */
function sameMessage(a: Message, b: Message): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Server messages by seq, then optimistic ones in the order they were sent. */
function ordered(messages: readonly Message[]): Message[] {
  const real = messages.filter((message) => !isOptimisticMessage(message)).sort((a, b) => a.seq - b.seq);
  return [...real, ...messages.filter(isOptimisticMessage)];
}

/** True when `messages` already are as `ordered` puts them (the usual case: the same array is kept). */
function inOrder(messages: readonly Message[]): boolean {
  let seenOptimistic = false;
  let seq = -Infinity;
  for (const message of messages) {
    if (isOptimisticMessage(message)) {
      seenOptimistic = true;
      continue;
    }
    if (seenOptimistic || message.seq < seq) return false;
    seq = message.seq;
  }
  return true;
}

export interface UpsertOptions {
  /**
   * The copy comes straight from the server's event stream, which is in
   * order, so it may move a message back to pending. Request results (a send
   * or cancel response) are not: they can be older than events already applied.
   */
  authoritative?: boolean;
}

/**
 * Adds or replaces a message, keeping the page in seq order. Without
 * `authoritative`, a pending copy never replaces a finished one: the send
 * response may arrive after the reply already completed (a turn that fails at once).
 */
export function upsertMessage(page: MessagePage, message: Message, options: UpsertOptions = {}): MessagePage {
  const existing = page.messages.find((item) => item.id === message.id);
  if (existing && sameMessage(existing, message)) return page;
  if (existing && !options.authoritative && existing.status !== "pending" && message.status === "pending") return page;
  return { ...page, messages: ordered([...page.messages.filter((item) => item.id !== message.id), message]) };
}

/** Marks the given conclusion cards as delivered (a finished turn carried them to the model). */
export function markDelivered(page: MessagePage, cardIds: readonly string[]): MessagePage {
  const ids = new Set(cardIds);
  if (!page.messages.some((item) => ids.has(item.id) && !item.meta.delivered)) return page;
  return { ...page, messages: page.messages.map((item) => (ids.has(item.id) && !item.meta.delivered ? { ...item, meta: { ...item.meta, delivered: true } } : item)) };
}

export function removeMessage(page: MessagePage, messageId: string): MessagePage {
  if (!page.messages.some((item) => item.id === messageId)) return page;
  return { ...page, messages: page.messages.filter((item) => item.id !== messageId) };
}

/** The highest seq of the page (0 when empty). */
export function lastSeq(page: MessagePage | undefined): number {
  return page?.messages.reduce((max, message) => (isOptimisticMessage(message) ? max : Math.max(max, message.seq)), 0) ?? 0;
}

/**
 * The messages to show: an optimistic user message is hidden once the
 * server's list has a user message at or after its place (the event can beat
 * the send response; the response then removes it by id). No text matching.
 */
export function visibleMessages(input: readonly Message[]): readonly Message[] {
  // In seq order whatever the caller handed over (B7.2: a host's notice can come after a reply still streaming).
  const messages = inOrder(input) ? input : ordered(input);
  if (!messages.some(isOptimisticMessage)) return messages;
  const newestUser = messages.reduce((max, message) => (!isOptimisticMessage(message) && message.role === "user" ? Math.max(max, message.seq) : max), 0);
  const shown = messages.filter((message) => !isOptimisticMessage(message) || message.seq > newestUser);
  return shown.length === messages.length ? messages : shown;
}
