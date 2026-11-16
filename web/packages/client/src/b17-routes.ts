/**
 * Routes and rules B17 added (docs/devlog/B17-dismiss-all-card-edit.md):
 * every open suggestion of a tree dismissed in one call
 * (`POST /lines/{id}/suggestions/dismiss-all`), a merged branch's conclusion
 * card edited in place (`PATCH /lines/{id}/branch/card`), and a conclusion
 * card as the anchor of a new branch (a follow-up). Inputs are untrusted
 * JSON; every reader fills the defaults.
 */
import { TangentError } from "./errors";
import { normalizeBranchView } from "./branch-normalize";
import { normalizeMessage } from "./line-normalize";
import type { BranchCard, BranchCardProblem, BranchView, Message } from "./types";
import { obj } from "./wire";

export { branchOfCard, canAnchorBranch, canCarryCardPremise, cardMessageIds, cardState, editedCardSource, followUpsOfCard, isoMicros, type CardState } from "./b17-card-state";

// Card edit -------------------------------------------------------------------

/** `PATCH /lines/{branchLineId}/branch/card` body: the whole new card (decoded as strictly as a merge's). */
export interface UpdateBranchCardInput {
  card: Partial<BranchCard>;
}

/**
 * The edited card: the same message (id, seq, parent line), its new `content`
 * and `meta.card`; `meta.delivered` is gone (the parent's next turn carries
 * it again) and `meta.editedAt` is the edit's time, as is
 * `branch.cardEditedAt` (B17.1). `branch.conclusionLine` (and a leaf merge
 * wrote) follow.
 */
export interface UpdateBranchCardResult {
  branch: BranchView;
  message: Message;
}

export function normalizeUpdateBranchCardResult(raw: unknown): UpdateBranchCardResult {
  const body = obj(raw);
  return { branch: normalizeBranchView(body.branch), message: normalizeMessage(body.message) };
}

/** Why an edit was refused, as the dialog words it; the edits stay in the form either way. */
export type CardEditFailure =
  | { kind: "invalid_card"; problems: BranchCardProblem[] }
  /** The parent line is mid-turn (that turn may already carry the old card): wait for the reply, then save. */
  | { kind: "parent_busy" }
  /** The line holding the card has ended, or the card moved to the previous main line (a promotion). */
  | { kind: "parent_closed" }
  | { kind: "archived" }
  /** The branch is no longer merged. */
  | { kind: "branch_closed" }
  | { kind: "other"; error: unknown };

function problemsOf(extra: Readonly<Record<string, unknown>>): BranchCardProblem[] {
  const raw = extra.problems;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const entry = item as { field?: unknown; message?: unknown };
    return typeof entry.field === "string" && typeof entry.message === "string" ? [{ field: entry.field, message: entry.message }] : [];
  });
}

export function classifyCardEditError(error: unknown): CardEditFailure {
  if (!(error instanceof TangentError)) return { kind: "other", error };
  switch (error.code) {
    case "invalid_card":
      return { kind: "invalid_card", problems: problemsOf(error.extra) };
    case "parent_busy":
    case "parent_closed":
    case "archived":
    case "branch_closed":
      return { kind: error.code };
    default:
      return { kind: "other", error };
  }
}
