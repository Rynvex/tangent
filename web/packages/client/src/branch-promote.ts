import { TangentError } from "./errors";
import type { BranchView } from "./types";

/**
 * Why a branch cannot become the main line. Any open branch directly under the
 * main line can, whatever its kind (DESIGN §4.3).
 */
export type PromoteBlock = "notOpen" | "notTopLevel" | null;

export function promoteBlock(branch: Pick<BranchView, "status" | "parentLineId" | "rootLineId">): PromoteBlock {
  if (branch.status !== "open") return "notOpen";
  return branch.parentLineId === branch.rootLineId ? null : "notTopLevel";
}

/** The open branches that block a promotion (`open_branches_on_old_tail` carries their `lineIds`). */
export function blockingBranches(error: unknown, branches: readonly BranchView[]): BranchView[] {
  if (!(error instanceof TangentError) || error.code !== "open_branches_on_old_tail") return [];
  const ids = error.extra.lineIds;
  if (!Array.isArray(ids)) return [];
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string"));
  return branches.filter((branch) => wanted.has(branch.lineId));
}

/**
 * Whether a branch's purpose can change (B13, the server's rule): open and
 * ended (brought back, discarded, combined) branches, not a promoted one
 * (its messages went to the main line) nor the previous main line.
 */
export function canRenameBranch(branch: Pick<BranchView, "status" | "origin">): boolean {
  if (branch.origin === "previous_main_line") return false;
  return branch.status === "open" || branch.status === "merged" || branch.status === "discarded";
}
