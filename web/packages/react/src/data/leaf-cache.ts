import type { BranchDetail, BranchList, Leaf, LeafDraftError } from "@tangent/client";
import type { QueryClient } from "@tanstack/react-query";
import type { TangentKeys } from "../query-keys";

/**
 * Puts a leaf (or its removal) into the cache in place: the leaf itself and
 * the `{kind, line, status}` summary on the tree's outline and the branch's
 * detail (no `branch.changed` comes with a leaf change).
 */
export function writeLeaf(queryClient: QueryClient, keys: TangentKeys, lineId: string, rootLineId: string, leaf: Leaf | null, draftError?: LeafDraftError): void {
  queryClient.setQueryData(keys.leaf(lineId), { leaf, ...(draftError ? { draftError } : {}) });
  const summary = leaf ? { kind: leaf.kind, line: leaf.line, status: leaf.status } : null;
  queryClient.setQueriesData<BranchList>({ queryKey: keys.branchesOf(rootLineId) }, (list) =>
    list && list.branches.some((branch) => branch.lineId === lineId) ? { ...list, branches: list.branches.map((branch) => (branch.lineId === lineId ? { ...branch, leaf: summary } : branch)) } : list,
  );
  queryClient.setQueryData<BranchDetail>(keys.branch(lineId), (detail) => (detail ? { ...detail, branch: { ...detail.branch, leaf: summary } } : detail));
}
