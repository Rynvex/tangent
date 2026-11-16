/**
 * Branch writes (F2): open, move, draft, merge, discard and promote. These
 * are server-validated transitions (limits, tips, open tails), so they are
 * not optimistic: each writes what its result says into the cache and
 * invalidates what it changed. `branch.changed` events do the same for other
 * tabs and viewers.
 */
import type { BranchList, BranchView, DiscardBranchBody, MergeBranchBody, MessagePage, MoveBranchInput, UpdateBranchCardInput } from "@tangent/client";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useTangent, type TangentContextValue } from "../provider";
import { invalidator } from "./create-branch";
import { upsertMessage } from "./message-cache";

export { useCreateBranch } from "./create-branch";

type Ctx = Pick<TangentContextValue, "client" | "keys">;

/** What every branch transition changes: the tree's outline, the branch's detail and both lines. */
function branchKeys(ctx: Ctx, branch: BranchView): QueryKey[] {
  return [ctx.keys.branchesOf(branch.rootLineId), ctx.keys.branch(branch.lineId), ctx.keys.lineView(branch.lineId), ctx.keys.lineView(branch.parentLineId)];
}

/** Moves the last messages of `lineId` into a new branch (A7). */
export function useMoveToBranch(lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MoveBranchInput) => ctx.client.moveToBranch(lineId, input),
    onSuccess: (result) => {
      queryClient.setQueryData(ctx.keys.lineView(result.line.id), result.line);
      return invalidator(queryClient)(ctx.keys.messages(lineId), ctx.keys.lineView(lineId), ctx.keys.branchesOf(result.rootLineId));
    },
  });
}

/** Starts drafting the branch's conclusion card (card_draft); `branch.changed` reports progress. */
export function useStartDraft(lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ctx.client.startDraft(lineId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ctx.keys.branch(lineId) }),
  });
}

/** Brings the card back: it is written into the parent's cached messages at once. */
export function useMergeBranch(lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: MergeBranchBody) => ctx.client.mergeBranch(lineId, body),
    onSuccess: (result) => {
      const parentId = result.branch.parentLineId;
      queryClient.setQueryData<MessagePage>(ctx.keys.messages(parentId), (page) => (page ? upsertMessage(page, result.message) : page));
      queryClient.setQueryData(ctx.keys.lineView(parentId), result.line);
      const notes = result.notes ? [ctx.keys.notes(result.notes.rootLineId)] : [];
      return invalidator(queryClient)(...branchKeys(ctx, result.branch), ...notes);
    },
  });
}

/**
 * B17: edits a merged branch's conclusion card (`branchLineId`). The card is
 * written into the parent's cached messages and the branch into the cached
 * outlines at once; their edit times (B17.1 `meta.editedAt`,
 * `cardEditedAt`) say 已修改・下一輪帶入 and 前提已更新 on follow-ups opened
 * before it. The parent's previews reload.
 */
export function useUpdateBranchCard(branchLineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBranchCardInput) => ctx.client.updateBranchCard(branchLineId, input),
    onSuccess: (result) => {
      const parentId = result.message.lineId || result.branch.parentLineId;
      queryClient.setQueryData<MessagePage>(ctx.keys.messages(parentId), (page) => (page ? upsertMessage(page, result.message) : page));
      queryClient.setQueriesData<BranchList>({ queryKey: ctx.keys.branchesOf(result.branch.rootLineId) }, (list) =>
        list ? { ...list, branches: list.branches.map((item) => (item.lineId === result.branch.lineId ? { ...item, ...result.branch } : item)) } : list,
      );
      return invalidator(queryClient)(ctx.keys.branch(result.branch.lineId), ctx.keys.leaf(result.branch.lineId), [...ctx.keys.line(parentId), "preview"]);
    },
  });
}

/** Ends the branch without bringing anything back; `{leaf}` (B8) writes the reason as its dead-end leaf. */
export function useDiscardBranch(lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body?: DiscardBranchBody) => ctx.client.discardBranch(lineId, body),
    onSuccess: (result) => invalidator(queryClient)(...branchKeys(ctx, result.branch), ctx.keys.leaf(lineId)),
  });
}

/** Makes the branch the main line; the transcripts of all three lines changed. */
export function usePromoteBranch(lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ctx.client.promoteBranch(lineId),
    onSuccess: (result) => {
      queryClient.setQueryData(ctx.keys.lineView(result.line.id), result.line);
      const root = result.line.id;
      return invalidator(queryClient)(
        ...branchKeys(ctx, result.branch),
        ctx.keys.messages(root),
        ctx.keys.messages(lineId),
        ctx.keys.messages(result.previousMainLine.lineId),
        ctx.keys.chaptersOf(root),
      );
    },
  });
}

/** Renames an open branch (B5 `PATCH /lines/{id}/branch`); the outline and the branch reload (and `branch.changed{renamed}` tells others). */
export function useRenameBranch(rootLineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, purpose }: { lineId: string; purpose: string }) => ctx.client.renameBranch(lineId, { purpose }),
    onSuccess: (result) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ctx.keys.branchesOf(rootLineId) }),
        queryClient.invalidateQueries({ queryKey: ctx.keys.branch(result.branch.lineId) }),
        queryClient.invalidateQueries({ queryKey: ctx.keys.lineView(result.branch.lineId) }),
      ]),
  });
}
