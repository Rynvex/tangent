import { TangentError, extraNumber, type TangentErrorCode } from "./errors";
import { BRANCH_MOVE_MAX } from "./branch-move-limit";
import type { ClientMessageKey, HostErrorText, TranslateFn } from "./i18n-keys";

/** Server-side limits quoted when an error does not carry its own (domain.DefaultLimits). */
export const BRANCH_SOFT_DEPTH_LIMIT = 3;
export const BRANCH_HARD_DEPTH_LIMIT = 6;
export const BRANCH_OPEN_PER_PARENT_LIMIT = 8;
export const BRANCH_TREE_LIMIT = 200;

const FIXED_MESSAGES: Partial<Record<TangentErrorCode, ClientMessageKey>> = {
  kind_unsupported: "branch.errorKindUnsupported",
  anchor_not_found: "branch.errorAnchorNotFound",
  parent_closed: "branch.errorParentClosed",
  archived: "branch.errorArchived",
  branch_closed: "branch.errorBranchClosed",
  branch_drafting: "branch.errorBranchDrafting",
  not_enough_messages: "branch.errorNotEnoughMessages",
  move_must_start_with_user: "branch.errorMoveStartUser",
  move_protected_message: "branch.errorMoveProtected",
  move_no_anchor: "branch.errorMoveNoAnchor",
  source_busy: "branch.errorSourceBusy",
  parent_busy: "branch.errorParentBusy",
  branch_busy: "branch.errorBranchBusy",
  promote_not_top_level: "branch.errorPromoteNotTop",
  open_branches_on_old_tail: "branch.errorOpenOnOldTail",
  branch_not_main_line: "branch.errorNotMainLine",
  session_busy: "branch.errorSessionBusy",
  aside_answered: "branch.errorAsideAnswered",
  suggestion_not_found: "branch.errorSuggestionNotFound",
  note_limit: "branch.errorNoteLimit",
  // B8: expanding a seed fails with these besides the branch refusals.
  seed_not_open: "error.seedNotOpen",
  seed_not_found: "error.seedNotFound",
};

/** Send-time codes: the branch state changed under the user, so its data is stale. */
const SEND_STATE_CODES: ReadonlySet<string> = new Set<TangentErrorCode>(["branch_closed", "archived", "branch_drafting", "aside_answered"]);

/** True when a failed send means the branch is closed, archived or otherwise changed (reload it). */
export function isBranchStateError(error: unknown): boolean {
  return error instanceof TangentError && SEND_STATE_CODES.has(error.code);
}

export interface BranchErrorDescription {
  /** Localised explanation. */
  message: string;
}

/** True when the error asks the user to confirm a deeper branch (`confirmDeeper`). */
export function isDepthSoftLimit(error: unknown): error is TangentError {
  return error instanceof TangentError && error.code === "depth_soft_limit";
}

/** Text for the codes whose message quotes a limit from the error's extra fields. */
function describeLimit(error: TangentError, t: TranslateFn): string | null {
  switch (error.code) {
    case "depth_hard_limit":
      return t("branch.errorDepthHard", { limit: extraNumber(error, "limit", BRANCH_HARD_DEPTH_LIMIT) });
    case "depth_soft_limit":
      return t("branch.depthBody", {
        depth: extraNumber(error, "depth", BRANCH_SOFT_DEPTH_LIMIT + 1),
        limit: extraNumber(error, "limit", BRANCH_SOFT_DEPTH_LIMIT),
      });
    case "branch_limit":
      return t("branch.errorBranchLimit", { limit: extraNumber(error, "limit", BRANCH_OPEN_PER_PARENT_LIMIT) });
    case "tree_limit":
      return t("branch.errorTreeLimit", { limit: extraNumber(error, "limit", BRANCH_TREE_LIMIT) });
    case "invalid_count":
      return t("branch.errorInvalidCount", { max: extraNumber(error, "max", BRANCH_MOVE_MAX) });
    default:
      return null;
  }
}

/**
 * Maps a failed branch call (create, move, promote, send in a branch) to
 * localised text. A code without a built-in message, such as a host's own
 * `TurnGate` code, uses `hostText` when the host translated it and otherwise
 * the backend text (DESIGN §12).
 */
export function describeBranchError(error: unknown, t: TranslateFn, hostText?: HostErrorText): BranchErrorDescription {
  if (!(error instanceof TangentError)) return { message: t("branch.errorUnknown") };
  const limited = describeLimit(error, t);
  if (limited !== null) return { message: limited };
  const key = FIXED_MESSAGES[error.code as TangentErrorCode];
  if (key) return { message: t(key) };
  const host = error.code ? hostText?.(error.code) : undefined;
  if (host) return { message: host };
  if (error.status === 403) return { message: t("branch.errorViewer") };
  // invalid_input (purpose, excerpt) and anything unknown: the backend explains itself.
  return { message: error.message || t("branch.errorUnknown") };
}
