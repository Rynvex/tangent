/**
 * An aside's fate and a branch's deletion (B23 / F18): keep or let go,
 * continue as an open branch, delete. Each writes what its result says into
 * the cache; the events that follow find the same and do nothing more.
 */
import type { ContinueAsideInput, MessagePage } from "@tangent/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTangent } from "../provider";
import { writeBranch } from "./branch-cache";
import { invalidator } from "./create-branch";
import { forgetLines } from "./tree-cache";

/** Keeps an aside past its retention (`keep: true`) or lets it go again; the outline's and the detail's copy change in place. */
export function useKeepBranch() {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, keep }: { lineId: string; keep: boolean }) => ctx.client.keepBranch(lineId, keep),
    onSuccess: (result) => writeBranch(queryClient, ctx.keys, result.branch),
  });
}

/**
 * 接著問: an answered aside becomes an open branch at the same place. The
 * aside's line is gone and its messages now belong to `result.line` (same
 * ids): what this page had read of them is shown there at once and then read
 * again, so going to the new line never starts from an empty transcript.
 */
export function useContinueAside() {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, input }: { lineId: string; input?: ContinueAsideInput }) => ctx.client.continueAside(lineId, input),
    // Read before the request: the aside's `line.deleted` may clear its queries before the result is here.
    onMutate: ({ lineId }) => ({ had: queryClient.getQueryData<MessagePage>(ctx.keys.messages(lineId)) }),
    onSuccess: (result, _variables, context) => {
      const { line, branch, replacedLineId } = result;
      queryClient.setQueryData(ctx.keys.lineView(line.id), line);
      const moved = context?.had?.messages.filter((message) => message.status === "done").map((message) => ({ ...message, lineId: line.id }));
      if (moved && moved.length > 0 && queryClient.getQueryData(ctx.keys.messages(line.id)) === undefined) queryClient.setQueryData<MessagePage>(ctx.keys.messages(line.id), { messages: moved });
      forgetLines({ queryClient, keys: ctx.keys, live: ctx.live }, branch.rootLineId, [replacedLineId]);
      return invalidator(queryClient)(ctx.keys.branchesOf(branch.rootLineId), ctx.keys.lineView(branch.parentLineId), ctx.keys.messages(line.id));
    },
  });
}

/**
 * Deletes an ended aside or a discarded branch with everything under it.
 * `keepalive` sends it so that it outlives the page (a delete still waiting
 * when the page goes away). Whoever shows one of the deleted lines must leave
 * it in the same update, or its queries read the deleted lines again.
 */
export function useDeleteBranch() {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, keepalive }: { lineId: string; keepalive?: boolean }) => ctx.client.deleteBranch(lineId, keepalive ? { keepalive: true } : undefined),
    onSuccess: (result) => forgetLines({ queryClient, keys: ctx.keys, live: ctx.live }, result.rootLineId, result.lineIds),
  });
}
