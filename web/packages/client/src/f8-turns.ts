/**
 * Where F8's re-ask flows fork (decisions #3, #4, #10 of 6_FRONTEND_F8.md),
 * as pure functions: 修改並分岔 forks from the message before the edited one,
 * 分岔重答 and cross-model diverge from the message before the turn's
 * question, so the new branch's background never holds the question it is
 * about to send again. Plus the purposes those flows write.
 */
import { BRANCH_PURPOSE_MAX } from "./branch-input";
import { cutChars } from "./cut-chars";
import { isHostNotice } from "./branch-view";
import { canTag } from "./folds";
import { charCount, sortBySeq } from "./text";
import type { Message } from "./types";

export { cutChars } from "./cut-chars";

/** Characters of the anchor that name a target's branch when nothing else does (`defaultDivergePurposeRunes`). */
export const DIVERGE_PURPOSE_HEAD = 40;
/** The server's separator between a purpose and the model answering it (`divergeModelSeparator`). */
export const DIVERGE_MODEL_SEPARATOR = " · ";

/** A message a branch may fork from: a finished user or assistant chat message (a host's notice is neither). */
export function isForkPoint(message: Message): boolean {
  return canTag(message) && !isHostNotice(message);
}

/** The fork point just before `messageId` on its line, or null (the line's first, or an unknown id). */
export function forkPointBefore(messages: readonly Message[], messageId: string): Message | null {
  const ordered = sortBySeq(messages);
  const at = ordered.findIndex((message) => message.id === messageId);
  if (at <= 0) return null;
  return ordered.slice(0, at).findLast(isForkPoint) ?? null;
}

/** A reply's turn: the user's question it answers and the fork point before that question (null when it opened the line). */
export interface ReplyTurn {
  question: Message;
  before: Message | null;
}

/** The turn of an assistant reply, or null when no user message precedes it on its line. */
export function replyTurn(messages: readonly Message[], replyId: string): ReplyTurn | null {
  const ordered = sortBySeq(messages);
  const at = ordered.findIndex((message) => message.id === replyId);
  if (at <= 0) return null;
  const question = ordered.slice(0, at).findLast((message) => message.kind === "chat" && message.role === "user" && message.status === "done");
  if (!question) return null;
  return { question, before: forkPointBefore(ordered, question.id) };
}

/** Text on one line: control characters and runs of white space become one space (`branchLine`). */
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The start of a message as a purpose's tail: one line, at most `max` characters. */
export function purposeHead(text: string, max: number): string {
  return cutChars(oneLine(text), max);
}

/**
 * A cross-model branch's purpose, as the server derives it (`DivergeTargetPurpose`):
 * "{prefix} · {model}", the prefix cut so the whole fits the purpose limit and
 * the model's name stays. Sent as each target's own purpose, so the frontend
 * decides the prefix (decision #4: the question, never the AI's answer).
 */
export function divergeTargetPurpose(prefix: string, model: string, max = BRANCH_PURPOSE_MAX): string {
  const head = oneLine(prefix);
  const name = oneLine(model);
  if (!head) return cutChars(name, max);
  const suffix = `${DIVERGE_MODEL_SEPARATOR}${name}`;
  const room = max - charCount(suffix);
  if (room < 1) return cutChars(`${head}${suffix}`, max);
  return `${cutChars(head, room)}${suffix}`;
}

/** A purpose written by a flow (「改問：…」, 「重答（…）：…」), cut to the purpose limit. */
export function flowPurpose(text: string, max = BRANCH_PURPOSE_MAX): string {
  return cutChars(oneLine(text), max);
}
