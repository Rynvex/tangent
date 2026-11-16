/**
 * Pure logic of argument tags (D2) and folds (D4) on screen: which messages
 * can be tagged, which messages a fold hides, where a fold may end, and
 * reading a fold suggestion. The server checks everything again.
 */
import { canTag } from "./fold-spans";
import type { Message, Suggestion } from "./types";
import { count, obj, str } from "./wire";

export { TAG_KINDS, type MessageTag, type TagKind } from "./types";
export { canTag, foldSpans, type FoldSpan, type FoldSpans } from "./fold-spans";

/** Where a fold started at `startId` may end: the line's later finished chat messages. */
export function foldEndOptions(messages: readonly Message[], startId: string): Message[] {
  const start = messages.find((message) => message.id === startId);
  if (!start) return [];
  return messages.filter((message) => message.seq > start.seq && canTag(message));
}

export interface FoldProposal {
  fromMessageId: string;
  toMessageId: string;
  fromSeq: number;
  toSeq: number;
  /** The chapter's title. */
  title: string;
  summary: string;
  messageCount: number;
  tokensOriginal: number;
  tokensSummary: number;
  /** Tokens the fold saves each turn ("可省約 3.1k token"). */
  saved: number;
}

/** A `fold` suggestion's payload; null for any other suggestion. */
export function foldSuggestionOf(suggestion: Pick<Suggestion, "feature" | "kind" | "payload">): FoldProposal | null {
  if (suggestion.feature !== "fold" || suggestion.kind !== "fold") return null;
  const payload = obj(suggestion.payload);
  const tokensOriginal = count(payload.tokensOriginal);
  const tokensSummary = count(payload.tokensSummary);
  return {
    fromMessageId: str(payload.fromMessageId),
    toMessageId: str(payload.toMessageId),
    fromSeq: count(payload.fromSeq),
    toSeq: count(payload.toSeq),
    title: str(payload.title),
    summary: str(payload.summary),
    messageCount: count(payload.messageCount),
    tokensOriginal,
    tokensSummary,
    saved: Math.max(0, tokensOriginal - tokensSummary),
  };
}
