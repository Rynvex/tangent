import { LazyAskedBeforeDialog, LazyTermDialog, useGlossaryT, useLine, useReadOnly } from "@tangent/react";
import type { BranchFlow, Toast } from "./branch-flows";

export interface GlossaryFlowProps {
  flow: Extract<BranchFlow, { kind: "saveTerm" | "askedBefore" }>;
  close: () => void;
  toast: Toast;
  /** 查看 in the toast after a save. */
  onShowGlossary?: (termId: string) => void;
}

/**
 * The glossary's two dialogs as the frame hosts them (F19): 存進名詞表 from
 * an aside, a message or a selection, and what 「之前問過」 opens. A save
 * says so in the toast, with 查看 leading to the term in the side panel.
 */
export default function GlossaryFlow({ flow, close, toast, onShowGlossary }: GlossaryFlowProps) {
  const t = useGlossaryT();
  const readOnly = useReadOnly();
  const line = useLine(flow.lineId);
  const onOpenChange = (open: boolean) => {
    if (!open) close();
  };
  const said = (message: string, termId: string) => toast(message, onShowGlossary ? { label: t("glossary.view"), run: () => onShowGlossary(termId) } : undefined);
  if (flow.kind === "saveTerm") {
    const request = { lineId: flow.lineId, ...(flow.messageId ? { messageId: flow.messageId } : {}), ...(flow.selection ? { selection: flow.selection } : {}) };
    return <LazyTermDialog open onOpenChange={onOpenChange} request={request} onSaved={(result) => said(t(result.change === "updated" ? "glossary.savedOver" : "glossary.saved"), result.term.id)} />;
  }
  if (!line.data) return null;
  const rootLineId = line.data.conversationBranch?.rootLineId ?? line.data.id;
  return (
    <LazyAskedBeforeDialog
      open
      onOpenChange={onOpenChange}
      hit={flow.hit}
      lineId={flow.lineId}
      rootLineId={rootLineId}
      {...(flow.messageId ? { messageId: flow.messageId } : {})}
      readOnly={readOnly || Boolean(line.data.archivedAt)}
      onCopied={() => toast(t("glossary.copied"))}
    />
  );
}
