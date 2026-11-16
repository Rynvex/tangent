/**
 * The tree's open suggestions. Kept apart from the inbox's hooks because the
 * conversation reads it too (F5: the drift hint under a reply), and that code
 * is always loaded.
 */
import { useQuery } from "@tanstack/react-query";
import { useTangent } from "../provider";

/** The tree's open suggestions, newest first (pass the root); `enabled` is false while the inbox is off. */
export function useSuggestions(rootLineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.suggestions(rootLineId ?? ""), queryFn: ({ signal }) => client.listSuggestions(rootLineId ?? "", {}, { signal }), enabled: enabled && rootLineId !== null });
}
