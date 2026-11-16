import { chatMessages, featureMode, isFeatureOn, lastSpinoff, rebalanceOf, type BranchView } from "@tangent/client";
import { BranchBar, BranchLeaf, describeError, RebalanceHint, StaleBadge, useBranchDetail, useCapabilities, useDismissSuggestion, useMessages, useSuggestions, useTangent, useUiT } from "@tangent/react";
import type { BranchFlow, Navigate } from "./branch-flows";
import { useParkActions } from "./park-actions";

export interface BranchHeaderProps {
  /** The branch as the outline lists it; the detail (pack, draft) replaces it once loaded. */
  branch: BranchView;
  readOnly: boolean;
  navigate: Navigate;
  onFlow: (flow: BranchFlow) => void;
  toast: (message: string) => void;
}

/**
 * A4: the branch bar wired to the demo's navigation and dialogs; once the
 * branch has ended, its leaf (B1, the leaf feature) with editing, and an
 * answered aside can be parked (B3, the parking feature). With spinoff (B2):
 * 獨立成新對話 and 「已獨立 →」; with tree balance (B4): the hint.
 */
/** The tree-balance hint for this branch (B4), when the inbox holds one: the same suggestion as in 待處理. */
function useRebalanceHint(branch: BranchView, readOnly: boolean, onFlow: (flow: BranchFlow) => void) {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const on = isFeatureOn(capabilities.data, "suggestions") && featureMode(capabilities.data, "rebalance") !== "off";
  const suggestions = useSuggestions(on ? branch.rootLineId : null);
  const keep = useDismissSuggestion(branch.rootLineId);
  const suggestion = suggestions.data?.suggestions.find((item) => item.status === "open" && rebalanceOf(item)?.lineId === branch.lineId);
  if (!suggestion || readOnly || branch.status !== "open") return null;
  return (
    <RebalanceHint
      suggestion={suggestion}
      onPromote={() => onFlow({ kind: "promote", lineId: branch.lineId, suggestionId: suggestion.id })}
      onSpinoff={() => onFlow({ kind: "spinoff", lineId: branch.lineId, atMessageId: "", suggestionId: suggestion.id })}
      onKeep={() => keep.mutate({ suggestionId: suggestion.id })}
      pending={keep.isPending}
      error={keep.error ? describeError(keep.error, t, hostErrorText) : null}
    />
  );
}

export function BranchHeader({ branch, readOnly, navigate, onFlow, toast }: BranchHeaderProps) {
  const detail = useBranchDetail(branch.lineId);
  const parent = useMessages(branch.parentLineId);
  const own = useMessages(branch.lineId);
  const capabilities = useCapabilities();
  const current = detail.data?.branch ?? branch;
  const lineId = current.lineId;
  const leafMode = featureMode(capabilities.data, "leaf");
  const park = useParkActions(lineId, !readOnly && isFeatureOn(capabilities.data, "parking"), "", () => undefined, toast, { shortcut: false });
  const spinoffOn = isFeatureOn(capabilities.data, "spinoff");
  const spunOff = lastSpinoff(own.data?.messages ?? []);
  const lastMessage = chatMessages(own.data?.messages ?? []).filter((message) => message.status === "done" && message.role !== "system").at(-1)?.id ?? "";
  const hint = useRebalanceHint(current, readOnly, onFlow);
  const answer = (own.data?.messages ?? []).filter((message) => message.role === "assistant" && message.kind === "chat" && message.status === "done").at(-1);
  return (
    <BranchBar
      branch={current}
      pack={detail.data?.pack ?? null}
      parentMessages={parent.data?.messages ?? []}
      readOnly={readOnly}
      onBack={() => navigate(current.parentLineId)}
      onGoToFork={() => navigate(current.parentLineId, current.anchorMessageId)}
      onBringBack={() => onFlow({ kind: "review", lineId })}
      onDiscard={() => onFlow({ kind: "discard", lineId })}
      onPromote={() => onFlow({ kind: "promote", lineId })}
      {...(isFeatureOn(capabilities.data, "notes") ? { onKeepAsideAsNote: () => onFlow({ kind: "asideNote", lineId }) } : {})}
      {...(park && answer ? { onParkAside: () => park.onParkText(`${current.purpose}：${answer.content}`, answer.id) } : {})}
      {...(leafMode !== "off" && current.kind !== "aside" ? { leaf: <BranchLeaf lineId={lineId} mode={leafMode} readOnly={readOnly} /> } : {})}
      {...(spinoffOn ? { onSpinoff: () => onFlow({ kind: "spinoff", lineId, atMessageId: lastMessage }) } : {})}
      {...(spunOff ? { spunOffTo: spunOff, onOpenSpinoff: () => navigate(spunOff.lineId) } : {})}
      // B17 (decision #6): a follow-up whose conclusion card was edited after it opened says 前提已更新 here too.
      hint={
        <>
          <StaleBadge rootLineId={current.rootLineId} branch={current} onGoToCard={(cardLineId, messageId) => navigate(cardLineId, messageId)} className="self-start" />
          {hint}
        </>
      }
    />
  );
}
