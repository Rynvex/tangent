/**
 * Opening a branch on its own (F20a): the conversation's send-as-branch uses
 * it from the main bundle, while the other branch writes
 * (`branch-mutations.ts`, which re-exports this) load with their dialogs.
 */
import type { CreateBranchInput } from "@tangent/client";
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useTangent } from "../provider";

/** Invalidates every key given, together. */
export function invalidator(queryClient: QueryClient) {
  return (...queryKeys: QueryKey[]) => Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/** Opens a branch from a message of `parentLineId`; the result's line is the new branch. */
export function useCreateBranch(parentLineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBranchInput) => ctx.client.createBranch(parentLineId, input),
    onSuccess: (result) => {
      queryClient.setQueryData(ctx.keys.lineView(result.line.id), result.line);
      return invalidator(queryClient)(ctx.keys.branchesOf(result.branch.rootLineId), ctx.keys.lineView(parentLineId));
    },
  });
}
