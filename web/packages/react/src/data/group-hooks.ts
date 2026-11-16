/**
 * Groups and combining (F5 phase 3, B9 phase C). Server-validated, so not
 * optimistic: each write puts its result into the cache and reloads what it
 * changed; `group.changed`, `branch.changed` and `notes.changed` do the same
 * for other tabs. Only lazily loaded parts use these.
 */
import type { CombineBranchesInput, CreateGroupInput, NotesApplied } from "@tangent/client";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { TangentKeys } from "../query-keys";
import { useTangent } from "../provider";
import { invalidateAll } from "./park-hooks";
import { invalidatePreviews } from "./p2-hooks";

/** The tree's groups (active by default; pass the root); `enabled` is false while the group feature is off. */
export function useGroups(rootLineId: string | null, enabled = true, status = "active") {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.groups(rootLineId ?? "", status),
    queryFn: ({ signal }) => client.listGroups(rootLineId ?? "", { status }, { signal }),
    enabled: enabled && rootLineId !== null,
  });
}

/** A group write changed the groups, maybe the notes (keepBoth), and the prompt (fisheye). */
function settleGroups(queryClient: QueryClient, keys: TangentKeys, rootLineId: string, notes?: NotesApplied) {
  return Promise.all([invalidateAll(queryClient, keys.groupsOf(rootLineId), ...(notes ? [keys.notes(rootLineId)] : [])), invalidatePreviews(queryClient, keys)]);
}

export function useCreateGroup(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGroupInput) => client.createGroup(rootLineId, input),
    onSuccess: (result) => settleGroups(queryClient, keys, rootLineId, result.notes),
  });
}

export function useRenameGroup(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ groupId, title }: { groupId: string; title: string }) => client.renameGroup(groupId, { title }), onSuccess: () => settleGroups(queryClient, keys, rootLineId) });
}

export function useDissolveGroup(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ groupId }: { groupId: string }) => client.dissolveGroup(groupId), onSuccess: () => settleGroups(queryClient, keys, rootLineId) });
}

/** Writes the shared summary again (after a failure); `group.changed` brings it. */
export function useSummarizeGroup(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: ({ groupId }: { groupId: string }) => client.summarizeGroup(groupId), onSuccess: () => settleGroups(queryClient, keys, rootLineId) });
}

/** Combines open siblings of `parentLineId` into one new branch; the new line is cached, the outline and the lines reload. */
export function useCombineBranches(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ parentLineId, input }: { parentLineId: string; input: CombineBranchesInput }) => client.combineBranches(parentLineId, input),
    onSuccess: (result, { parentLineId }) => {
      queryClient.setQueryData(keys.lineView(result.line.id), result.line);
      return invalidateAll(
        queryClient,
        keys.branchesOf(rootLineId),
        keys.lineView(parentLineId),
        ...result.combined.map((branch) => keys.line(branch.lineId)),
        ...result.reparented.map((lineId) => keys.line(lineId)),
        ...(result.notes ? [keys.notes(rootLineId)] : []),
        keys.suggestionsOf(rootLineId),
      );
    },
  });
}
