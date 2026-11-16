import type { BranchFlow, Navigate } from "./branch-flows";
import { ReviewBoard } from "./review-board";
import { useExpandSeed } from "./seed-expand";

export interface ReviewHostProps {
  rootLineId: string;
  lineId: string;
  navigate: Navigate;
  onFlow: (flow: BranchFlow) => void;
  onClose: () => void;
}

/** 回顧 (C5) over the conversation column, loaded on first use. */
export function ReviewHost({ rootLineId, lineId, navigate, onFlow, onClose }: ReviewHostProps) {
  const expand = useExpandSeed(rootLineId, lineId, onFlow);
  // Scope and the snoozed list's toggle belong to one conversation (R9 G1).
  return <ReviewBoard key={rootLineId} rootLineId={rootLineId} onClose={onClose} navigate={navigate} onFlow={onFlow} onExpandSeed={expand} />;
}
