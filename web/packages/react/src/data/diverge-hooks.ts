/**
 * Hooks of diverge and converge (B10 phase B, F6 phase 2): only the lazily
 * loaded D3 parts use them. Every write is one the user asked for.
 */
import type { ConvergeInput, DecideInput, DivergeInput } from "@tangent/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTangent } from "../provider";

/** The comparisons of the branches under `lineId`, newest first; `enabled` is false while the diverge feature is off. */
export function useComparisons(lineId: string, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.comparisons(lineId),
    queryFn: ({ signal }) => client.listComparisons(lineId, { signal }),
    enabled,
  });
}

/** Asks for N directions from a message (202); the branches arrive with `branch.changed`, a failure with `job.failed`. */
export function useDiverge(lineId: string) {
  const { client } = useTangent();
  return useMutation({ mutationFn: (input: DivergeInput) => client.diverge(lineId, input) });
}

/** Compares 2–5 open branches of `lineId`; the table drafts, `comparison.changed` brings it. */
export function useConverge(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConvergeInput) => client.converge(lineId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.comparisons(lineId) }),
  });
}

/** Decides a comparison of `lineId`'s branches: the chosen one gets its decision, the others end. */
export function useDecide(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ comparisonId, input }: { comparisonId: string; input: DecideInput }) => client.decideComparison(comparisonId, input),
    onSuccess: (result) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.comparisons(lineId) }),
        queryClient.invalidateQueries({ queryKey: keys.branchesOf(result.comparison.rootLineId || result.chosen.rootLineId) }),
      ]),
  });
}
