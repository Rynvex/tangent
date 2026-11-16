import { chatMessages, prefillPurpose, seedOrigin, type BranchView, type Seed } from "@tangent/client";
import { describeError, useBranches, useExpandSeed as useExpandSeedMutation, useMessages, useSendFirst, useTangent, useUiT } from "@tangent/react";
import type { BranchFlow, Navigate } from "./branch-flows";

/**
 * Where a seed's branch hangs: the line its message is on (as far as this
 * page has it loaded) or, when that branch has ended, its nearest open
 * ancestor at the fork that leads there; else the main line's last message.
 * The server applies the same rule (B8 phase B) and has the last word.
 */
function openAncestor(lineId: string, anchorMessageId: string, branches: readonly BranchView[]): { lineId: string; anchorMessageId: string } {
  let at = { lineId, anchorMessageId };
  for (let branch = branches.find((item) => item.lineId === at.lineId); branch && branch.status !== "open"; branch = branches.find((item) => item.lineId === at.lineId)) {
    at = { lineId: branch.parentLineId, anchorMessageId: branch.anchorMessageId };
  }
  return at;
}

/** 展開成支線 (B3): opens the branch dialog prefilled with the seed (待處理 and the review share it). */
export function useExpandSeed(rootLineId: string, lineId: string, onFlow: (flow: BranchFlow) => void): (seed: Seed) => void {
  const main = useMessages(rootLineId);
  const current = useMessages(lineId === rootLineId ? null : lineId);
  const outline = useBranches(rootLineId, true);
  return (seed: Seed) => {
    const lines = [{ lineId: rootLineId, messages: main.data?.messages ?? [] }, ...(lineId !== rootLineId ? [{ lineId, messages: current.data?.messages ?? [] }] : [])];
    // B8.1: the server says which line the message is on now; older servers: look among the loaded lines.
    const origin = seed.anchorLineId ? { lineId: seed.anchorLineId, messageId: seed.anchorMessageId } : seedOrigin(seed, rootLineId, lines);
    const fallback = chatMessages(main.data?.messages ?? []).at(-1)?.id ?? seed.anchorMessageId;
    const at = origin.lineId ? openAncestor(origin.lineId, origin.messageId, outline.data?.branches ?? []) : { lineId: rootLineId, anchorMessageId: fallback };
    onFlow({ kind: "open", lineId: at.lineId, request: { anchorMessageId: at.anchorMessageId, seed: { id: seed.id, text: seed.text } } });
  };
}

/**
 * 直接問 (F10 §4.2): the seed becomes an investigate branch (the server picks the fork point) and its text is asked there at once.
 * A refused expand rejects (the seed card says why); a failed send goes to `onSendFailed` with the branch, the text and the reason.
 */
export function useAskSeed(rootLineId: string, navigate: Navigate, onSendFailed: (lineId: string, text: string, reason: string) => void): (seed: Seed) => Promise<void> {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const expand = useExpandSeedMutation(rootLineId);
  const sendFirst = useSendFirst();
  return async (seed: Seed) => {
    const result = await expand.mutateAsync({ seedId: seed.id, input: { purpose: prefillPurpose(seed.text), kind: "investigate" } });
    navigate(result.line.id);
    try {
      await sendFirst(result.line.id, seed.text);
    } catch (error) {
      onSendFailed(result.line.id, seed.text, t("branch.sendFailed", { reason: describeError(error, t, hostErrorText) }));
    }
  };
}
