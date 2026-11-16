import type { LineView } from "@tangent/client";
import { hasTextSelection, readMessageSelection, useCommand, useUiT } from "@tangent/react";
import type { RefObject } from "react";
import type { BranchFlow, Navigate } from "./branch-flows";

export interface BranchCommandsInput {
  line: LineView | null;
  /** Nothing can be written on this line now (read-only identity, an ended branch, or still loading). */
  readOnly: boolean;
  /** ⌘B: branch from the selection or the last message. */
  onBranch: () => void;
  navigate: Navigate;
  onFlow: (flow: BranchFlow) => void;
}

/** The shortcuts of the conversation: ⌘B, and in a branch ⌘[ (main line), Esc (up one level) and ⌘Enter (bring back). */
export function useBranchCommands({ line, readOnly, onBranch, navigate, onFlow }: BranchCommandsInput): void {
  const info = line?.conversationBranch ?? null;
  const canBringBack = Boolean(line && info && info.status === "open" && info.kind !== "aside" && !readOnly);
  useCommand("branch.open", onBranch, !readOnly);
  useCommand("nav.mainLine", () => info && navigate(info.rootLineId), info !== null);
  useCommand("nav.back", () => info && navigate(info.parentLineId), info !== null);
  useCommand("branch.bringBack", () => line && onFlow({ kind: "review", lineId: line.id }), canBringBack);
}

/**
 * ⌘B and the composer button (DESIGN §12 R5): a selection inside one
 * forkable message opens the branch from it with the selection as the
 * excerpt; only with nothing selected does it use the last message. A
 * selection it cannot use opens nothing and says why: inside a conclusion
 * card or move marker (no branch can start there), or across messages or
 * outside the thread.
 */
export function useBranchHere(
  container: RefObject<HTMLElement | null>,
  lastMessageId: string | undefined,
  openBranch: (anchorMessageId: string | undefined, extra?: { excerpt?: string }) => void,
  toast: (message: string) => void,
): () => void {
  const t = useUiT();
  return () => {
    const selection = readMessageSelection(container.current);
    if (selection?.forkable) openBranch(selection.messageId, { excerpt: selection.text });
    else if (selection) toast(t("selection.notForkable"));
    else if (hasTextSelection()) toast(t("selection.oneMessage"));
    else openBranch(lastMessageId);
  };
}
