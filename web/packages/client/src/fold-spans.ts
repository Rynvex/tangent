/**
 * Which messages can be tagged and which a fold hides (F20a): the transcript
 * needs these on first render, the rest of the fold logic (`folds.ts`, which
 * re-exports them) loads with the fold UI.
 */
import type { Fold } from "./fold-routes";
import type { Message } from "./types";

/** Only finished user and assistant chat messages take a tag (or start or end a fold). */
export function canTag(message: Pick<Message, "kind" | "role" | "status">): boolean {
  return message.kind === "chat" && (message.role === "user" || message.role === "assistant") && message.status === "done";
}

/** A fold that is still in force on screen: drafting, active, or failed (to retry or remove). */
const isLive = (fold: Fold) => fold.status !== "removed";

export interface FoldSpan {
  fold: Fold;
  /** The line's loaded messages it covers, in order. */
  messages: Message[];
}

export interface FoldSpans {
  /** By the id of the first covered message: where the block goes. */
  byFirst: Map<string, FoldSpan>;
  /** Every covered message id: those rows are inside a block. */
  covered: Set<string>;
}

/** The live folds of `lineId` over its messages, by seq range (folds move with their messages). */
export function foldSpans(messages: readonly Message[], folds: readonly Fold[], lineId: string): FoldSpans {
  const byFirst = new Map<string, FoldSpan>();
  const covered = new Set<string>();
  for (const fold of folds) {
    if (fold.lineId !== lineId || !isLive(fold)) continue;
    const inside = messages.filter((message) => message.seq >= fold.fromSeq && message.seq <= fold.toSeq);
    const first = inside[0];
    if (!first) continue;
    byFirst.set(first.id, { fold, messages: inside });
    for (const message of inside) covered.add(message.id);
  }
  return { byFirst, covered };
}
