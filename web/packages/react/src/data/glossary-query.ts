/**
 * The tree's glossary as a query, on its own: the transcript reads it from
 * the first page (to know whether there are terms to mark at all), the
 * writes (`glossary-hooks.ts`) load with the glossary's screens.
 */
import { useQuery } from "@tanstack/react-query";
import { useTangent } from "../provider";

/** The tree's terms by key; `enabled` is false while the feature is off (then nothing is asked). */
export function useTerms(rootLineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.terms(rootLineId ?? ""), queryFn: ({ signal }) => client.listTerms(rootLineId ?? "", { signal }), enabled: enabled && rootLineId !== null });
}
