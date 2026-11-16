/**
 * B17's card rules that read data the page already has (docs/devlog/B17-dismiss-all-card-edit.md):
 * where a conclusion card stands with the parent's AI, and the follow-ups opened
 * from a card. In a module of their own so the conversation's main bundle does
 * not bring B17's route normalizers along (F20a); `b17-routes.ts` re-exports them.
 */
import type { BranchView, Message } from "./types";

// Card state ------------------------------------------------------------------

/**
 * Where a conclusion card stands with the parent's AI: told (a finished turn
 * carried it), edited and waiting for the next turn, or new and waiting.
 */
export type CardState = "delivered" | "editedPending" | "pending";

/**
 * A card's state, from the server's data alone (B17.1), so a reload or
 * another device shows the same: delivered once a turn carried it; else
 * edited (`meta.editedAt`) and waiting, or new and waiting. A card past
 * NoticeMaxPerTurn stays undelivered after a finished reply and is still
 * just pending.
 */
export function cardState(card: Pick<Message, "meta">): CardState {
  if (card.meta.delivered === true) return "delivered";
  return card.meta.editedAt ? "editedPending" : "pending";
}

/**
 * An RFC 3339 time in microseconds since the epoch (NaN when it does not
 * parse). The server writes microseconds; Date.parse keeps milliseconds
 * only, which would tie two writes within the same millisecond.
 */
export function isoMicros(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return Number.NaN;
  const fraction = /T[^.]*\.(\d+)/.exec(value)?.[1] ?? "";
  return ms * 1000 + Number(fraction.padEnd(6, "0").slice(3, 6));
}

// Follow-ups from a card ------------------------------------------------------

/** domain.CanAnchorBranch: a finished user or assistant chat message, or (B17) a finished conclusion card. */
export function canAnchorBranch(message: Pick<Message, "role" | "kind" | "status">): boolean {
  if (message.status !== "done") return false;
  if (message.kind === "branch_card") return true;
  return message.kind === "chat" && (message.role === "user" || message.role === "assistant");
}

/** The ids of the conclusion cards in an outline (each merged branch names its card). */
export function cardMessageIds(branches: readonly BranchView[]): Set<string> {
  return new Set(branches.map((branch) => branch.cardMessageId).filter((id) => id !== ""));
}

/** The branches opened from a conclusion card (`anchorMessageId` is the card's id). */
export function followUpsOfCard(branches: readonly BranchView[], cardMessageId: string): BranchView[] {
  return cardMessageId ? branches.filter((branch) => branch.anchorMessageId === cardMessageId) : [];
}

/**
 * Decision #6: which follow-ups can carry 前提已更新. Like F8's rule that only
 * a returned branch has a premise to change, an ended-and-dropped branch
 * (discarded) or one that became the main line (promoted) is left out; an
 * open follow-up is included, since it is still talking on the old card,
 * and a merged one, since its conclusion rests on it.
 */
export function canCarryCardPremise(branch: Pick<BranchView, "status">): boolean {
  return branch.status === "open" || branch.status === "merged";
}

/**
 * Decision #6 (前提已更新), from the server's data alone (B17.1): the branch
 * whose conclusion card `branch` was opened from, when that card was edited
 * after `branch` opened (`cardEditedAt` later than its `createdAt`; both are
 * the server's database clock, so no client clock is involved). The
 * follow-up's background still quotes the card as it was. null otherwise,
 * and for a follow-up that cannot carry the premise (`canCarryCardPremise`).
 */
export function editedCardSource(branch: BranchView, outline: readonly BranchView[]): BranchView | null {
  if (!branch.anchorMessageId || !canCarryCardPremise(branch)) return null;
  const source = outline.find((item) => item.cardMessageId !== "" && item.cardMessageId === branch.anchorMessageId);
  if (!source?.cardEditedAt) return null;
  return isoMicros(source.cardEditedAt) > isoMicros(branch.createdAt) ? source : null;
}

/** The branch a card came from, in an outline. */
export function branchOfCard(branches: readonly BranchView[], cardMessageId: string): BranchView | null {
  return branches.find((branch) => branch.cardMessageId === cardMessageId) ?? null;
}
