/**
 * The branch view logic the conversation needs on first render (F20a): host
 * notices, aside retention and why opening a branch was refused. The rest
 * (`branch-view.ts`, which re-exports these) loads with the branch flows.
 */
import { BRANCH_OPEN_PER_PARENT_LIMIT, BRANCH_SOFT_DEPTH_LIMIT, BRANCH_TREE_LIMIT } from "./branch-errors";
import { TangentError, extraNumber } from "./errors";
import type { Message } from "./types";

/** How long an ended aside is kept (domain.DefaultLimits().Branch.AsideRetention). */
export const ASIDE_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A host's system message (B7.2: `role` system, `kind` chat; the library
 * itself only writes cards and markers as system). Shown as a notice, never
 * numbered, never an anchor, and not "the last message" of a turn (retry
 * skips it).
 */
export function isHostNotice(message: Pick<Message, "role" | "kind">): boolean {
  return message.role === "system" && message.kind === "chat";
}

/**
 * Whole days until an ended aside is purged (rounded up, never negative);
 * the full period while it is still open or its end time is unknown.
 */
export function asideDaysLeft(closedAt: string | null, now: number, retentionDays = ASIDE_RETENTION_DAYS): number {
  const closed = Date.parse(closedAt ?? "");
  if (!Number.isFinite(closed)) return retentionDays;
  return Math.max(0, Math.ceil((closed + retentionDays * DAY_MS - now) / DAY_MS));
}

export type OpenBranchFailure =
  | { kind: "depth"; depth: number; limit: number }
  | { kind: "branchLimit"; limit: number }
  | { kind: "treeLimit"; limit: number }
  | { kind: "anchorGone" }
  | { kind: "purposeTooLong"; max: number }
  | { kind: "model" }
  | { kind: "featureOff"; feature: string }
  | { kind: "other" };


/** Sorts a refused `POST /branches` (or `/branches/move`) into what the dialog shows or offers. */
export function classifyOpenBranchError(error: unknown): OpenBranchFailure {
  if (!(error instanceof TangentError)) return { kind: "other" };
  switch (error.code) {
    case "depth_soft_limit":
      return { kind: "depth", depth: extraNumber(error, "depth", BRANCH_SOFT_DEPTH_LIMIT + 1), limit: extraNumber(error, "limit", BRANCH_SOFT_DEPTH_LIMIT) };
    case "branch_limit":
      return { kind: "branchLimit", limit: extraNumber(error, "limit", BRANCH_OPEN_PER_PARENT_LIMIT) };
    case "tree_limit":
      return { kind: "treeLimit", limit: extraNumber(error, "limit", BRANCH_TREE_LIMIT) };
    case "anchor_not_found":
      return { kind: "anchorGone" };
    case "too_long":
      return error.extra.field === "purpose" ? { kind: "purposeTooLong", max: extraNumber(error, "max", 0) } : { kind: "other" };
    case "model_not_allowed":
      return { kind: "model" };
    case "feature_disabled":
      return { kind: "featureOff", feature: typeof error.extra.feature === "string" ? error.extra.feature : "" };
    default:
      return { kind: "other" };
  }
}
