/**
 * Memos (B13, the memo feature): one query per tree (the panel filters by
 * node), and writes that reload it. `memo.changed` from others reloads it
 * too (event-sync).
 */
import type { CreateMemoInput } from "@tangent/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTangent } from "../provider";

/** The tree's memos, oldest first; `enabled` is false while the feature is off. */
export function useMemos(rootLineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.memos(rootLineId ?? ""), queryFn: ({ signal }) => client.listMemos(rootLineId ?? "", {}, { signal }), enabled: enabled && rootLineId !== null });
}

function useSettle(rootLineId: string) {
  const { keys } = useTangent();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: keys.memos(rootLineId) });
}

/** Writes a memo on `lineId` (a node of the tree). */
export function useCreateMemo(rootLineId: string) {
  const { client } = useTangent();
  const settle = useSettle(rootLineId);
  return useMutation({ mutationFn: (input: CreateMemoInput) => client.createMemo(rootLineId, input), onSuccess: settle });
}

export function useUpdateMemo(rootLineId: string) {
  const { client } = useTangent();
  const settle = useSettle(rootLineId);
  return useMutation({ mutationFn: ({ memoId, text }: { memoId: string; text: string }) => client.updateMemo(memoId, text), onSuccess: settle });
}

export function useDeleteMemo(rootLineId: string) {
  const { client } = useTangent();
  const settle = useSettle(rootLineId);
  return useMutation({ mutationFn: (memoId: string) => client.deleteMemo(memoId), onSuccess: settle });
}
