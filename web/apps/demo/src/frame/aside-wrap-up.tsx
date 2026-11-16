import { asideAnswer, asideDaysLeft, isFeatureOn, noteDraft, type BranchView, type Message } from "@tangent/client";
import { Button, describeError, useCapabilities, useCreateMemo, useCreateNote, useKeepBranch, useTangent, useTerms } from "@tangent/react";
import { BookA, Bookmark, BookmarkCheck, Check, CornerDownRight, CornerUpLeft, NotebookPen, Search, StickyNote, Trash2 } from "lucide-react";
import { useState } from "react";
import { useAsideT } from "./aside-messages";
import type { BranchFlow, Navigate } from "./branch-flows";

export interface AsideWrapUpProps {
  /** An aside that has ended with its answer. */
  branch: BranchView;
  messages: readonly Message[];
  navigate: Navigate;
  onFlow: (flow: BranchFlow) => void;
  toast: (message: string) => void;
  /** F19: the glossary is on: 存進名詞表 (the frame's save dialog; the save keeps the aside too). */
  canSaveTerm?: boolean;
}

type Busy = "note" | "memo" | "keep" | null;

/**
 * Under an answered aside (F10 §4.3, F18 §2.1): what becomes of it, said
 * plainly. 保留 (it is not cleared; 取消保留 undoes that), 接著問 (it
 * becomes a branch with its question and answer in it), 丟掉 (deleted, with
 * an undo for a few seconds), keeping the answer in the notes or as a memo
 * on the line above (each also keeps the aside and goes back there), or just
 * going back (cleared after 7 days as ever). With asides off the server
 * takes neither 保留 nor 接著問, so the older way stays: an investigate
 * branch from the aside's fork point. Loaded only for an answered aside.
 */
export function AsideWrapUp({ branch, messages, navigate, onFlow, toast, canSaveTerm = false }: AsideWrapUpProps) {
  const t = useAsideT();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const createNote = useCreateNote(branch.rootLineId);
  const createMemo = useCreateMemo(branch.rootLineId);
  const keepBranch = useKeepBranch();
  const [busy, setBusy] = useState<Busy>(null);
  // A term saved from this aside reads 已存進名詞表 (from the tree's glossary, so it holds after a reload).
  const terms = useTerms(branch.rootLineId, canSaveTerm);
  const inGlossary = (terms.data?.terms ?? []).some((term) => term.sourceLineId === branch.lineId);
  const answer = asideAnswer(messages);
  if (!answer) return null;
  const asideOn = isFeatureOn(capabilities.data, "aside");
  const kept = Boolean(branch.keptAt);
  const back = () => navigate(branch.parentLineId, branch.anchorMessageId);
  const text = noteDraft(`${branch.purpose}：${answer.content}`);
  const setKept = (keep: boolean) => keepBranch.mutateAsync({ lineId: branch.lineId, keep });
  const toggleKept = () => {
    setBusy("keep");
    setKept(!kept).then(
      () => setBusy(null),
      (error: unknown) => {
        setBusy(null);
        toast(t("asideEnd.keepFailed", { reason: describeError(error, t, hostErrorText) }));
      },
    );
  };
  const save = (which: "note" | "memo", write: () => Promise<unknown>, saved: string) => {
    setBusy(which);
    write().then(
      () => {
        // Saved means wanted: the aside is kept too. The answer is already saved, so a failure here stays quiet.
        if (asideOn && !kept) void setKept(true).catch(() => undefined);
        toast(saved);
        back();
      },
      (error: unknown) => {
        setBusy(null);
        toast(t("asideEnd.failed", { reason: describeError(error, t, hostErrorText) }));
      },
    );
  };
  const followUp = () =>
    onFlow({
      kind: "open",
      lineId: branch.parentLineId,
      request: { anchorMessageId: branch.anchorMessageId, excerpt: answer.content, purpose: branch.purpose, question: "", notice: t("asideEnd.followNotice", { purpose: branch.purpose }) },
    });
  const disabled = busy !== null;
  return (
    <section aria-label={t("asideEnd.title")} data-tg-aside-wrap-up="" className="flex min-w-0 flex-col gap-2.5 rounded-tg border border-tg-border bg-tg-surface-raised p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="m-0 text-tg-sm font-medium text-tg-foreground-strong">{t("asideEnd.title")}</h2>
        <p data-tg-aside-fate="" className="m-0 text-tg-xs text-tg-muted">
          {kept ? t("asideEnd.kept") : t("asideEnd.expires", { n: asideDaysLeft(branch.closedAt, Date.now()) })}
        </p>
      </div>
      {/* What becomes of the aside itself. */}
      <div className="flex flex-wrap gap-2">
        {asideOn && (
          <Button size="sm" variant={kept ? "secondary" : "primary"} aria-pressed={kept} icon={kept ? <BookmarkCheck aria-hidden className="size-3.5" /> : <Bookmark aria-hidden className="size-3.5" />} loading={busy === "keep"} disabled={disabled} onClick={toggleKept}>
            {kept ? t("asideEnd.unkeep") : t("asideEnd.keep")}
          </Button>
        )}
        {asideOn ? (
          <Button size="sm" title={t("asideEnd.continueHint")} icon={<CornerDownRight aria-hidden className="size-3.5" />} disabled={disabled} onClick={() => onFlow({ kind: "continueAside", lineId: branch.lineId })}>
            {t("asideEnd.continue")}
          </Button>
        ) : (
          <Button size="sm" icon={<Search aria-hidden className="size-3.5" />} disabled={disabled} onClick={followUp}>
            {t("asideEnd.followUp")}
          </Button>
        )}
        {canSaveTerm && (
          <Button size="sm" data-tg-aside-term="" aria-pressed={inGlossary} icon={inGlossary ? <Check aria-hidden className="size-3.5" /> : <BookA aria-hidden className="size-3.5" />} disabled={disabled} onClick={() => onFlow({ kind: "saveTerm", lineId: branch.lineId })}>
            {inGlossary ? t("asideEnd.savedTerm") : t("asideEnd.saveTerm")}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden className="size-3.5" />} disabled={disabled} onClick={() => onFlow({ kind: "deleteBranch", lineId: branch.lineId })}>
          {t("asideEnd.discard")}
        </Button>
      </div>
      {/* Taking the answer along, and the way back. */}
      <div className="flex flex-wrap gap-2 border-t border-tg-border pt-2.5">
        {isFeatureOn(capabilities.data, "notes") && (
          <Button size="sm" icon={<NotebookPen aria-hidden className="size-3.5" />} loading={busy === "note"} disabled={disabled} onClick={() => save("note", () => createNote.mutateAsync({ section: "fact", text, sourceLineId: branch.lineId, sourceMessageId: answer.id }), t("asideEnd.noteSaved"))}>
            {t("asideEnd.keepNote")}
          </Button>
        )}
        {isFeatureOn(capabilities.data, "memo") && (
          <Button size="sm" icon={<StickyNote aria-hidden className="size-3.5" />} loading={busy === "memo"} disabled={disabled} onClick={() => save("memo", () => createMemo.mutateAsync({ lineId: branch.parentLineId, text }), t("asideEnd.memoSaved"))}>
            {t("asideEnd.keepMemo")}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<CornerUpLeft aria-hidden className="size-3.5" />} disabled={disabled} onClick={back}>
          {t("asideEnd.back")}
        </Button>
      </div>
    </section>
  );
}
