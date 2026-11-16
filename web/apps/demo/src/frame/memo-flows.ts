import type { NodeCheckRequest, NodeContinueRequest } from "@tangent/react";
import type { BranchFlow } from "./branch-flows";

type OpenFlow = Extract<BranchFlow, { kind: "open" }>;

/** 從這裡繼續談 (a note's or a memo's): the open-branch dialog, prefilled. */
export function continueFlow(request: NodeContinueRequest): OpenFlow {
  return {
    kind: "open",
    lineId: request.lineId,
    request: { anchorMessageId: request.anchorMessageId, excerpt: request.excerpt, purpose: request.purpose, ...(request.notice ? { notice: request.notice } : {}) },
  };
}

/** F8 S10 請 AI 檢驗理解…: the same dialog; the check goes in the new branch's composer, unsent (decision #9). */
export function checkFlow(request: NodeCheckRequest): OpenFlow {
  return { ...continueFlow(request), prefill: { text: request.prompt, notice: request.filledNotice } };
}
