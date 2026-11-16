/**
 * What the screens ask about an aside's fate and a branch's deletion (B23):
 * which branches can be deleted on their own, what goes with them, and how a
 * refusal reads. Pure logic over the outline; the mock uses the same rules.
 */
import { TangentError, extraNumber } from "./errors";
import { BRANCH_OPEN_PER_PARENT_LIMIT, BRANCH_SOFT_DEPTH_LIMIT, BRANCH_TREE_LIMIT } from "./branch-errors";
import type { BranchView } from "./types";

type Deletable = Pick<BranchView, "kind" | "status" | "origin" | "mergedIntoLineId">;

/**
 * domain.BranchDeletable: an aside that ended, or a discarded branch that is
 * neither the previous main line (it holds a promotion's old tail) nor
 * combined into another branch.
 */
export function canDeleteBranch(branch: Deletable): boolean {
  if (branch.kind === "aside") return branch.status !== "open";
  return branch.status === "discarded" && branch.origin !== "previous_main_line" && branch.mergedIntoLineId === "";
}

/** Every branch under `lineId` (its children, theirs, …), nearest first; never `lineId` itself. */
export function branchDescendants(branches: readonly BranchView[], lineId: string): BranchView[] {
  const out: BranchView[] = [];
  const seen = new Set([lineId]);
  let level = [lineId];
  while (level.length > 0) {
    const parents = new Set(level);
    const children = branches.filter((branch) => parents.has(branch.parentLineId) && !seen.has(branch.lineId));
    for (const child of children) seen.add(child.lineId);
    out.push(...children);
    level = children.map((child) => child.lineId);
  }
  return out;
}

/**
 * The branch under `lineId` (or `lineId` itself) that keeps a delete from
 * going through: one still open, or one whose line is answering. Null when
 * the outline shows none (the server may still know better).
 */
export function busyBranchUnder(branches: readonly BranchView[], lineId: string): BranchView | null {
  const own = branches.find((branch) => branch.lineId === lineId);
  const subtree = [...(own ? [own] : []), ...branchDescendants(branches, lineId)];
  return subtree.find((branch) => branch.lineId !== lineId && branch.status === "open") ?? subtree.find((branch) => branch.lineStatus === "thinking") ?? null;
}

/** Why 接著問 was refused, as the screen words it. */
export type ContinueAsideFailure =
  /** The aside is gone (cleared, deleted or already continued). */
  | { kind: "gone" }
  /** It has no finished answer to continue from. */
  | { kind: "noAnswer" }
  /** Still answering. */
  | { kind: "busy" }
  | { kind: "archived" }
  | { kind: "parentClosed" }
  | { kind: "branchLimit"; limit: number }
  | { kind: "treeLimit"; limit: number }
  /** Deeper than suggested: send again with `confirmDeeper`. */
  | { kind: "deeper"; depth: number; limit: number }
  | { kind: "tooDeep" }
  /** The message it forks from is no longer on the line above. */
  | { kind: "anchorGone" }
  /** Changed under us: asking again may work. */
  | { kind: "retry" }
  | { kind: "featureOff" }
  | { kind: "other" };

export function classifyContinueError(error: unknown): ContinueAsideFailure {
  if (!(error instanceof TangentError)) return { kind: "other" };
  switch (error.code) {
    case "branch_not_found":
    case "line_not_found":
      return { kind: "gone" };
    case "no_messages":
      return { kind: "noAnswer" };
    case "branch_busy":
      return { kind: "busy" };
    case "archived":
      return { kind: "archived" };
    case "parent_closed":
      return { kind: "parentClosed" };
    case "branch_limit":
      return { kind: "branchLimit", limit: extraNumber(error, "limit", BRANCH_OPEN_PER_PARENT_LIMIT) };
    case "tree_limit":
      return { kind: "treeLimit", limit: extraNumber(error, "limit", BRANCH_TREE_LIMIT) };
    case "depth_soft_limit":
      return { kind: "deeper", depth: extraNumber(error, "depth", BRANCH_SOFT_DEPTH_LIMIT + 1), limit: extraNumber(error, "limit", BRANCH_SOFT_DEPTH_LIMIT) };
    case "depth_hard_limit":
      return { kind: "tooDeep" };
    case "anchor_not_found":
      return { kind: "anchorGone" };
    case "concurrent_change":
      return { kind: "retry" };
    case "feature_disabled":
      return { kind: "featureOff" };
    default:
      return { kind: "other" };
  }
}

/** Why a branch was not deleted. */
export type DeleteBranchFailure =
  /** Already gone: nothing left to do. */
  | { kind: "gone" }
  /** Something under it (or it) is still open or answering. */
  | { kind: "busy" }
  /** Not a branch that can be deleted on its own (open, brought back, promoted, the previous main line, combined). */
  | { kind: "notDeletable" }
  | { kind: "archived" }
  | { kind: "other" };

export function classifyDeleteBranchError(error: unknown): DeleteBranchFailure {
  if (!(error instanceof TangentError)) return { kind: "other" };
  switch (error.code) {
    case "line_not_found":
    case "branch_not_found":
      return { kind: "gone" };
    case "branch_busy":
      return { kind: "busy" };
    case "branch_not_deletable":
    case "invalid_input":
      return { kind: "notDeletable" };
    case "archived":
      return { kind: "archived" };
    default:
      return { kind: "other" };
  }
}
