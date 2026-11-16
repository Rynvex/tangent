/** 停車 from the conversation (B3): always loaded with the composer, so kept apart from the inbox's hooks. */
import type { CreateSeedInput } from "@tangent/client";
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useTangent } from "../provider";

export const invalidateAll = (queryClient: QueryClient, ...queryKeys: QueryKey[]) => Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));

/** Parks a thought on `lineId` (any line of the tree; without an anchor the server takes the line's newest message). */
export function useCreateSeed(lineId: string, rootLineId: string = lineId) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSeedInput) => client.createSeed(lineId, input),
    onSuccess: (result) => invalidateAll(queryClient, keys.seedsOf(result.seed.rootLineId || rootLineId), keys.lineView(result.seed.rootLineId || rootLineId)),
  });
}
