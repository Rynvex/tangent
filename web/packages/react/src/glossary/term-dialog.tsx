import { classifyTermError, cleanTerm, cleanTermExplanation, DEFAULT_TERM_LIMITS, normalizeTermKey, termInputProblem, termPrefill, type Message, type Term, type TermFailure, type TermWriteResult } from "@tangent/client";
import { BookA } from "lucide-react";
import { useState } from "react";
import { ErrorAlert } from "../branch/error-alert";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { describeError } from "../conversation/error-text";
import { useSaveTerm } from "../data/glossary-hooks";
import { useTerms } from "../data/glossary-query";
import { useBranches, useLine, useMessages } from "../data/queries";
import { useGlossaryT } from "../i18n/glossary-messages";
import { useTangent } from "../provider";
import { TermFields, type TermDraft } from "./term-fields";

/** 存進名詞表, asked from somewhere in a conversation. */
export interface SaveTermRequest {
  /** The line it is saved from (an aside is kept by the save). */
  lineId: string;
  /** The selected words (the selection toolbar). */
  selection?: string;
  /** The message the selection or the menu belongs to. */
  messageId?: string;
}

export interface TermDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: SaveTermRequest;
  onSaved: (result: TermWriteResult) => void;
}

interface BodyProps extends Omit<TermDialogProps, "open"> {
  rootLineId: string;
  initial: TermDraft;
  sourceMessageId: string;
}

/** What a refusal says under the fields; `exists` has its own block. */
function refusalText(failure: TermFailure, t: ReturnType<typeof useGlossaryT>, reason: string): string {
  switch (failure.kind) {
    case "limit":
      return t("glossary.limit", { limit: failure.limit });
    case "sourceGone":
      return t("glossary.sourceGone");
    case "archived":
      return t("glossary.archived");
    case "tooLong":
      return t("glossary.tooLong", { max: failure.max });
    case "empty":
      return t(failure.field === "term" ? "glossary.termEmpty" : "glossary.explanationEmpty");
    default:
      return t("glossary.failed", { reason });
  }
}

function TermDialogBody({ request, rootLineId, initial, sourceMessageId, onOpenChange, onSaved }: BodyProps) {
  const t = useGlossaryT();
  const { hostErrorText } = useTangent();
  const save = useSaveTerm();
  const terms = useTerms(rootLineId);
  const limits = terms.data?.limits ?? DEFAULT_TERM_LIMITS;
  const [draft, setDraft] = useState<TermDraft>(initial);
  const [tried, setTried] = useState(false);
  /** The stored term a save ran into (`409 term_exists`), while the term typed is still that one. */
  const [conflict, setConflict] = useState<Term | null>(null);
  const failure = save.error ? classifyTermError(save.error) : null;
  const clash = conflict && conflict.termKey === normalizeTermKey(cleanTerm(draft.term)) ? conflict : null;
  const problem = termInputProblem(draft, limits);

  const send = (replace: boolean) => {
    setTried(true);
    if (problem || save.isPending) return;
    save.mutate(
      { lineId: request.lineId, input: { term: cleanTerm(draft.term), explanation: cleanTermExplanation(draft.explanation), ...(sourceMessageId ? { sourceMessageId } : {}), ...(replace ? { replace: true } : {}) } },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          onSaved(result);
        },
        onError: (error) => {
          const refused = classifyTermError(error);
          setConflict(refused.kind === "exists" ? refused.existing : null);
        },
      },
    );
  };

  return (
    <DialogContent
      width="md"
      title={t("glossary.save")}
      description={t("glossary.dialogBody")}
      footer={
        <>
          <DialogClose render={<Button>{t("glossary.cancel")}</Button>} />
          {clash ? (
            <Button variant="primary" loading={save.isPending} loadingText={t("glossary.saving")} onClick={() => send(true)}>
              {t("glossary.overwrite")}
            </Button>
          ) : (
            <Button variant="primary" icon={<BookA aria-hidden className="size-3.5" />} loading={save.isPending} loadingText={t("glossary.saving")} onClick={() => send(false)}>
              {t("glossary.save")}
            </Button>
          )}
        </>
      }
    >
      <TermFields value={draft} onChange={setDraft} limits={limits} tried={tried} />
      {clash && (
        <div role="alert" data-tg-term-conflict="" className="flex flex-col gap-1.5 rounded-tg-sm border border-tg-warning bg-tg-warning-soft px-3 py-2.5 text-tg-sm text-tg-foreground">
          <span className="font-medium">{t("glossary.exists", { term: clash.term })}</span>
          <span className="text-tg-xs text-tg-muted">{t("glossary.existing")}</span>
          <span className="max-h-40 overflow-auto whitespace-pre-wrap">{clash.explanation}</span>
        </div>
      )}
      {failure && failure.kind !== "exists" && <ErrorAlert>{refusalText(failure, t, describeError(save.error, t, hostErrorText))}</ErrorAlert>}
    </DialogContent>
  );
}

const NO_MESSAGES: readonly Message[] = [];

/** Reads what the prefill needs (the line, its branch, its messages: all already cached where the ask came from). */
function TermDialogLoader(props: Omit<TermDialogProps, "open">) {
  const { request } = props;
  const line = useLine(request.lineId);
  const messages = useMessages(request.lineId);
  const rootLineId = line.data ? (line.data.conversationBranch?.rootLineId ?? line.data.id) : null;
  const branches = useBranches(rootLineId, true);
  // The fields start once, from what is known then; nothing typed is replaced by a later read.
  if (!line.data || !rootLineId || !messages.data || (line.data.conversationBranch && !branches.data)) return null;
  const branch = branches.data?.branches.find((item) => item.lineId === request.lineId) ?? null;
  const prefill = termPrefill({ selection: request.selection, messageId: request.messageId, branch, messages: messages.data.messages ?? NO_MESSAGES });
  return <TermDialogBody {...props} rootLineId={rootLineId} initial={{ term: prefill.term, explanation: prefill.explanation }} sourceMessageId={prefill.sourceMessageId} />;
}

/**
 * 存進名詞表 (F19 §2.1): the term and its explanation, prefilled from where
 * it was asked. A term the conversation already has shows the stored
 * explanation, with 覆寫 (the save again with `replace`) or 取消.
 */
export default function TermDialog({ open, onOpenChange, ...rest }: TermDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <TermDialogLoader onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}
