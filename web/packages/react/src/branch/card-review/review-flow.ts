/**
 * The review's flow (F10 §4.1): the card opens prefilled, and the AI draft is
 * asked for on demand. Wraps the client's draft flow, whose draft runs over
 * the card in review: a draft that fails, is stopped or cannot start leaves
 * that card as it was (with the reason) instead of a blank one.
 */
import { draftFlowReducer, type BranchCard, type DraftFlowEvent, type DraftFlowState } from "@tangent/client";

export type ReviewFlowEvent = DraftFlowEvent | { type: "prefill"; card: BranchCard };

/** Events that can end a draft. */
const ENDS_DRAFT: ReadonlySet<ReviewFlowEvent["type"]> = new Set(["startFailed", "serverDraft", "abandon"]);

export function reviewFlowReducer(state: DraftFlowState, event: ReviewFlowEvent): DraftFlowState {
  if (event.type === "prefill") return { ...state, phase: "review", source: "manual", card: event.card, warnings: [], notice: null, edited: false };
  const next = draftFlowReducer(state, event);
  // A request refused before any draft ran fails from the review itself.
  const overCard = state.phase === "drafting" || (state.phase === "review" && event.type === "startFailed");
  if (!overCard || !ENDS_DRAFT.has(event.type) || next.phase === "drafting" || (next.phase === "review" && next.source === "ai")) return next;
  const { card, source, warnings, edited } = state;
  return { ...next, phase: "review", card, source, warnings, edited };
}
