/**
 * One branch's view written into the cache where it already is: the tree's
 * outline (both with and without asides) and the branch's own detail. For a
 * change that touches nothing else (B23: an aside kept or let go), so no
 * list is read again.
 */
import type { BranchDetail, BranchList, BranchView } from "@tangent/client";
import type { QueryClient } from "@tanstack/react-query";
import type { TangentKeys } from "../query-keys";

export function writeBranch(queryClient: QueryClient, keys: TangentKeys, branch: BranchView): void {
  queryClient.setQueriesData<BranchList>({ queryKey: keys.branchesOf(branch.rootLineId) }, (list) => {
    if (!list || !Array.isArray(list.branches) || !list.branches.some((item) => item.lineId === branch.lineId)) return list;
    // Only the outline's read carries `anchorTag`; an event's or a write's copy of the branch does not.
    return { ...list, branches: list.branches.map((item) => (item.lineId === branch.lineId ? { ...branch, ...(item.anchorTag && !branch.anchorTag ? { anchorTag: item.anchorTag } : {}) } : item)) };
  });
  queryClient.setQueryData<BranchDetail>(keys.branch(branch.lineId), (detail) => (detail ? { ...detail, branch: { ...branch, ...(detail.branch.anchorTag && !branch.anchorTag ? { anchorTag: detail.branch.anchorTag } : {}) } } : detail));
}
