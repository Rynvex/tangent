import { branchTitle, type BranchView } from "@tangent/client";
import { useCallback, useMemo } from "react";
import { KIND_KEYS } from "../conversation/branch-suggestions";
import { useBranches } from "../data/queries";
import { useP2T } from "../i18n/p2-messages";

/** Names a line for relations: 主線, 「kind・purpose」 for a branch of this tree, 「title（其他對話）」 for another conversation. */
export type LineNamer = (lineId: string, otherTitle?: string) => string;

/** Whether `lineId` is a line of this tree (the root or one of its branches). */
export type InTree = (lineId: string) => boolean;

/** A relation's end in another conversation, whichever end it is; undefined when both are in this tree (R9 G3). */
export function farEnd(link: { fromLineId: string; toLineId: string }, inTree: InTree): string | undefined {
  if (!inTree(link.toLineId)) return link.toLineId;
  return inTree(link.fromLineId) ? undefined : link.fromLineId;
}

export function useLineNames(rootLineId: string): { name: LineNamer; inTree: InTree; branches: readonly BranchView[] } {
  const t = useP2T();
  const outline = useBranches(rootLineId, true);
  const branches = useMemo(() => outline.data?.branches ?? [], [outline.data]);
  const byId = useMemo(() => new Map(branches.map((branch) => [branch.lineId, branch])), [branches]);
  const inTree = useCallback((lineId: string) => lineId === rootLineId || byId.has(lineId), [rootLineId, byId]);
  const name = useCallback(
    (lineId: string, otherTitle = "") => {
      if (lineId === rootLineId) return t("breadcrumb.main");
      const branch = byId.get(lineId);
      if (branch) return t("notes.sourceBranch", { kind: t(KIND_KEYS[branch.kind]), title: branchTitle(branch, t) });
      return t("relation.other", { title: otherTitle || lineId });
    },
    [rootLineId, byId, t],
  );
  return { name, inTree, branches };
}
