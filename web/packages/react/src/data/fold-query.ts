/**
 * The folds query on its own (F20a): the conversation reads it on first
 * render, while the other P3 hooks (`p3-hooks.ts`, which re-exports this)
 * only load with the tag and fold components.
 */
import { useQuery } from "@tanstack/react-query";
import { useTangent } from "../provider";

/** A line's folds; `enabled` is false while the fold feature is off. */
export function useFolds(lineId: string, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.folds(lineId),
    queryFn: ({ signal }) => client.listFolds(lineId, { signal }),
    enabled,
  });
}
