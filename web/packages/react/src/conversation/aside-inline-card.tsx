import { asideAnswer, asideDaysLeft, branchTitle, isFeatureOn, noteDraft, sortBySeq, TangentError, type BranchView, type Message } from "@tangent/client";
import { BookA, Bookmark, BookmarkCheck, Check, ChevronUp, CornerDownRight, Ellipsis, Maximize2, MessageCircleQuestion, NotebookPen, RefreshCw, StickyNote, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../components/menu";
import { describeError } from "./error-text";
import { useKeepBranch } from "../data/aside-hooks";
import { useTerms } from "../data/glossary-query";
import { useStreamingReply } from "../data/live-hooks";
import { useCreateMemo } from "../data/memo-hooks";
import { useCancelTurn, useRetryTurn } from "../data/mutations";
import { useCreateNote } from "../data/note-mutations";
import { useCapabilities, useMessages } from "../data/queries";
import { useF12T } from "../i18n/f12-messages";
import { cx } from "../lib/cx";
import { Markdown } from "../markdown";
import { useTangent } from "../provider";
import { pendingText } from "./assistant-message";
import { ReplyStageStatus, StopGenerateButton } from "./reply-stage";

/** What this page already kept of an aside's answer (S1: pressing again never keeps it twice), by aside line. */
const kept = new Map<string, { note?: boolean; memo?: boolean }>();

export interface AsideInlineCardProps {
  /** The aside (`kind: aside`) opened in place. */
  branch: BranchView;
  readOnly: boolean;
  /** 展開完整畫面: go to the aside's own view. */
  onExpandFull: (branch: BranchView) => void;
  /** 收合: the aside stays in the map and outline, and is cleared after 7 days as ever. */
  onCollapse: (branch: BranchView) => void;
  /** Move focus to the card's title when it opens (an explicit open, not a reload). */
  autoFocus?: boolean;
  /** Narrow frames say 完整畫面 and drop 7 天後清除. */
  now?: number;
  /**
   * F18: 接著問 (the aside becomes a branch; the host continues it and goes there) and 丟掉 (the host deletes it, with its
   * undo). Each button shows only when its handler is given; 接著問 and 保留 also need the aside feature on.
   * F19: 存進名詞表 (`term`: the host opens the save dialog) while `canSaveTerm`.
   */
  onAction?: (branch: BranchView, action: AsideAction) => void;
  /** F19: the glossary is on and the conversation can be written. */
  canSaveTerm?: boolean;
}

/** What an answered aside's card hands to its host (F18; F19 adds `term`: 存進名詞表). */
export type AsideAction = "continue" | "discard" | "term";

const HEAD_BUTTON =
  "inline-flex h-8 shrink-0 items-center gap-1 rounded-tg-sm px-2 text-tg-xs text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11";
const FOOT_BUTTON =
  "inline-flex h-7.5 items-center gap-1 rounded-tg-sm border px-2.5 @max-[26rem]/tg-aside:px-2 text-tg-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring disabled:opacity-45 pointer-coarse:h-11";

/** The answer as it streams (not an `article`: the transcript's replies are the line's own). */
function PendingReply({ lineId, message, onStop, stopping }: { lineId: string; message: Message; onStop: (() => void) | undefined; stopping: boolean }) {
  const stream = useStreamingReply(lineId, message);
  const text = pendingText(message, stream);
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      {!text && (
        <span className="flex flex-wrap items-center gap-2">
          <ReplyStageStatus createdAt={message.createdAt} />
          {onStop && <StopGenerateButton onStop={onStop} stopping={stopping} />}
        </span>
      )}
      {text && (
        <Markdown variant="message" isStreaming className="font-tg-serif text-tg-reading leading-tg-reading text-tg-foreground [&_p+p]:mt-3">
          {text}
        </Markdown>
      )}
      {text && onStop && <StopGenerateButton onStop={onStop} stopping={stopping} />}
    </div>
  );
}

function Failed({ reason, onRetry, retrying }: { reason: string; onRetry: (() => void) | undefined; retrying: boolean }) {
  const t = useF12T();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2.5 rounded-tg-sm bg-tg-destructive-soft px-3 py-2.5 text-tg-sm text-tg-foreground">
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-tg-destructive" />
      <span className="min-w-0 flex-[1_1_14rem]">{t("aside.failed", { reason: reason || t("aside.failedUnknown") })}</span>
      {onRetry && (
        <button type="button" disabled={retrying} onClick={onRetry} className={cx(FOOT_BUTTON, "border-tg-border-input bg-tg-surface text-tg-foreground hover:bg-tg-accent")}>
          <RefreshCw aria-hidden className="size-3" />
          {t("aside.retry")}
        </button>
      )}
    </div>
  );
}

const FOOT_PLAIN = "border-tg-border-input bg-tg-surface text-tg-foreground hover:bg-tg-accent";
const FOOT_DONE = "border-transparent bg-tg-primary-soft font-medium text-tg-primary-text";
const FOOT_QUIET = "border-transparent text-tg-muted hover:bg-tg-accent hover:text-tg-foreground";

/**
 * Under a finished answer (S1, F18, F19). In view: what happens to the aside
 * itself — 保留 / 取消保留, 接著問, 存進名詞表, 丟掉. In 「⋯」: taking the
 * answer along (記進紀要 / 記成備忘, each kept once and each keeping the
 * aside too: saved means wanted) and the card's own 展開完整畫面 / 收合.
 * Seven buttons in a row wrapped to three lines on a phone.
 */
function WrapUp({ branch, answer, onFailed, onAction, canSaveTerm, days, onExpandFull, onCollapse }: { branch: BranchView; answer: Message; onFailed: (reason: string) => void; onAction: AsideInlineCardProps["onAction"]; canSaveTerm: boolean; days: number; onExpandFull: () => void; onCollapse: () => void }) {
  const t = useF12T();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const createNote = useCreateNote(branch.rootLineId);
  const createMemo = useCreateMemo(branch.rootLineId);
  const keepBranch = useKeepBranch();
  // F19: a term saved from this aside shows as 已存進名詞表 (read from the tree's glossary, so it holds after a reload).
  const terms = useTerms(branch.rootLineId, canSaveTerm);
  const inGlossary = (terms.data?.terms ?? []).some((term) => term.sourceLineId === branch.lineId);
  const [state, setState] = useState(() => kept.get(branch.lineId) ?? {});
  const [busy, setBusy] = useState<"note" | "memo" | "keep" | null>(null);
  const text = noteDraft(`${branch.purpose}：${answer.content}`);
  // Keeping, continuing: only while the aside feature is on (the server refuses otherwise). Throwing away is core.
  const asideOn = isFeatureOn(capabilities.data, "aside") && branch.kind === "aside";
  const notesOn = isFeatureOn(capabilities.data, "notes");
  const memoOn = isFeatureOn(capabilities.data, "memo");
  const isKept = Boolean(branch.keptAt);
  const ended = branch.status !== "open";
  const setKept = (value: boolean) => keepBranch.mutateAsync({ lineId: branch.lineId, keep: value });
  const toggleKept = () => {
    setBusy("keep");
    setKept(!isKept).then(
      () => setBusy(null),
      (error: unknown) => {
        setBusy(null);
        onFailed(t("aside.keepFailed", { reason: describeError(error, t, hostErrorText) }));
      },
    );
  };
  const keep = (which: "note" | "memo", write: () => Promise<unknown>) => {
    if (state[which] || busy !== null) return;
    setBusy(which);
    write().then(
      () => {
        const next = { ...(kept.get(branch.lineId) ?? {}), [which]: true };
        kept.set(branch.lineId, next);
        setState(next);
        setBusy(null);
        // Saved means wanted: the aside is kept too. The answer is already saved, so a failure here stays quiet.
        if (asideOn && !isKept) void setKept(true).catch(() => undefined);
      },
      (error: unknown) => {
        setBusy(null);
        onFailed(t("aside.saveFailed", { reason: describeError(error, t, hostErrorText) }));
      },
    );
  };
  return (
    <>
      {asideOn && (
        <button type="button" aria-pressed={isKept} disabled={busy !== null} onClick={toggleKept} data-tg-aside-keep="" className={cx(FOOT_BUTTON, isKept ? FOOT_DONE : FOOT_PLAIN)}>
          {isKept ? <BookmarkCheck aria-hidden className="size-3" /> : <Bookmark aria-hidden className="size-3" />}
          {isKept ? t("aside.unkeep") : t("aside.keep")}
        </button>
      )}
      {asideOn && onAction && (
        <button type="button" title={t("aside.continueHint")} disabled={busy !== null} onClick={() => onAction(branch, "continue")} className={cx(FOOT_BUTTON, FOOT_PLAIN)}>
          <CornerDownRight aria-hidden className="size-3" />
          {t("aside.continue")}
        </button>
      )}
      {canSaveTerm && onAction && (
        <button type="button" data-tg-aside-term="" aria-pressed={inGlossary} disabled={busy !== null} onClick={() => onAction(branch, "term")} className={cx(FOOT_BUTTON, inGlossary ? FOOT_DONE : FOOT_PLAIN)}>
          {inGlossary ? <Check aria-hidden className="size-3" /> : <BookA aria-hidden className="size-3" />}
          {inGlossary ? t("aside.savedTerm") : t("aside.saveTerm")}
        </button>
      )}
      {onAction && (
        // Narrow cards keep the icon alone: the four of them then share one row.
        <button type="button" aria-label={t("aside.discard")} title={t("aside.discard")} disabled={busy !== null} onClick={() => onAction(branch, "discard")} className={cx(FOOT_BUTTON, FOOT_QUIET)}>
          <Trash2 aria-hidden className="size-3" />
          <span className="@max-[26rem]/tg-aside:hidden">{t("aside.discard")}</span>
        </button>
      )}
      <span className="flex-1" />
      {ended && (
        <span data-tg-aside-fate="" className={cx("text-tg-xs text-tg-muted", !isKept && "@max-[26rem]/tg-aside:hidden")}>
          {isKept ? t("aside.kept") : t("aside.expiresIn", { n: days })}
        </span>
      )}
      <Menu>
        <MenuTrigger
          render={
            <button type="button" aria-label={t("aside.more")} title={t("aside.more")} data-tg-aside-more="" className={cx(FOOT_BUTTON, FOOT_QUIET, "px-2")}>
              <Ellipsis aria-hidden className="size-3.5" />
            </button>
          }
        />
        <MenuContent align="end" side="top">
          {notesOn && (
            <MenuItem
              icon={state.note ? <Check aria-hidden /> : <NotebookPen aria-hidden />}
              disabled={state.note === true || busy !== null}
              onSelect={() => keep("note", () => createNote.mutateAsync({ section: "fact", text, sourceLineId: branch.lineId, sourceMessageId: answer.id }))}
            >
              {state.note ? t("aside.savedNote") : t("aside.saveNote")}
            </MenuItem>
          )}
          {memoOn && (
            <MenuItem icon={state.memo ? <Check aria-hidden /> : <StickyNote aria-hidden />} disabled={state.memo === true || busy !== null} onSelect={() => keep("memo", () => createMemo.mutateAsync({ lineId: branch.parentLineId, text }))}>
              {state.memo ? t("aside.savedMemo") : t("aside.saveMemo")}
            </MenuItem>
          )}
          {(notesOn || memoOn) && <MenuSeparator />}
          <MenuItem icon={<Maximize2 aria-hidden />} onSelect={onExpandFull}>
            {t("aside.expandFull")}
          </MenuItem>
          <MenuItem icon={<ChevronUp aria-hidden />} onSelect={onCollapse}>
            {t("aside.collapse")}
          </MenuItem>
        </MenuContent>
      </Menu>
    </>
  );
}

/** The aside's line no longer exists (cleared after 7 days). */
function isCleared(error: unknown): boolean {
  return error instanceof TangentError && (error.code === "line_not_found" || error.status === 404);
}

/**
 * S1 AsideInlineCard: an aside (a one-turn leaf) opened under the message it
 * came from, so the main line's reading place never moves. Header: its
 * purpose and 順口問・單輪葉節點, 展開完整畫面 and 收合 (Esc too; focus
 * goes back to what opened it). Answering: the question, the live answer,
 * 回答中… and 停止生成. Answered: 記進紀要 / 記成備忘 (each kept once),
 * 7 天後清除, 展開完整畫面, 收合. Failed: the reason and 重試. The dashed
 * --tg-leaf-answer edge is the map's leaf. No height animation.
 */
export default function AsideInlineCard({ branch, readOnly, onExpandFull, onCollapse, autoFocus = false, now, onAction, canSaveTerm = false }: AsideInlineCardProps) {
  const t = useF12T();
  const titleId = useId();
  const messages = useMessages(branch.lineId);
  const cancel = useCancelTurn(branch.lineId);
  const retry = useRetryTurn(branch.lineId);
  const title = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!autoFocus) return;
    opener.current = document.activeElement;
    title.current?.focus({ preventScroll: true });
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setSaveError(null), [branch.lineId]);
  const collapse = () => {
    const back = opener.current;
    onCollapse(branch);
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    collapse();
  };
  const list = sortBySeq(messages.data?.messages ?? []);
  const question = list.find((message) => message.role === "user" && message.kind === "chat");
  const reply = list.filter((message) => message.role === "assistant" && message.kind === "chat").at(-1);
  const answer = asideAnswer(list);
  const cleared = messages.isError && isCleared(messages.error);
  const days = asideDaysLeft(branch.closedAt, now ?? Date.now());
  const ended = branch.status !== "open";
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-tg-aside-inline={branch.lineId}
      onKeyDown={onKeyDown}
      className="@container/tg-aside flex flex-col overflow-hidden rounded-tg-lg border border-dashed border-tg-leaf-answer bg-tg-surface font-tg-sans"
    >
      <header className="flex items-center gap-2 py-2 pr-2 pl-3.5 @max-[26rem]/tg-aside:py-1 @max-[26rem]/tg-aside:pr-1 @max-[26rem]/tg-aside:pl-3">
        <MessageCircleQuestion aria-hidden className="size-4 shrink-0 text-tg-leaf-answer" />
        <span className="flex min-w-0 flex-1 flex-col">
          <h3 ref={title} id={titleId} tabIndex={-1} className="m-0 truncate text-tg-sm font-medium text-tg-foreground-strong outline-none">
            {t("aside.region", { title: branchTitle(branch, t) })}
          </h3>
          <span className="text-tg-xs text-tg-muted">{t("aside.inlineTag")}</span>
        </span>
        <button type="button" aria-label={t("aside.expandFull")} title={t("aside.expandFull")} onClick={() => onExpandFull(branch)} className={HEAD_BUTTON}>
          <Maximize2 aria-hidden className="size-3.5" />
        </button>
        <button type="button" aria-label={t("aside.collapse")} title={t("aside.collapseHint")} onClick={collapse} className={HEAD_BUTTON}>
          <ChevronUp aria-hidden className="size-3.5" />
        </button>
      </header>
      <div className="flex flex-col gap-2.5 px-4 pb-3.5 @max-[26rem]/tg-aside:px-3">
        {messages.isPending && <span className="text-tg-xs text-tg-muted">{t("aside.loading")}</span>}
        {cleared && <p className="m-0 text-tg-sm text-tg-muted">{t("aside.cleared")}</p>}
        {question && <p className="m-0 text-tg-sm text-tg-muted">{t("aside.question", { text: question.content })}</p>}
        {reply?.status === "pending" && (
          <>
            <PendingReply lineId={branch.lineId} message={reply} onStop={readOnly ? undefined : () => cancel.mutate()} stopping={cancel.isPending} />
            <span className="text-tg-xs text-tg-muted">{t("aside.answering")}</span>
          </>
        )}
        {reply?.status === "error" && <Failed reason={reply.meta.error ?? ""} onRetry={readOnly ? undefined : () => retry.mutate()} retrying={retry.isPending} />}
        {answer && reply?.status !== "pending" && (
          <Markdown variant="message" className="font-tg-serif text-tg-reading leading-tg-reading text-tg-foreground [&_p+p]:mt-3">
            {answer.content}
          </Markdown>
        )}
        {saveError && (
          <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
            {saveError}
          </p>
        )}
      </div>
      {(answer || cleared) && reply?.status !== "pending" && (
        <footer className="flex flex-wrap items-center gap-1.5 border-t border-tg-border px-2.5 py-2 @max-[26rem]/tg-aside:gap-1 @max-[26rem]/tg-aside:px-2">
          {answer && !readOnly ? (
            <WrapUp branch={branch} answer={answer} onFailed={setSaveError} onAction={ended ? onAction : undefined} canSaveTerm={canSaveTerm && ended} days={days} onExpandFull={() => onExpandFull(branch)} onCollapse={collapse} />
          ) : (
            // Nothing to decide here (a viewer, or an aside already cleared): the fate and the card's own two buttons.
            <>
              <span className="flex-1" />
              {ended && (
                <span data-tg-aside-fate="" className={cx("text-tg-xs text-tg-muted", !branch.keptAt && "@max-[26rem]/tg-aside:hidden")}>
                  {branch.keptAt ? t("aside.kept") : t("aside.expiresIn", { n: days })}
                </span>
              )}
              <button type="button" onClick={() => onExpandFull(branch)} className={cx(FOOT_BUTTON, FOOT_PLAIN)}>
                <span className="@max-[26rem]/tg-aside:hidden">{t("aside.expandFull")}</span>
                <span className="hidden @max-[26rem]/tg-aside:inline">{t("aside.expandFullShort")}</span>
              </button>
              <button type="button" onClick={collapse} className={cx(FOOT_BUTTON, FOOT_QUIET)}>
                {t("aside.collapse")}
              </button>
            </>
          )}
        </footer>
      )}
    </section>
  );
}
