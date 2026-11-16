/**
 * F13 S3: the extract dialog from a message's 「⋯」, fed from the query
 * cache (the line, its messages, the tree's outline and its chapter starts).
 * Afterwards the line shows the card or marker left in the range's place.
 */
import { isFeatureOn, type LineView } from "@tangent/client";
import { ExtractBranchDialog, useBranches, useCapabilities, useChapters, useLine, useMessages } from "@tangent/react";
import { useMemo } from "react";
import type { Navigate, Toast } from "./branch-flows";
import { useF13ShellT } from "./f13-shell-messages";
import { useSticky } from "./hooks";

const rootOf = (line: LineView | undefined) => (line ? (line.conversationBranch?.rootLineId ?? line.id) : null);

export interface ExtractFlowProps {
  lineId: string;
  messageId: string;
  close: () => void;
  navigate: Navigate;
  toast: Toast;
  onHighlight?: (messageIds: readonly string[]) => void;
}

export default function ExtractFlow({ lineId, messageId, close, navigate, toast, onHighlight }: ExtractFlowProps) {
  const s = useF13ShellT();
  // Sticky: the extract resets these queries; the dialog stays mounted until it closes itself.
  const line = useSticky(useLine(lineId).data);
  const messages = useSticky(useMessages(lineId).data);
  const root = rootOf(line);
  const outline = useSticky(useBranches(root, true).data);
  const capabilities = useCapabilities();
  const chapters = useChapters(root, lineId, isFeatureOn(capabilities.data, "chapters"));
  // A chapter's start (other than the first) is a boundary the range stops before.
  const cuts = useMemo(() => new Set((chapters.data?.chapters ?? []).slice(1).map((chapter) => chapter.startMessageId)), [chapters.data]);
  if (!line || !messages || !outline) return null;
  return (
    <ExtractBranchDialog
      open
      onOpenChange={(open) => !open && close()}
      line={line}
      messages={messages.messages}
      branches={outline.branches}
      cutMessageIds={cuts}
      triggerMessageId={messageId}
      {...(onHighlight ? { onRangeChange: onHighlight } : {})}
      onExtracted={(result) => {
        navigate(result.sourceLineId, result.marker.id);
        toast(s("extract.done", { n: result.movedMessageIds.length, purpose: result.branch.purpose }), { label: s("extract.view"), run: () => navigate(result.branch.lineId) });
      }}
    />
  );
}
