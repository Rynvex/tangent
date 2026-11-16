import type { Suggestion } from "@tangent/client";
import { DriftHint } from "@tangent/react";
import type { Navigate } from "./branch-flows";

/** The drift hint under a reply (C4); its code loads only when a reply has one. Accepting goes to the new branch. */
export function DriftHost({ rootLineId, suggestion, navigate }: { rootLineId: string; suggestion: Suggestion; navigate: Navigate }) {
  return <DriftHint rootLineId={rootLineId} suggestion={suggestion} onOpened={(lineId) => navigate(lineId)} />;
}
