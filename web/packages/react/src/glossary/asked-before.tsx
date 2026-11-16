import { askedBefore, classifyTermError, isTermLookup, normalizeTermKey, type TermSearchHit } from "@tangent/client";
import { History } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { ErrorAlert } from "../branch/error-alert";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { describeError } from "../conversation/error-text";
import { useSaveTerm, useTermSearch } from "../data/glossary-hooks";
import { useTerms } from "../data/glossary-query";
import { useGlossaryT } from "../i18n/glossary-messages";
import { useTangent } from "../provider";

/** The selection must rest this long before the lookup across conversations is sent. */
export const ASKED_BEFORE_DEBOUNCE_MS = 300;

export interface AskedBeforeChipProps {
  /** The selected words. */
  text: string;
  /** The conversation on screen: its own terms are not "before". */
  rootLineId: string;
  /** 「之前問過」 was pressed: the host shows what was said then. */
  onOpen: (hit: TermSearchHit) => void;
}

function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * 「之前問過：{對話}」 in the selection toolbar (F19 §2.4): the selected
 * words, when they are short enough to be a term, are looked up in the
 * glossaries of the other conversations. The lookup waits for the selection
 * to rest, is given up after a few seconds and says nothing when it fails:
 * 秒問解釋 never waits for it.
 */
export default function AskedBeforeChip({ text, rootLineId, onOpen }: AskedBeforeChipProps) {
  const t = useGlossaryT();
  const lookup = isTermLookup(text) ? text.trim() : "";
  const settled = useSettled(lookup, ASKED_BEFORE_DEBOUNCE_MS);
  const search = useTermSearch(settled, settled !== "" && settled === lookup);
  const hit = settled === lookup && search.data ? askedBefore(search.data.terms, lookup, rootLineId) : null;
  if (!hit) return null;
  // Pressing must not clear the selection the hint is about.
  const keep = (event: MouseEvent) => event.preventDefault();
  return (
    <button
      type="button"
      data-tg-asked-before={hit.id}
      onMouseDown={keep}
      onClick={() => onOpen(hit)}
      className="mt-0.5 inline-flex min-h-7.5 min-w-0 items-center justify-center gap-1.5 rounded-tg-sm border-t border-tg-foreground px-2.5 text-tg-xs text-tg-background hover:bg-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
    >
      <History aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t("glossary.askedBefore", { title: hit.rootTitle || t("glossary.untitled") })}</span>
    </button>
  );
}

export interface AskedBeforeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hit: TermSearchHit;
  /** The line on screen: 複製到這篇的名詞表 saves the term from it. */
  lineId: string;
  rootLineId: string;
  /** The message the words were selected in. */
  messageId?: string;
  /** No copying (a viewer, an archived conversation). */
  readOnly?: boolean;
  onCopied: () => void;
}

function AskedBeforeBody({ hit, lineId, rootLineId, messageId, readOnly = false, onOpenChange, onCopied }: Omit<AskedBeforeDialogProps, "open">) {
  const t = useGlossaryT();
  const { hostErrorText } = useTangent();
  const save = useSaveTerm();
  const here = useTerms(rootLineId);
  const failure = save.error ? classifyTermError(save.error) : null;
  const already = failure?.kind === "exists" || (here.data?.terms ?? []).some((term) => term.termKey === normalizeTermKey(hit.term));
  const copy = () => {
    if (save.isPending) return;
    save.mutate(
      { lineId, input: { term: hit.term, explanation: hit.explanation, ...(messageId ? { sourceMessageId: messageId } : {}) } },
      {
        onSuccess: () => {
          onOpenChange(false);
          onCopied();
        },
      },
    );
  };
  return (
    <DialogContent
      width="md"
      title={t("glossary.askedBeforeTitle", { term: hit.term })}
      description={t("glossary.askedIn", { title: hit.rootTitle || t("glossary.untitled") })}
      footer={
        <>
          <DialogClose render={<Button>{t("glossary.close")}</Button>} />
          {!readOnly && !already && (
            <Button variant="primary" loading={save.isPending} loadingText={t("glossary.saving")} onClick={copy}>
              {t("glossary.copyHere")}
            </Button>
          )}
        </>
      }
    >
      <p className="m-0 text-tg-sm whitespace-pre-wrap text-tg-foreground">{hit.explanation}</p>
      {hit.sourceLabel && <p className="m-0 text-tg-xs text-tg-muted">{`${t("glossary.source")}・${hit.sourceLabel}`}</p>}
      {already && <p className="m-0 text-tg-xs text-tg-muted">{t("glossary.alreadyHere")}</p>}
      {failure && failure.kind !== "exists" && (
        <ErrorAlert>
          {failure.kind === "limit" ? t("glossary.limit", { limit: failure.limit }) : failure.kind === "archived" ? t("glossary.archived") : t("glossary.failed", { reason: describeError(save.error, t, hostErrorText) })}
        </ErrorAlert>
      )}
    </DialogContent>
  );
}

/** What was said when the term was asked about in another conversation, and 複製到這篇的名詞表. */
export function AskedBeforeDialog({ open, onOpenChange, ...rest }: AskedBeforeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <AskedBeforeBody onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}
