/**
 * The card the review opens with when no AI draft is ready (F10 §4.1): the
 * branch's purpose as the question and the branch's own answer as the
 * conclusion, so the user can bring it back at once or edit a sentence or two.
 */
import { CARD_FIELD_MAX, emptyCard } from "./branch-card";
import { cleanCardText } from "./card-text";
import { sortBySeq, truncateChars } from "./text";
import type { BranchCard, Message } from "./types";

/** The prefilled conclusion's limit: the work order's 2000, never above the server's field limit. */
export const CARD_PREFILL_CONCLUSION_MAX = Math.min(2000, CARD_FIELD_MAX);

const isDoneReply = (message: Message) => message.role === "assistant" && message.kind === "chat" && message.status === "done";

/** Cleaned like the server cleans card text, cut by characters (never half a surrogate pair), trimmed. */
function fieldText(text: string, max: number): string {
  return truncateChars(cleanCardText(text), max).trim();
}

/**
 * The conclusion the review prefills: the latest pinned finished AI reply of
 * the branch, else its last finished AI reply; "" when it has none.
 */
export function prefillConclusion(messages: readonly Message[]): string {
  const replies = sortBySeq(messages).filter(isDoneReply).reverse();
  const pick = (candidates: readonly Message[]) => {
    for (const message of candidates) {
      const text = fieldText(message.content, CARD_PREFILL_CONCLUSION_MAX);
      if (text) return text;
    }
    return "";
  };
  return pick(replies.filter((message) => message.pinned)) || pick(replies);
}

/** A card with only the question (the branch's purpose) and the conclusion (`prefillConclusion`) filled. */
export function prefillCard(purpose: string, messages: readonly Message[]): BranchCard {
  return { ...emptyCard(), question: fieldText(purpose, CARD_FIELD_MAX), conclusion: prefillConclusion(messages) };
}

/** True when any field besides the question and the conclusion has something in it (the review then shows them). */
export function cardHasAdvancedContent(card: BranchCard): boolean {
  return card.impact.trim() !== "" || card.evidence.length > 0 || card.openItems.length > 0 || card.needsDecision.length > 0 || card.excerpts.length > 0;
}
