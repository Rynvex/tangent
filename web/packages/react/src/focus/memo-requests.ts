import { branchTitle, chatNumbers, purposeHead, type BranchView, type Memo } from "@tangent/client";
import { useMemo } from "react";
import { useBranches, useLine, useMessages } from "../data/queries";
import { useF8T } from "../i18n/f8-messages";
import { useFocusT } from "../i18n/focus-messages";
import type { NodeCheckRequest, NodeContinueRequest } from "./node-panel";
import { continuePlace, lastForkableId, purposeFromNote } from "./node-panel-model";

/** Characters of the memo in the check's purpose (S10: 「檢驗理解：{備忘前 30 字}」). */
const FEYNMAN_HEAD = 30;

export interface LineMemoRequests {
  /** The line's name as the panels show it (the conversation's title for the main line). */
  nodeTitle: string;
  /** 從這裡繼續談: where the open-branch dialog starts; null while the line has nothing to fork from (or is still loading). */
  continueRequest: (text: string) => NodeContinueRequest | null;
  /** 請 AI 檢驗理解… (F8 S10): the investigate branch and the check for its composer; null like `continueRequest`. */
  checkRequest: (memo: Memo) => NodeCheckRequest | null;
}

/**
 * What a line's memo (or note) asks the host to open, shared by focus
 * mode's node panel and the side panel's 備忘: an open line forks from its
 * last finished message, an ended branch where it forked (the dialog says
 * so). The queries are the ones the panels already read.
 */
export function useLineMemoRequests(rootLineId: string, lineId: string): LineMemoRequests {
  const t = useFocusT();
  const f8 = useF8T();
  const branches = useBranches(rootLineId, true);
  const root = useLine(rootLineId);
  const isMain = lineId === rootLineId;
  const branch: BranchView | null = isMain ? null : (branches.data?.branches.find((item) => item.lineId === lineId) ?? null);
  const own = useMessages(lineId);
  const parent = useMessages(branch?.parentLineId ?? null);
  const parentNumbers = useMemo(() => chatNumbers(parent.data?.messages ?? []), [parent.data]);
  const lastMessageId = lastForkableId(own.data?.messages ?? []);
  const nodeTitle = branch ? branchTitle(branch, t) : root.data?.title || t("panel.main");
  // A branch the outline does not list yet has no known place to fork from.
  const place = () => (!isMain && !branch ? null : continuePlace(branch, lineId, lastMessageId));
  return {
    nodeTitle,
    continueRequest: (text) => {
      const at = place();
      if (!at) return null;
      return {
        lineId: at.lineId,
        anchorMessageId: at.anchorMessageId,
        purpose: purposeFromNote(text),
        excerpt: text,
        ...(at.fromParent ? { notice: t("note.continueFromParent", { title: nodeTitle }) } : {}),
      };
    },
    // S10: an ended node's check forks where the node did (the dialog says so); the memo goes in only when the user sends.
    checkRequest: (memo) => {
      const at = place();
      if (!at) return null;
      return {
        lineId: at.lineId,
        anchorMessageId: at.anchorMessageId,
        purpose: f8("memo.feynmanPurpose", { text: purposeHead(memo.text, FEYNMAN_HEAD) }),
        excerpt: "",
        prompt: f8("memo.feynmanPrompt", { memo: memo.text }),
        filledNotice: f8("memo.feynmanFilled"),
        ...(at.fromParent && branch ? { notice: f8("memo.feynmanEnded", { title: nodeTitle, n: parentNumbers.get(branch.anchorMessageId) ?? "?" }) } : {}),
      };
    },
  };
}
