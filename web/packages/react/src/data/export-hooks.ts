/**
 * The whole tree as data (B14 `GET /lines/{id}/export`), read only when an
 * export needs it. Keyed under the line, so invalidating the line refreshes
 * it; never kept long (it can be large).
 */
import { useQuery } from "@tanstack/react-query";
import { useTangent } from "../provider";

/** How long an unused export stays cached. */
const EXPORT_GC_MS = 60_000;

export function useTreeExport(lineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: [...keys.line(lineId ?? ""), "export"],
    queryFn: ({ signal }) => client.exportTree(lineId ?? "", { signal }),
    enabled: enabled && lineId !== null,
    gcTime: EXPORT_GC_MS,
  });
}
