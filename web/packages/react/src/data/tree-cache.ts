/**
 * A deleted conversation leaves the cache (F7). The delete's own result
 * (`useDeleteLine`) and the `line.deleted` event both come here; whichever
 * arrives first does the work and the other finds nothing left to do (the
 * live store remembers the deleted lines), so nothing is invalidated twice.
 */
import type { BranchList, LinePage, LineView } from "@tangent/client";
import type { Query } from "@tanstack/react-query";
import type { SyncTarget } from "./event-sync";

/** Per-tree reads of other trees that can name a deleted one: its links (spinoff, relations) cascade away on the server. */
const CROSS_TREE_KEYS: ReadonlySet<unknown> = new Set(["links", "relations"]);

export function forgetTree({ queryClient, keys, live }: SyncTarget, lineIds: readonly string[]): void {
  if (lineIds.length === 0 || !live.forgetLines(lineIds)) return;
  const gone = new Set(lineIds);
  queryClient.setQueriesData<LinePage>({ queryKey: keys.lineLists() }, (page) =>
    page && page.lines.some((line) => gone.has(line.id)) ? { ...page, lines: page.lines.filter((line) => !gone.has(line.id)) } : page,
  );
  for (const id of lineIds) queryClient.removeQueries({ queryKey: keys.line(id) });
  const ours = (query: Query) => keys.all.every((part, index) => query.queryKey[index] === part);
  // Across conversations: open loops and search results may list it; a line spun off from it now says its source is gone.
  // The tenant's folder and tag counts (B18.1) may have counted it.
  void queryClient.invalidateQueries({ queryKey: keys.openLoopsAll() });
  void queryClient.invalidateQueries({ queryKey: keys.lineOrganization() });
  void queryClient.invalidateQueries({ queryKey: [...keys.all, "search"] });
  void queryClient.invalidateQueries({
    predicate: (query) => {
      if (!ours(query)) return false;
      const last = query.queryKey.at(-1);
      if (CROSS_TREE_KEYS.has(last)) return true;
      return last === "view" && gone.has((query.state.data as LineView | undefined)?.spunOffFrom?.lineId ?? "");
    },
  });
}

/**
 * Lines left a tree that is still there (B23: a branch was deleted with what
 * was under it, an aside was continued as a branch or cleared). The outline
 * drops them at once and is read again (a branch combined into a deleted one
 * comes back without its `mergedIntoLineId`), their own queries go, and what
 * the tree keeps about them (memos lose their node, notes get a source label,
 * chapters list fewer branches, links to them are gone) is read again.
 * `rootLineId` first in `lineIds` (or unknown) is the whole tree:
 * `forgetTree`. Like it, the delete's result and its event both come here and
 * the second finds nothing to do.
 */
export function forgetLines(target: SyncTarget, rootLineId: string, lineIds: readonly string[]): void {
  if (!rootLineId || lineIds[0] === rootLineId) return forgetTree(target, lineIds);
  const { queryClient, keys, live } = target;
  if (!live.forgetLines(lineIds)) return;
  queryClient.setQueriesData<BranchList>({ queryKey: keys.branchesOf(rootLineId) }, (list) => (list?.branches ? { ...list, branches: list.branches.filter((branch) => !lineIds.includes(branch.lineId)) } : list));
  for (const id of lineIds) queryClient.removeQueries({ queryKey: keys.line(id) });
  for (const part of ["branches", "memos", "terms", "notes", "chapters", "links", "relations"]) void queryClient.invalidateQueries({ queryKey: [...keys.line(rootLineId), part] });
  void queryClient.invalidateQueries({ queryKey: keys.openLoopsAll() });
}
