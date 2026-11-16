/**
 * P2 reads and writes (F5 phase 1, B9 phase A): the tree's goal, its
 * relations and the open-loops review. Server-validated, so not optimistic:
 * each write puts what its result says into the cache and invalidates what
 * it changed; the events (`goal.changed`, `link.changed`) do the same for
 * other tabs. Only lazily loaded parts use these.
 */
import type { CreateRelationInput, GoalResult, PutGoalInput, UpdateRelationInput } from "@tangent/client";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { TangentKeys } from "../query-keys";
import { useTangent } from "../provider";
import { invalidateAll } from "./park-hooks";

/** Every cached `POST /preview`: the goal is in every prompt of the tree. */
export function invalidatePreviews(queryClient: QueryClient, keys: TangentKeys): Promise<void> {
  return queryClient.invalidateQueries({ predicate: (query) => keys.all.every((part, index) => query.queryKey[index] === part) && query.queryKey.at(-2) === "preview" });
}

// Goal -------------------------------------------------------------------------

/** The tree's goal (pass the root, or any line of the tree); `enabled` is false while the goal feature is off. */
export function useGoal(rootLineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.goal(rootLineId ?? ""), queryFn: ({ signal }) => client.getGoal(rootLineId ?? "", { signal }), enabled: enabled && rootLineId !== null });
}

/** What a goal write changed: the goal itself, the open proposals (they expire) and the 待處理 count, and every preview. */
function settleGoal(queryClient: QueryClient, keys: TangentKeys, rootLineId: string, result: GoalResult) {
  queryClient.setQueryData<GoalResult>(keys.goal(rootLineId), result);
  return Promise.all([invalidateAll(queryClient, keys.suggestionsOf(rootLineId), keys.lineView(rootLineId)), invalidatePreviews(queryClient, keys)]);
}

/** Sets the goal as the user's own. */
export function usePutGoal(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: PutGoalInput) => client.putGoal(rootLineId, input), onSuccess: (result) => settleGoal(queryClient, keys, rootLineId, result) });
}

export function useDeleteGoal(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: () => client.deleteGoal(rootLineId), onSuccess: () => settleGoal(queryClient, keys, rootLineId, { goal: null }) });
}

/** Asks AI for a goal (202); the proposal comes into the inbox with `suggestion.changed` (auto mode: `goal.changed`). */
export function useProposeGoal(rootLineId: string) {
  const { client } = useTangent();
  return useMutation({ mutationFn: () => client.proposeGoal(rootLineId) });
}

// Relations ----------------------------------------------------------------------

/** The tree's relations (pass the root); `enabled` is false while the relations feature is off. */
export function useRelations(rootLineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.relations(rootLineId ?? ""), queryFn: ({ signal }) => client.listRelations(rootLineId ?? "", { signal }), enabled: enabled && rootLineId !== null });
}

/** Every tree a relation touches reloads its relations and links. */
function settleRelation(queryClient: QueryClient, keys: TangentKeys, rootLineIds: readonly string[]) {
  return invalidateAll(queryClient, ...rootLineIds.flatMap((root) => [keys.relations(root), keys.links(root)]));
}

/** Relates two ends; `lineId` is any line of the tree the start is in. */
export function useCreateRelation(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRelationInput) => client.createRelation(rootLineId, input),
    onSuccess: (result) => settleRelation(queryClient, keys, [rootLineId, ...result.rootLineIds]),
  });
}

/** A relation's new label (B9 phase C) or kind (B15), a field left out kept; every tree it touches reloads. */
export function useUpdateRelation(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ relationId, ...input }: { relationId: string } & UpdateRelationInput) => client.updateRelation(rootLineId, relationId, input),
    onSuccess: (result) => settleRelation(queryClient, keys, [rootLineId, ...result.rootLineIds]),
  });
}

/** Whether a query key is a tree's relation or link list (`keys.relations` / `keys.links`). */
const isRelationList = (key: readonly unknown[]) => key.at(-1) === "relations" || key.at(-1) === "links";

/**
 * Removes a relation. `otherLineId`, the far end of a relation reaching
 * another conversation (any line of it, either end — R9 G3), reloads the
 * relation lists of the other trees too: a branch's tree is not known here,
 * so every loaded list is marked stale (only the shown ones reload).
 */
export function useDeleteRelation(rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ relationId }: { relationId: string; otherLineId?: string }) => client.deleteRelation(rootLineId, relationId),
    onSuccess: (_result, { otherLineId }) =>
      otherLineId ? queryClient.invalidateQueries({ predicate: (query) => isRelationList(query.queryKey) }) : settleRelation(queryClient, keys, [rootLineId]),
  });
}

// Open loops ---------------------------------------------------------------------

/** What is still unfinished: one tree (`rootLineId`) or every conversation (null); `enabled` is false while open_loops is off. */
export function useOpenLoops(rootLineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.openLoops(rootLineId),
    queryFn: ({ signal }) => client.listOpenLoops(rootLineId ? { root: rootLineId } : {}, { signal }),
    enabled,
  });
}
