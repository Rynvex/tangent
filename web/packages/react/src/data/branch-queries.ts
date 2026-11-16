/**
 * Branch reads (F2). `branch.changed` events invalidate the detail (keyed by
 * the branch line) and the outline (keyed by the root), so a running draft
 * needs no polling; `poll` is only a backstop while a draft is running.
 */
import { DRAFT_POLL_MS, type PreviewBranchInput } from "@tangent/client";
import { useQuery } from "@tanstack/react-query";
import { useTangent } from "../provider";

export interface BranchDetailOptions {
  /** Read again every DRAFT_POLL_MS (while a card draft runs). */
  poll?: boolean;
}

/** `GET /lines/{id}/branch`: header, pack, draft and the parent's current tip; disabled while `lineId` is null. */
export function useBranchDetail(lineId: string | null, { poll = false }: BranchDetailOptions = {}) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.branch(lineId ?? ""),
    queryFn: ({ signal }) => client.getBranch(lineId ?? "", { signal }),
    enabled: lineId !== null,
    refetchInterval: poll ? DRAFT_POLL_MS : false,
  });
}

/** The tree's notes (`GET /notes`, under the root line); used by the merge review's note proposals. */
export function useNotes(rootLineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.notes(rootLineId ?? ""),
    queryFn: ({ signal }) => client.listNotes(rootLineId ?? "", { signal }),
    enabled: enabled && rootLineId !== null,
  });
}

/** Previews are only worth this long; the main line moves. */
const BRANCH_PREVIEW_STALE_MS = 30_000;

/**
 * The background a branch opened now would get (`POST /lines/{id}/branches/preview`, B5),
 * for the open-branch form; disabled while `input` is null. No retries: a
 * server without the route answers 404 and the form keeps its own estimate.
 */
export function useBranchPreview(lineId: string, input: PreviewBranchInput | null) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.branchPreview(lineId, input ?? {}),
    queryFn: ({ signal }) => client.previewBranch(lineId, input!, { signal }),
    enabled: input !== null,
    retry: false,
    staleTime: BRANCH_PREVIEW_STALE_MS,
  });
}
