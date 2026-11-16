import { groupSuggestionOf, suggestedAction, type RebalanceAction, type Suggestion } from "@tangent/client";
import { InboxPanel, useBranches, useGroupForm } from "@tangent/react";
import type { BranchFlow, Navigate } from "./branch-flows";
import { useAskSeed, useExpandSeed } from "./seed-expand";

export interface InboxSideProps {
  rootLineId: string;
  lineId: string;
  navigate: Navigate;
  onFlow: (flow: BranchFlow) => void;
  /** 回顧所有未完成的事 (C5). */
  onReview: () => void;
  /** F10 直接問: a question whose send failed waits in the new branch's composer, said by a toast. */
  onPrefill?: (lineId: string, text: string) => void;
  toast?: (message: string) => void;
}

/** The side panel's 待處理 (B3, B5, B9), loaded with the tab. */
export function InboxSide({ rootLineId, lineId, navigate, onFlow, onReview, onPrefill, toast }: InboxSideProps) {
  const expand = useExpandSeed(rootLineId, lineId, onFlow);
  const ask = useAskSeed(rootLineId, navigate, (target, text, reason) => {
    onPrefill?.(target, text);
    toast?.(reason);
  });
  const outline = useBranches(rootLineId, true);
  // An AI group suggestion (C2) opens the group / combine dialog with its members and conflicts; a combined branch is entered.
  const form = useGroupForm(rootLineId, (result) => result.lineId && navigate(result.lineId));
  const reviewGroup = (suggestion: Suggestion) => {
    const proposal = groupSuggestionOf(suggestion);
    if (!proposal) return;
    const ids = new Set(proposal.members.map((member) => member.lineId));
    const members = (outline.data?.branches ?? []).filter((branch) => ids.has(branch.lineId));
    form.open({ mode: suggestedAction(proposal), members, suggestion });
  };
  // 升為主線 / 獨立 of a tree-balance suggestion open the same confirmations as the branch bar's hint (B4).
  const rebalance = (suggestion: Suggestion, action: RebalanceAction) =>
    onFlow(action === "promote" ? { kind: "promote", lineId: suggestion.lineId, suggestionId: suggestion.id } : { kind: "spinoff", lineId: suggestion.lineId, atMessageId: "", suggestionId: suggestion.id });
  return (
    <>
      {form.dialog}
      <InboxPanel
      rootLineId={rootLineId}
      lineId={lineId}
      onExpandSeed={expand}
      onAskSeed={ask}
      onGoTo={(target, messageId) => navigate(target, messageId)}
      onRebalance={rebalance}
      onContinueBranch={(target) => navigate(target)}
      // 結束並帶回 (B9 open_loops): the branch's conclusion card, the usual way back.
      onEndBranch={(target) => onFlow({ kind: "review", lineId: target })}
      onReview={onReview}
      onGroupSuggestion={reviewGroup}
    />
    </>
  );
}
