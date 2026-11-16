/**
 * Chapters (A10, F2 phase 2): a line's chapters and manual milestones.
 * `chapters.changed` (addressed to the root) invalidates every line's
 * chapters of the tree; the writes here do the same for this tab.
 */
import { isFeatureOn, type Chapter, type CreateMilestoneInput } from "@tangent/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTangent } from "../provider";
import { useCapabilities } from "./queries";

/** `GET /lines/{lineId}/chapters`, keyed under the tree's root; disabled while either id is null or `enabled` is false. */
export function useChapters(rootLineId: string | null, lineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.chapters(rootLineId ?? "", lineId ?? ""),
    queryFn: ({ signal }) => client.listChapters(lineId ?? "", { signal }),
    enabled: enabled && rootLineId !== null && lineId !== null,
  });
}

/** F11 §3: the main line's chapters for the map and the outline; undefined while the chapters feature is off or they load. */
export function useMainChapters(rootLineId: string | null): readonly Chapter[] | undefined {
  const capabilities = useCapabilities();
  const on = isFeatureOn(capabilities.data, "chapters");
  const chapters = useChapters(rootLineId, rootLineId, on);
  return on ? chapters.data?.chapters : undefined;
}

export function useAddMilestone(rootLineId: string, lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMilestoneInput) => ctx.client.addMilestone(lineId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ctx.keys.chaptersOf(rootLineId) }),
  });
}

export function useDeleteMilestone(rootLineId: string, lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (milestoneId: string) => ctx.client.deleteMilestone(lineId, milestoneId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ctx.keys.chaptersOf(rootLineId) }),
  });
}
