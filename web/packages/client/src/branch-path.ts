/**
 * A branch's path from the main line (F20a): the header's breadcrumb needs it
 * on first render, the outline tree's logic (`branch-tree.ts`, which
 * re-exports it) loads with the structure panel.
 */
import type { BranchView } from "./types";

/** Branches from the first one under the main line down to `lineId`; empty when unknown. Cycle-safe. */
export function branchPath(lineId: string, branches: readonly BranchView[]): BranchView[] {
  const byId = new Map(branches.map((branch) => [branch.lineId, branch]));
  const path: BranchView[] = [];
  const seen = new Set<string>();
  let current = byId.get(lineId);
  while (current && !seen.has(current.lineId)) {
    seen.add(current.lineId);
    path.unshift(current);
    current = byId.get(current.parentLineId);
  }
  return path;
}
