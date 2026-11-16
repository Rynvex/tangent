import { GoalCapsule } from "@tangent/react";

/** The goal capsule (C4), loaded only while the goal feature is on. */
export function GoalHost({ rootLineId, compact }: { rootLineId: string; compact: boolean }) {
  return <GoalCapsule rootLineId={rootLineId} compact={compact} />;
}
