/**
 * View logic of the branch flow (F2): fork context, "the main line moved on",
 * promotion plans, aside retention, card delivery and open-branch errors.
 * Pure functions over the wire types; ordering within a line is always by seq.
 */
import { sortBySeq } from "./text";
import type { BranchView, Message } from "./types";

export { ASIDE_RETENTION_DAYS, asideDaysLeft, classifyOpenBranchError, isHostNotice, type OpenBranchFailure } from "./branch-notice";

function isChat(message: Message): boolean {
  return message.kind === "chat" && (message.role === "user" || message.role === "assistant");
}

/** The user and assistant chat messages, ordered by seq. */
export function chatMessages(messages: readonly Message[]): Message[] {
  return sortBySeq(messages).filter(isChat);
}

/** The "#n" of every chat message: its 1-based place among the line's chat messages. */
export function chatNumbers(messages: readonly Message[]): Map<string, number> {
  return new Map(chatMessages(messages).map((message, index) => [message.id, index + 1]));
}

export interface ForkContext {
  before: Message | null;
  anchor: Message | null;
  after: Message | null;
}

/** The fork point with one chat message on each side (the fork peek). */
export function forkContext(messages: readonly Message[], anchorMessageId: string): ForkContext {
  const chat = chatMessages(messages);
  const index = chat.findIndex((message) => message.id === anchorMessageId);
  if (index < 0) return { before: null, anchor: null, after: null };
  return { before: chat[index - 1] ?? null, anchor: chat[index] ?? null, after: chat[index + 1] ?? null };
}

/** The chat messages after `tipMessageId` (by seq): what the main line added since a draft read it. */
export function messagesSince(messages: readonly Message[], tipMessageId: string): Message[] {
  const ordered = sortBySeq(messages);
  const tip = ordered.find((message) => message.id === tipMessageId);
  if (!tip) return [];
  return ordered.filter((message) => message.seq > tip.seq && isChat(message));
}

export interface BranchLoad {
  /** Open branches directly under the parent line (the server caps them, default 8). */
  openUnderParent: number;
  /** Every branch of the tree (default cap 200). */
  total: number;
}

export function branchLoad(branches: readonly BranchView[], parentLineId: string): BranchLoad {
  return {
    openUnderParent: branches.filter((branch) => branch.parentLineId === parentLineId && branch.status === "open").length,
    total: branches.length,
  };
}

export interface PromotePlan {
  /** "#n" of the fork point on the main line; null when it is not loaded. */
  anchorNumber: number | null;
  /** Main-line chat messages after the fork point: they become the previous main line. */
  tailCount: number;
  /** "#n" of the first of them; null when there are none. */
  firstTailNumber: number | null;
  branchMessages: number;
  /** Open branches on the put-away tail (or below one): the server refuses while any is open. */
  blockers: BranchView[];
  /** The branch's own branches: they move up one level. */
  lifted: BranchView[];
}

function descendants(rootIds: ReadonlySet<string>, branches: readonly BranchView[]): BranchView[] {
  const found: BranchView[] = [];
  const seen = new Set(rootIds);
  let frontier = [...rootIds];
  while (frontier.length > 0) {
    const children = branches.filter((branch) => frontier.includes(branch.parentLineId) && !seen.has(branch.lineId));
    for (const child of children) seen.add(child.lineId);
    found.push(...children);
    frontier = children.map((child) => child.lineId);
  }
  return found;
}

/** What promoting `branch` (a direct branch of the main line) would change (A6 before / after). */
export function promotePlan(branch: BranchView, mainMessages: readonly Message[], branches: readonly BranchView[]): PromotePlan {
  const numbers = chatNumbers(mainMessages);
  const tail = messagesSince(mainMessages, branch.anchorMessageId);
  const tailIds = new Set(tail.map((message) => message.id));
  const onTail = branches.filter((item) => item.parentLineId === branch.parentLineId && item.lineId !== branch.lineId && tailIds.has(item.anchorMessageId));
  const below = descendants(new Set(onTail.map((item) => item.lineId)), branches);
  return {
    anchorNumber: numbers.get(branch.anchorMessageId) ?? null,
    tailCount: tail.length,
    firstTailNumber: tail[0] ? (numbers.get(tail[0].id) ?? null) : null,
    branchMessages: branch.messageCount,
    blockers: [...onTail, ...below].filter((item) => item.status === "open"),
    lifted: branches.filter((item) => item.parentLineId === branch.lineId),
  };
}

/** A conclusion card in the parent line is `pending` until a finished turn carried it to the model. */
export type CardDelivery = "pending" | "delivered";

export function cardDelivery(message: Pick<Message, "meta">): CardDelivery {
  return message.meta.delivered ? "delivered" : "pending";
}
