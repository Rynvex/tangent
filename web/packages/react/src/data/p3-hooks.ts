/**
 * Hooks of the P3 modules, phase A (B10, F6): argument tags and folds. Used
 * by the lazily loaded tag and fold components only.
 */
import type { BranchList, CreateFoldInput, MessagePage, TagDraftList, TagKind, TagStatus, UpdateFoldInput } from "@tangent/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTangent } from "../provider";
import { upsertMessage } from "./message-cache";
import { invalidatePreviews } from "./p2-hooks";

export { useFolds } from "./fold-query";

export interface TagInput {
  messageId: string;
  /** null clears the tag. */
  kind: TagKind | null;
  /** B15: `draft` puts the type back as AI's unconfirmed one (復原). */
  status?: TagStatus;
}

/** The tree's AI drafts (B15), any line of it; `enabled` is false while ibis is off. */
export function useTagDrafts(rootLineId: string, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery<TagDraftList>({
    queryKey: keys.tagDrafts(rootLineId),
    queryFn: ({ signal }) => client.listTagDrafts(rootLineId, { signal }),
    enabled,
  });
}

/**
 * Sets, changes, confirms (the same kind on an AI draft) or clears a
 * message's tag; the transcript and the outline's `anchorTag` show it at
 * once (`message.updated` does the same for other tabs). One mutation serves
 * every message: call `mutateAsync` per press (R7).
 */
export function useTagMessage(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, kind, status }: TagInput) => (kind ? client.tagMessage(messageId, status ? { kind, status } : { kind }) : client.untagMessage(messageId)),
    onSuccess: ({ message }) => {
      void queryClient.invalidateQueries({ queryKey: keys.tagDrafts(rootLineId) });
      queryClient.setQueryData<MessagePage>(keys.messages(message.lineId), (page) => (page ? upsertMessage(page, message) : page));
      queryClient.setQueriesData<BranchList>({ queryKey: keys.branchesOf(rootLineId) }, (list) =>
        list
          ? {
              ...list,
              branches: list.branches.map((branch) => {
                if (branch.anchorMessageId !== message.id) return branch;
                const { anchorTag: _old, ...rest } = branch;
                return message.tag ? { ...rest, anchorTag: message.tag } : rest;
              }),
            }
          : list,
      );
    },
  });
}

/** Folds a range (AI drafts the summary when none is given); the list and the previews reload. */
export function useCreateFold(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFoldInput) => client.createFold(lineId, input),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.folds(lineId) }), invalidatePreviews(queryClient, keys)]),
  });
}

/** Removes a fold: its messages show and reach the model in full again. */
export function useDeleteFold(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ foldId }: { foldId: string }) => client.deleteFold(foldId),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.folds(lineId) }), invalidatePreviews(queryClient, keys)]),
  });
}

/** The user's summary of a fold (B10 phase B): it becomes active and theirs. */
export function useUpdateFold(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ foldId, summary }: { foldId: string } & UpdateFoldInput) => client.updateFold(foldId, { summary }),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.folds(lineId) }), invalidatePreviews(queryClient, keys)]),
  });
}
