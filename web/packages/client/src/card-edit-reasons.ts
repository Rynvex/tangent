/**
 * The card-edit reason on its own (F20a): the transcript's follow-up marks
 * read it on first render, the other 前提已更新 reasons (`stale-reasons.ts`,
 * which re-exports this) load with the outline and the map.
 */
import { editedCardSource } from "./b17-card-state";
import type { StaleReason } from "./stale-reasons";
import type { BranchView } from "./types";

/**
 * B17 (decision #6): a follow-up opened from a conclusion card before the
 * card was edited; its background still quotes the old card. Read from the
 * outline alone (B17.1, `editedCardSource`). The reason's id carries the
 * card's edit time, so a later edit is a new reason that 知道了 did not hide.
 * Discarded and promoted follow-ups are left out.
 */
export function cardEditReasons(branch: BranchView, outline: readonly BranchView[], dismissed: ReadonlySet<string> = new Set()): StaleReason[] {
  const source = editedCardSource(branch, outline);
  if (!source) return [];
  const reason: StaleReason = { kind: "cardEdited", id: `card:${branch.anchorMessageId}:${source.cardEditedAt}`, cardMessageId: branch.anchorMessageId, cardLineId: source.parentLineId, title: source.purpose };
  return dismissed.has(reason.id) ? [] : [reason];
}
