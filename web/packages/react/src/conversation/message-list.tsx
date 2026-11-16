import {
  canAnchorBranch,
  canTag,
  cardEditReasons,
  chaptersByStart,
  foldSpans,
  hasErrorCode,
  isHostNotice,
  timeGaps,
  type BranchSuggestion,
  type BranchView,
  type Chapter,
  type Fold,
  type Message,
} from "@tangent/client";
import { ExternalLink, PackageOpen } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDismissedStale } from "../f8/stale-dismissed";
import type { MarkdownMark, MarkScanner } from "../markdown";
import type { AsideAction } from "./aside-inline-card";
import { TERM_MARK_PREFIX, type MessageTerms, type TermMarking } from "./term-marking";
import { useStreamingReply } from "../data/live-hooks";
import { isOptimisticMessage, visibleMessages } from "../data/message-cache";
import { useLine } from "../data/queries";
import type { BranchCardProps } from "../branch/branch-card";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { AssistantMessage } from "./assistant-message";
import { BranchSuggestions } from "./branch-suggestions";
import { ChapterDivider } from "./chapter-divider";
import { ForkMarker } from "./fork-marker";
import { MessageActions, MessageSheetButton, type MessageActionsProps } from "./message-actions";
import { LazyArgTag, LazyBranchCard, LazyDivergeMarker, LazyFoldBlock } from "./p3-slots";
import { useConversationOptions } from "./view-options";
import { LazyAsideInlineCard, LazyExcerptAnchor } from "./f12-slots";
import { forksByAnchor } from "./models";
import { UnreadDivider } from "./unread-divider";
import { TimeGapDivider } from "./time-gap-divider";
import { UserMessage } from "./user-message";

export interface MessageListHandlers {
  onBranch?: (message: Message) => void;
  onNote?: (message: Message) => void;
  onPark?: (message: Message) => void;
  /** 記成備忘 on a chat message (the memo feature, F10): the host saves its text as a memo of the line. */
  onMemo?: (message: Message) => void;
  /** 存進名詞表 on a finished chat message (the glossary feature, F19): the host opens the save dialog. */
  onTerm?: (message: Message) => void;
  onRetry?: (message: Message) => void;
  onSuggestion?: (message: Message, suggestion: BranchSuggestion) => void;
  /** Enters a branch from a message's fork list (A4). */
  onEnterBranch?: (branch: BranchView) => void;
  /** F18: 接著問 / 丟掉 on an answered aside opened in place (the host continues or deletes it). */
  onAsideAction?: (branch: BranchView, action: AsideAction) => void;
  /** "Move from here into a branch" on the user's own messages (A7). */
  onMove?: (message: Message) => void;
  /** 從這則抽成支線… (F13 S3): any stretch from this message (a reply's from its question) into a branch. */
  onExtract?: (message: Message) => void;
  /** Opens a branch (a card's or a move marker's), at one of its messages when given. */
  onOpenBranch?: (branchLineId: string, messageId?: string) => void;
  /** Highlights a message of this line (a card's fork point or decision). */
  onGoToMessage?: (messageId: string) => void;
  /** 「從這裡開新對話」 on a reply (the spinoff feature, B2). */
  onSpinoff?: (message: Message) => void;
  /** 釘選 / 取消釘選 on a chat message (B9, core): `pinned` is the state asked for. */
  onPin?: (message: Message, pinned: boolean) => void;
  /** 關聯… on a chat message (the relations feature, C3). */
  onRelate?: (message: Message) => void;
  /** 從這則起折疊… on a finished chat message (the fold feature, D4). */
  onFold?: (message: Message) => void;
  /** 給我幾個方向… on a finished reply (the diverge feature, D3). */
  onDiverge?: (message: Message) => void;
  /** 修改並分岔… on the user's message (F8 S6); on the line's first one it is shown disabled, with `onAskAgain` instead. */
  onEditBranch?: (message: Message) => void;
  /** 改問，開成新對話… on the line's first message (decision #10). */
  onAskAgain?: (message: Message) => void;
  /** 分岔重答（可換模型）… on a finished reply (F8 S7). */
  onRegenerate?: (message: Message) => void;
  /** 將清單存入停車場（n 項）… on a finished reply with a list of two or more items (F8 S11). */
  onListToSeeds?: (message: Message) => void;
  /** A type set from the message's 「⋯」 was refused (the menu is closed by then). */
  onTagFailed?: (reason: string) => void;
  /** F12 S4: 停止生成 on the pending reply (the composer's stop). */
  onStop?: () => void;
  /** F12 S1: opens an aside in place under its message, or closes it (its fork row, its excerpt anchor). */
  onToggleAside?: (branch: BranchView) => void;
  /** F12 S6: 編輯結論 on a conclusion card. */
  onEditCard?: (message: Message, branch: BranchView) => void;
  /** F12 S6: 繼續追問 on a conclusion card (a new branch anchored on it). */
  onFollowUpCard?: (message: Message, branch: BranchView) => void;
}

export interface MessageListProps extends MessageListHandlers {
  lineId: string;
  /** In seq order (`useMessages`). */
  messages: readonly Message[];
  /**
   * F18: `branches` is the loaded outline with asides. A marker whose branch is not in it is then looked up: deleted
   * (B23 leaves the marker on the parent line) it reads 已刪除 with no way in; moved to another conversation it still links.
   */
  branchesLoaded?: boolean;
  /** The tree's outline (`useBranches`), for the fork markers. */
  branches?: readonly BranchView[];
  /** Hides every writing action (read-only identity). */
  readOnly?: boolean;
  /** The branch_suggest feature is on. */
  showSuggestions?: boolean;
  /** The leaf feature is on: a conclusion card's title row is its branch's leaf (B1). */
  showLeaves?: boolean;
  highlightedId?: string | null;
  /** The line's chapters (chapters feature); a divider marks each start once there are two or more. */
  chapters?: readonly Chapter[];
  /** F14: a dashed divider where the line paused 30 minutes or more (on unless false). */
  timeGaps?: boolean;
  /** Removes a manual milestone from its divider. */
  onDeleteMilestone?: (milestoneId: string) => void;
  /** "n 則未讀" goes before this message (`firstUnreadId`); the host keeps it for the visit, after marking the line read. */
  unread?: { messageId: string; count: number } | null;
  /**
   * What the host puts under a reply, by message id (F5: the drift hint).
   * Only replies with an entry re-render when it changes.
   */
  replyExtras?: ReadonlyMap<string, ReactNode>;
  /** Argument types on each finished chat message (the ibis feature, D2): the tree's root for the outline. */
  tags?: { rootLineId: string };
  /** The line's folds (the fold feature, D4): their messages collapse into one block each. */
  folds?: readonly Fold[];
  /** A reply's diverged directions show as one marker under it, out of the fork list (the diverge feature, D3). */
  showDiverge?: boolean;
  /** The fold holding this message shows open (F8 S3: the in-tree search jumped there). */
  expandMessageId?: string | null;
  /** F8 S12: conclusion cards show 前提已更新 from this tree's notes and relations. */
  stale?: BranchCardProps["stale"];
  /** F12 S4: the stop is on its way (the pending reply's 停止生成 is disabled meanwhile). */
  stopping?: boolean;
  /** F12 S1: the asides open in place now, by line id. */
  inlineAsides?: ReadonlySet<string>;
  /** F12 S1: the aside opened on purpose just now; its card takes focus when it appears (never on a re-render). */
  focusAsideId?: string | null;
  /** F19 §2.3: marks the tree's glossary terms in finished replies (`useTermMarking`); only replies with a term re-render when it changes. */
  terms?: TermMarking | null;
  /** F19: asides opened in place offer 存進名詞表 (the glossary is on and the line can be written). */
  asideTerms?: boolean;
  className?: string;
}

const NO_FORKS: readonly BranchView[] = [];

/** The fork lists without diverged directions, and those directions by message (D3); unchanged when markers are off. */
function splitDiverged(forks: ReadonlyMap<string, BranchView[]>, on: boolean): { forks: ReadonlyMap<string, readonly BranchView[]>; diverged: ReadonlyMap<string, readonly BranchView[]> } {
  if (!on) return { forks, diverged: new Map() };
  const rest = new Map<string, readonly BranchView[]>();
  const diverged = new Map<string, readonly BranchView[]>();
  for (const [messageId, list] of forks) {
    const directions = list.filter((branch) => branch.origin === "diverge");
    rest.set(messageId, directions.length > 0 ? list.filter((branch) => branch.origin !== "diverge") : list);
    if (directions.length > 0) diverged.set(messageId, directions);
  }
  return { forks: rest, diverged };
}

/**
 * A text selection forks only from user and assistant chat messages. B17 lets
 * a conclusion card anchor a branch too, but only through its 繼續追問 (the
 * card's words are not the reply's), so `data-forkable` stays false on cards;
 * their fork markers still show (`canAnchorBranch`).
 */
function isForkable(message: Message): boolean {
  return message.kind === "chat" && (message.role === "user" || message.role === "assistant");
}

const NO_IDS: ReadonlySet<string> = new Set();
const NO_MARKS: readonly MarkdownMark[] = [];

/** S2: the branches opened from words of this reply, grouped by those words (newest branch first in each group). */
function excerptGroups(forks: readonly BranchView[]): { marks: readonly MarkdownMark[]; groups: ReadonlyMap<string, readonly BranchView[]> } {
  const groups = new Map<string, BranchView[]>();
  for (const branch of forks) {
    const text = branch.excerpt.trim();
    if (text) groups.set(text, [...(groups.get(text) ?? []), branch]);
  }
  if (groups.size === 0) return { marks: NO_MARKS, groups };
  for (const [text, list] of groups) groups.set(text, [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  // Longer words first, so a short excerpt inside a longer one does not take its place.
  const marks = [...groups.keys()].sort((a, b) => b.length - a.length).map((text) => ({ text, key: groups.get(text)![0]!.lineId }));
  return { marks, groups };
}

/** The "#n" of each chat message: its 1-based place among the line's chat messages. */
function chatPositions(messages: readonly Message[]): Map<string, number> {
  const chat = messages.filter((message) => message.kind === "chat" && message.role !== "system");
  return new Map(chat.map((message, index) => [message.id, index + 1]));
}

/**
 * Handlers that never change identity but always call the latest props, so
 * memoised rows do not re-render because a parent passed new inline functions.
 */
function useStableHandlers(props: MessageListHandlers): Required<MessageListHandlers> & { has: Readonly<Record<keyof MessageListHandlers, boolean>> } {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const stable = useMemo(
    () => ({
      onBranch: (message: Message) => latest.current.onBranch?.(message),
      onNote: (message: Message) => latest.current.onNote?.(message),
      onPark: (message: Message) => latest.current.onPark?.(message),
      onMemo: (message: Message) => latest.current.onMemo?.(message),
      onTerm: (message: Message) => latest.current.onTerm?.(message),
      onRetry: (message: Message) => latest.current.onRetry?.(message),
      onSuggestion: (message: Message, suggestion: BranchSuggestion) => latest.current.onSuggestion?.(message, suggestion),
      onEnterBranch: (branch: BranchView) => latest.current.onEnterBranch?.(branch),
      onMove: (message: Message) => latest.current.onMove?.(message),
      onExtract: (message: Message) => latest.current.onExtract?.(message),
      onOpenBranch: (branchLineId: string, messageId?: string) => latest.current.onOpenBranch?.(branchLineId, messageId),
      onGoToMessage: (messageId: string) => latest.current.onGoToMessage?.(messageId),
      onSpinoff: (message: Message) => latest.current.onSpinoff?.(message),
      onPin: (message: Message, pinned: boolean) => latest.current.onPin?.(message, pinned),
      onRelate: (message: Message) => latest.current.onRelate?.(message),
      onFold: (message: Message) => latest.current.onFold?.(message),
      onDiverge: (message: Message) => latest.current.onDiverge?.(message),
      onEditBranch: (message: Message) => latest.current.onEditBranch?.(message),
      onAskAgain: (message: Message) => latest.current.onAskAgain?.(message),
      onRegenerate: (message: Message) => latest.current.onRegenerate?.(message),
      onListToSeeds: (message: Message) => latest.current.onListToSeeds?.(message),
      onTagFailed: (reason: string) => latest.current.onTagFailed?.(reason),
      onStop: () => latest.current.onStop?.(),
      onToggleAside: (branch: BranchView) => latest.current.onToggleAside?.(branch),
      onAsideAction: (branch: BranchView, action: AsideAction) => latest.current.onAsideAction?.(branch, action),
      onEditCard: (message: Message, branch: BranchView) => latest.current.onEditCard?.(message, branch),
      onFollowUpCard: (message: Message, branch: BranchView) => latest.current.onFollowUpCard?.(message, branch),
    }),
    [],
  );
  // Only whether a handler is given matters to the rows, not its identity.
  const given = [
    props.onBranch,
    props.onNote,
    props.onPark,
    props.onMemo,
    props.onRetry,
    props.onSuggestion,
    props.onEnterBranch,
    props.onMove,
    props.onOpenBranch,
    props.onGoToMessage,
    props.onSpinoff,
    props.onPin,
    props.onRelate,
    props.onFold,
    props.onDiverge,
    props.onEditBranch,
    props.onAskAgain,
    props.onRegenerate,
    props.onListToSeeds,
    props.onTagFailed,
    props.onStop,
    props.onToggleAside,
    props.onEditCard,
    props.onFollowUpCard,
    props.onExtract,
    props.onAsideAction,
    props.onTerm,
  ].map(Boolean);
  const [branch, note, park, memoOn, retry, suggestion, enter, move, open, goTo, spinoff, pin, relate, fold, diverge, edit, askAgain, regenerate, listToSeeds, tagFailed, stop, toggleAside, editCard, followUpCard, extract, asideAction, term] = given;
  const has = useMemo(
    () => ({
      onBranch: !!branch,
      onNote: !!note,
      onPark: !!park,
      onMemo: !!memoOn,
      onRetry: !!retry,
      onSuggestion: !!suggestion,
      onEnterBranch: !!enter,
      onMove: !!move,
      onOpenBranch: !!open,
      onGoToMessage: !!goTo,
      onSpinoff: !!spinoff,
      onPin: !!pin,
      onRelate: !!relate,
      onFold: !!fold,
      onDiverge: !!diverge,
      onEditBranch: !!edit,
      onAskAgain: !!askAgain,
      onRegenerate: !!regenerate,
      onListToSeeds: !!listToSeeds,
      onTagFailed: !!tagFailed,
      onStop: !!stop,
      onToggleAside: !!toggleAside,
      onEditCard: !!editCard,
      onFollowUpCard: !!followUpCard,
      onExtract: !!extract,
      onAsideAction: !!asideAction,
      onTerm: !!term,
    }),
    [branch, note, park, memoOn, retry, suggestion, enter, move, open, goTo, spinoff, pin, relate, fold, diverge, edit, askAgain, regenerate, listToSeeds, tagFailed, stop, toggleAside, editCard, followUpCard, extract, asideAction, term],
  );
  return useMemo(() => ({ ...stable, has }), [stable, has]);
}

type StableHandlers = ReturnType<typeof useStableHandlers>;

/** A spinoff's marker (B2): 「已獨立 →」 to the new conversation. */
function SpunOffMarker({ to, onOpen }: { to: NonNullable<Message["meta"]["spunOffTo"]>; onOpen?: ((lineId: string) => void) | undefined }) {
  const t = useUiT();
  return (
    <p className="m-0 flex flex-wrap items-center justify-center gap-2 text-center text-tg-xs text-tg-muted">
      <ExternalLink aria-hidden className="size-3.5" />
      <span>{t("message.spunOff")}</span>
      {/* B8.2: the new conversation may have been deleted since; then it is named, not linked. */}
      {!to.available ? (
        <span className="text-tg-foreground">{t("marker.spunOffGone", { title: to.title })}</span>
      ) : onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(to.lineId)}
          className="text-tg-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
        >
          {t("marker.spunOffLink", { title: to.title })}
        </button>
      ) : (
        <span className="text-tg-foreground">{to.title}</span>
      )}
    </p>
  );
}

function MarkerMessage({ message, onOpenBranch, orphan = false }: { message: Message; onOpenBranch?: ((branchLineId: string) => void) | undefined; orphan?: boolean | undefined }) {
  const t = useUiT();
  // F18: the branch the messages went to is not in this tree any more. Deleted (B23), it is said, never a link to nowhere.
  const probe = useLine(orphan && !message.meta.spunOffTo ? (message.meta.branchLineId ?? null) : null);
  const gone = orphan && hasErrorCode(probe.error, "line_not_found");
  if (message.meta.spunOffTo) return <SpunOffMarker to={message.meta.spunOffTo} onOpen={onOpenBranch} />;
  const branchLineId = gone ? "" : message.meta.branchLineId;
  return (
    <p className="m-0 flex flex-wrap items-center justify-center gap-2 text-center text-tg-xs text-tg-muted">
      <PackageOpen aria-hidden className="size-3.5" />
      <span>{t("message.marker")}</span>
      {message.content && <span className="text-tg-foreground">{message.content}</span>}
      {gone && <span data-tg-marker-gone="">{t("marker.deleted")}</span>}
      {branchLineId && onOpenBranch && (
        <button
          type="button"
          onClick={() => onOpenBranch(branchLineId)}
          className="text-tg-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
        >
          {t("marker.open")}
        </button>
      )}
    </p>
  );
}

/** A pending reply: the only rows that read the live stream store. */
const PendingAssistant = memo(function PendingAssistant({ lineId, message, label, onStop, stopping }: { lineId: string; message: Message; label: string; onStop: (() => void) | undefined; stopping: boolean }) {
  const stream = useStreamingReply(lineId, message);
  return <AssistantMessage message={message} stream={stream} label={label} {...(onStop ? { onStop } : {})} stopping={stopping} />;
});

interface RowProps {
  lineId: string;
  message: Message;
  position: number;
  forks: readonly BranchView[];
  readOnly: boolean;
  showSuggestions: boolean;
  highlighted: boolean;
  /** Only the last reply can be retried (the server re-runs the last, failed turn). */
  retryable: boolean;
  handlers: StableHandlers;
  /** Card rows only: the branch the card came from and the line's "#n" numbers. */
  cardBranch?: BranchView | undefined;
  showLeaf?: boolean | undefined;
  numbers?: ReadonlyMap<string, number> | undefined;
  /** The host's extra under a reply (`replyExtras`). */
  extra?: ReactNode;
  /** The tree's root while argument tags are shown (D2). */
  tagRoot?: string | undefined;
  /** Inside a fold's block: it cannot start another fold. */
  folded?: boolean | undefined;
  /** The directions diverged from this reply (D3), shown as one marker. */
  diverged?: readonly BranchView[] | undefined;
  /** Card rows: 前提已更新 (F8 S12). */
  stale?: BranchCardProps["stale"] | undefined;
  /** No message before it to fork from: 修改並分岔 is shown disabled (decision #10). */
  firstOfLine?: boolean | undefined;
  /** Pending rows: the stop is on its way. */
  stopping?: boolean | undefined;
  /** The asides open in place (rows with asides among their forks only). */
  inlineAsides?: ReadonlySet<string> | undefined;
  /** The aside just opened on purpose (its card takes focus); rows with it only. */
  focusAsideId?: string | null | undefined;
  /** Rows with follow-ups of an edited card among their forks: those follow-ups (前提已更新). */
  staleIds?: ReadonlySet<string> | undefined;
  /** Marker rows: the branch it points to is not in the loaded outline (F18: deleted, or moved to another conversation). */
  markerOrphan?: boolean | undefined;
  /** Finished replies that hold a glossary term (F19 §2.3): what marks them (the same object until their own terms change). */
  terms?: MessageTerms | undefined;
  /** Rows with an aside open in place: its card offers 存進名詞表 (F19). */
  asideTerms?: boolean | undefined;
}

/** The asides of `forks` open in place, in fork order. */
function openAsides(forks: readonly BranchView[], inline: ReadonlySet<string> | undefined): BranchView[] {
  return inline ? forks.filter((branch) => branch.kind === "aside" && inline.has(branch.lineId)) : [];
}

/** The inline cards of a row's open asides (S1), under its fork marker. */
function InlineAsides({ forks, inline, focusId, readOnly, handlers, terms = false }: { forks: readonly BranchView[]; inline: ReadonlySet<string> | undefined; focusId: string | null | undefined; readOnly: boolean; handlers: StableHandlers; terms?: boolean | undefined }) {
  const open = openAsides(forks, inline);
  if (open.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {open.map((branch) => (
        <LazyAsideInlineCard key={branch.lineId} branch={branch} readOnly={readOnly} autoFocus={branch.lineId === focusId} onExpandFull={handlers.onEnterBranch} onCollapse={handlers.onToggleAside} {...(handlers.has.onAsideAction ? { onAction: handlers.onAsideAction, canSaveTerm: terms } : {})} />
      ))}
    </div>
  );
}

/** S2: the words of a finished reply its branches were opened from, as anchors. */
function useExcerptMarks(forks: readonly BranchView[], inline: ReadonlySet<string> | undefined, handlers: StableHandlers) {
  const { marks, groups } = useMemo(() => excerptGroups(forks), [forks]);
  const { has } = handlers;
  const renderMark = useCallback(
    (mark: MarkdownMark, children: ReactNode) => {
      const list = groups.get(mark.text) ?? [];
      const newest = list[0];
      return (
        <LazyExcerptAnchor
          branches={list}
          open={newest !== undefined && newest.kind === "aside" && (inline?.has(newest.lineId) ?? false)}
          answer={newest?.kind === "aside" ? newest.conclusionLine : undefined}
          onAct={(branch) => (branch.kind === "aside" && has.onToggleAside ? handlers.onToggleAside(branch) : handlers.onEnterBranch(branch))}
          onFullView={handlers.onEnterBranch}
        >
          {children}
        </LazyExcerptAnchor>
      );
    },
    [groups, inline, handlers, has],
  );
  return marks.length > 0 && has.onEnterBranch ? { marks, renderMark } : null;
}

type RowMarks = { renderMark: (mark: MarkdownMark, children: ReactNode) => ReactNode; marks?: readonly MarkdownMark[]; scanMarks?: MarkScanner };

/** A reply's marks: its excerpt anchors (S2) and, in the text that is left, the glossary's terms (F19 §2.3). */
function useRowMarks(excerpts: ReturnType<typeof useExcerptMarks>, terms: MessageTerms | undefined): RowMarks | null {
  return useMemo(() => {
    if (!terms) return excerpts;
    const renderMark = (mark: MarkdownMark, children: ReactNode) => (mark.key.startsWith(TERM_MARK_PREFIX) ? terms.render(mark.key, children) : (excerpts?.renderMark(mark, children) ?? children));
    return { renderMark, scanMarks: terms.scan, ...(excerpts ? { marks: excerpts.marks } : {}) };
  }, [excerpts, terms]);
}

/** Pin, relate and fold, shared by both roles' action rows (a finished chat message only). */
function pinAndRelate(message: Message, handlers: StableHandlers, folded = false) {
  const { has } = handlers;
  return {
    ...(has.onPin ? { onPin: () => handlers.onPin(message, !message.pinned), pinned: message.pinned } : {}),
    ...(has.onRelate ? { onRelate: () => handlers.onRelate(message) } : {}),
    ...(has.onFold && !folded && canTag(message) ? { onFold: () => handlers.onFold(message) } : {}),
  };
}

/** The argument type control of a finished chat message, while tags are shown. */
function tagOf(message: Message, tagRoot: string | undefined, who: string): ReactNode {
  if (!tagRoot || !message.tag || !canTag(message) || isOptimisticMessage(message)) return undefined;
  return <LazyArgTag message={message} rootLineId={tagRoot} who={who} />;
}

/** The 「⋯」 menu's 標論證類型… while argument types are shown (S1: no type control in the label row until there is a type). */
function tagMenuOf(message: Message, tagRoot: string | undefined, handlers: StableHandlers): MessageActionsProps["tag"] {
  if (!tagRoot || !canTag(message) || isOptimisticMessage(message)) return undefined;
  return { current: message.tag ?? null, rootLineId: tagRoot, messageId: message.id, onFailed: handlers.onTagFailed };
}

/** The toolbar and, on touch screens, the label row's 「⋯」 (same actions). */
function actionsOf(props: MessageActionsProps): { actions: ReactNode; menu: ReactNode } {
  return { actions: <MessageActions {...props} />, menu: <MessageSheetButton {...props} /> };
}

/** One message; memoised so a streaming reply or a new message leaves the finished rows alone. */
const MessageRow = memo(function MessageRow(props: RowProps) {
  const { lineId, message, position, forks, readOnly, showSuggestions, highlighted, retryable, handlers } = props;
  const t = useUiT();
  const { has } = handlers;
  const marks = useRowMarks(useExcerptMarks(forks, props.inlineAsides, handlers), props.terms);
  const { expandCards } = useConversationOptions();
  if (message.kind === "branch_card") {
    const cardBranch = props.cardBranch ?? null;
    return (
      <>
        <LazyBranchCard
          // The reader's default (cards open or closed): a card takes it when it mounts, so changing it starts every card from the new default.
          key={expandCards ? "open" : "closed"}
          defaultExpanded={expandCards}
          message={message}
          branch={cardBranch}
          showLeaf={props.showLeaf ?? false}
          mainNumbers={props.numbers}
          highlighted={highlighted}
          {...(props.stale ? { stale: props.stale } : {})}
          {...(has.onOpenBranch ? { onOpenBranch: handlers.onOpenBranch } : {})}
          {...(has.onGoToMessage ? { onGoToMessage: handlers.onGoToMessage } : {})}
          {...(!readOnly && cardBranch?.status === "merged" && has.onEditCard ? { onEdit: () => handlers.onEditCard(message, cardBranch) } : {})}
          {...(!readOnly && cardBranch && has.onFollowUpCard && canAnchorBranch(message) ? { onFollowUp: () => handlers.onFollowUpCard(message, cardBranch) } : {})}
        />
        {/* B17: follow-ups opened from this card fork from it. */}
        <ForkMarker branches={forks} fromCard className="mt-2" staleIds={props.staleIds ?? NO_IDS} {...(has.onEnterBranch ? { onSelect: handlers.onEnterBranch } : {})} />
      </>
    );
  }
  if (message.kind === "branch_marker") return <MarkerMessage message={message} orphan={props.markerOrphan} onOpenBranch={has.onOpenBranch ? handlers.onOpenBranch : undefined} />;
  if (message.role === "user") {
    const settled = !isOptimisticMessage(message);
    const userLabel = t("message.labelUser", { n: position });
    const writing: Partial<MessageActionsProps> =
      readOnly || !settled
        ? {}
        : {
            ...(has.onMove ? { onMove: () => handlers.onMove(message) } : {}),
            ...(has.onExtract && message.status === "done" ? { onExtract: () => handlers.onExtract(message) } : {}),
            ...(has.onMemo && message.status === "done" ? { onMemo: () => handlers.onMemo(message) } : {}),
            ...(has.onTerm && message.status === "done" ? { onTerm: () => handlers.onTerm(message) } : {}),
            ...pinAndRelate(message, handlers, props.folded),
            ...(has.onEditBranch && message.status === "done" ? (props.firstOfLine ? { editBlocked: true } : { onEditBranch: () => handlers.onEditBranch(message) }) : {}),
            ...(has.onAskAgain && props.firstOfLine && message.status === "done" ? { onAskAgain: () => handlers.onAskAgain(message) } : {}),
            ...(has.onSpinoff && message.status === "done" && !props.firstOfLine ? { onSpinoff: () => handlers.onSpinoff(message) } : {}),
            ...(!props.folded ? { tag: tagMenuOf(message, props.tagRoot, handlers) } : {}),
          };
    const { actions, menu } = settled ? actionsOf({ text: message.content, role: "user", who: userLabel, ...writing }) : { actions: undefined, menu: undefined };
    return (
      <>
        <UserMessage message={message} label={userLabel} highlighted={highlighted} actions={actions} menu={menu} tag={tagOf(message, props.tagRoot, userLabel)} />
        {/* F12 S1: an aside asked about the user's own words opens under them too. */}
        <InlineAsides forks={forks} inline={props.inlineAsides} focusId={props.focusAsideId} readOnly={readOnly} handlers={handlers} terms={props.asideTerms} />
      </>
    );
  }
  if (message.role === "system") return <p className="m-0 text-center text-tg-xs text-tg-muted">{message.content}</p>;
  const label = t("message.labelAssistant", { n: position });
  if (message.status === "pending") return <PendingAssistant lineId={lineId} message={message} label={label} onStop={!readOnly && has.onStop ? handlers.onStop : undefined} stopping={props.stopping ?? false} />;
  const done = message.status === "done";
  const writing: Partial<MessageActionsProps> = readOnly
    ? {}
    : {
        ...(has.onBranch ? { onBranch: () => handlers.onBranch(message) } : {}),
        ...(has.onNote ? { onNote: () => handlers.onNote(message) } : {}),
        ...(has.onPark ? { onPark: () => handlers.onPark(message) } : {}),
        ...(has.onMemo && done ? { onMemo: () => handlers.onMemo(message) } : {}),
        ...(has.onTerm && done ? { onTerm: () => handlers.onTerm(message) } : {}),
        ...(has.onExtract && done ? { onExtract: () => handlers.onExtract(message) } : {}),
        ...(has.onSpinoff && done ? { onSpinoff: () => handlers.onSpinoff(message) } : {}),
        ...(has.onDiverge && done && !props.folded ? { onDiverge: () => handlers.onDiverge(message) } : {}),
        ...(has.onRegenerate && done && !props.folded ? { onRegenerate: () => handlers.onRegenerate(message) } : {}),
        // The lazy menu counts the reply's list and offers the item only for two or more.
        ...(has.onListToSeeds && done ? { onListToSeeds: () => handlers.onListToSeeds(message) } : {}),
        ...(done ? pinAndRelate(message, handlers, props.folded) : {}),
        ...(done && !props.folded ? { tag: tagMenuOf(message, props.tagRoot, handlers) } : {}),
      };
  const { actions, menu } = message.status !== "error" ? actionsOf({ text: message.content, who: label, ...writing }) : { actions: undefined, menu: undefined };
  const footer = (
    <>
      <ForkMarker
        branches={forks}
        {...(has.onEnterBranch ? { onSelect: handlers.onEnterBranch } : {})}
        {...(has.onToggleAside ? { onToggleAside: handlers.onToggleAside } : {})}
        inlineOpen={props.inlineAsides ?? NO_IDS}
      />
      <InlineAsides forks={forks} inline={props.inlineAsides} focusId={props.focusAsideId} readOnly={readOnly} handlers={handlers} terms={props.asideTerms} />
      {props.diverged && props.diverged.length > 0 && (
        <LazyDivergeMarker
          lineId={lineId}
          branches={props.diverged}
          onEnter={(target) => {
            const entered = props.diverged?.find((item) => item.lineId === target);
            if (entered && has.onEnterBranch) handlers.onEnterBranch(entered);
          }}
        />
      )}
      {showSuggestions && !readOnly && has.onSuggestion && (
        <BranchSuggestions suggestions={message.meta.suggestions ?? []} onOpen={(suggestion) => handlers.onSuggestion(message, suggestion)} />
      )}
      {props.extra}
    </>
  );
  return (
    <AssistantMessage
      message={message}
      label={label}
      highlighted={highlighted}
      {...(marks ? marks : {})}
      {...(!readOnly && retryable && has.onRetry ? { onRetry: () => handlers.onRetry(message) } : {})}
      actions={actions}
      menu={menu}
      footer={footer}
      tag={tagOf(message, props.tagRoot, label)}
    />
  );
});

/** Announces (politely, once) that a reply finished; the reply's text itself stays out of the live region. */
function useFinishedAnnouncement(messages: readonly Message[]): string {
  const t = useUiT();
  const pending = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
  useLayoutEffect(() => {
    const now = new Set(messages.filter((message) => message.status === "pending").map((message) => message.id));
    const finished = [...pending.current].filter((id) => !now.has(id) && messages.some((message) => message.id === id && message.status === "done"));
    pending.current = now;
    if (finished.length > 0) setAnnouncement((current) => ({ text: t("message.finished"), count: current.count + 1 }));
  }, [messages, t]);
  // A trailing zero-width space on every other announcement makes repeated text announce again.
  return announcement.text ? `${announcement.text}${announcement.count % 2 ? "" : "​"}` : "";
}

/**
 * A line's messages (A2): the operator's bubbles, replies (only pending ones
 * read the live stream), conclusion cards, move markers, fork markers and AI
 * suggestions. Writing actions disappear for read-only identities. Rows are
 * memoised and skip layout while off screen (`content-visibility: auto`).
 * It is a container for `@container/tg-messages` queries, so actions drop
 * their labels when narrow.
 */
export function MessageList(props: MessageListProps) {
  const { lineId, messages: all, branches = NO_FORKS, readOnly = false, showSuggestions = false, showLeaves = false, highlightedId, className } = props;
  const t = useUiT();
  const messages = useMemo(() => visibleMessages(all), [all]);
  const handlers = useStableHandlers(props);
  // Only a combined branch (origin merge) has children forked from messages it does not hold (B9.1).
  const combined = branches.some((branch) => branch.lineId === lineId && branch.origin === "merge");
  const forks = useMemo(() => forksByAnchor(branches, lineId, combined ? messages.map((message) => message.id) : undefined), [branches, lineId, messages, combined]);
  const positions = useMemo(() => chatPositions(messages), [messages]);
  // F8 decision #10: a user message with no fork point before it on this line cannot be edited into a branch.
  const firstOfLine = useMemo(() => {
    const first = new Set<string>();
    let seen = false;
    for (const message of messages) {
      if (message.role === "user" && !seen) first.add(message.id);
      if (canTag(message) && !isHostNotice(message)) seen = true;
    }
    return first;
  }, [messages]);
  const branchById = useMemo(() => new Map(branches.map((branch) => [branch.lineId, branch])), [branches]);
  const starts = useMemo(() => (props.chapters && props.chapters.length > 1 ? chaptersByStart(props.chapters) : null), [props.chapters]);
  const showGaps = props.timeGaps !== false;
  const gaps = useMemo(() => (showGaps ? timeGaps(messages) : null), [messages, showGaps]);
  const announcement = useFinishedAnnouncement(messages);
  // The turn's last message: a host's notice after a failed reply does not take retry away (B7.2; RetryTurn skips them too).
  const lastId = messages.findLast((message) => !isHostNotice(message))?.id;
  const spans = useMemo(() => (props.folds && props.folds.length > 0 ? foldSpans(messages, props.folds, lineId) : null), [messages, props.folds, lineId]);
  const tagRoot = props.tags?.rootLineId;
  // B17: follow-ups whose card was edited after they opened (前提已更新), from the outline alone (B17.1).
  const dismissedStale = useDismissedStale();
  const staleFollowUps = useMemo(() => {
    const ids = branches.filter((branch) => cardEditReasons(branch, branches, dismissedStale).length > 0).map((branch) => branch.lineId);
    return ids.length > 0 ? new Set(ids) : NO_IDS;
  }, [branches, dismissedStale]);
  const inlineAsides = props.inlineAsides ?? NO_IDS;
  // D3: with markers on, a reply's diverged directions leave the fork list for their own marker (memoised: rows stay memoised).
  const split = useMemo(() => splitDiverged(forks, props.showDiverge === true), [forks, props.showDiverge]);
  const divergedOf = (messageId: string) => split.diverged.get(messageId);
  const forksOf = (messageId: string) => split.forks.get(messageId) ?? NO_FORKS;
  // F19 §2.3: only a finished reply that uses a term gets something to mark it with; the rest keep their props.
  const termsOf = (message: Message): { terms?: MessageTerms } => {
    if (!props.terms || message.role !== "assistant" || message.kind !== "chat" || message.status !== "done") return {};
    const own = props.terms.forMessage(message.id, message.content);
    return own ? { terms: own } : {};
  };
  const row = (message: Message, folded = false) => (
    <MessageRow
      folded={folded}
      firstOfLine={firstOfLine.has(message.id)}
      diverged={divergedOf(message.id)}
      lineId={lineId}
      message={message}
      position={positions.get(message.id) ?? 0}
      forks={forksOf(message.id)}
      readOnly={readOnly}
      showSuggestions={showSuggestions}
      highlighted={message.id === highlightedId}
      retryable={message.id === lastId}
      handlers={handlers}
      tagRoot={tagRoot}
      {...(message.status === "pending" ? { stopping: props.stopping ?? false } : {})}
      {...(inlineAsides.size > 0 && forksOf(message.id).some((branch) => inlineAsides.has(branch.lineId)) ? { inlineAsides, focusAsideId: props.focusAsideId ?? null, asideTerms: props.asideTerms === true } : {})}
      {...termsOf(message)}
      {...(message.kind === "branch_card"
        ? { cardBranch: branchById.get(message.meta.branchLineId ?? ""), numbers: positions, showLeaf: showLeaves, stale: props.stale, staleIds: staleFollowUps }
        : {})}
      {...(props.replyExtras?.has(message.id) ? { extra: props.replyExtras.get(message.id) } : {})}
      {...(props.branchesLoaded && message.kind === "branch_marker" && message.meta.branchLineId && !branchById.has(message.meta.branchLineId) ? { markerOrphan: true } : {})}
    />
  );
  const rangeOf = (span: { messages: readonly Message[] }) => {
    const numbered = span.messages.map((message) => positions.get(message.id)).filter((n): n is number => n !== undefined);
    return numbered.length > 0 ? { from: numbered[0]!, to: numbered.at(-1)! } : null;
  };
  return (
    <>
      {/* Rows keep 12px of the 24px between them as top padding: a row clips what leaves it (content-visibility), and the hover toolbar sits there. */}
      <ol aria-label={t("message.list")} className={cx("@container/tg-messages m-0 flex list-none flex-col gap-3 p-0", className)}>
        {messages.map((message) => {
          const span = spans?.byFirst.get(message.id);
          // A fold's other messages live inside its block (D4).
          if (!span && spans?.covered.has(message.id)) return null;
          return (
            <li key={message.id} data-tg-row="" data-message-id={message.id} data-forkable={isForkable(message)} className="flex flex-col pt-3 [contain-intrinsic-size:auto_6rem] [content-visibility:auto]">
              {starts?.get(message.id) && <ChapterDivider chapter={starts.get(message.id)!} numbers={positions} onDelete={readOnly ? undefined : props.onDeleteMilestone} />}
              {!starts?.get(message.id) && gaps?.has(message.id) && <TimeGapDivider gapMs={gaps.get(message.id)!} at={message.createdAt} />}
              {props.unread?.messageId === message.id && <UnreadDivider count={props.unread.count} />}
              {span ? (
                <LazyFoldBlock key={span.fold.id} lineId={lineId} fold={span.fold} range={rangeOf(span)} forceOpen={props.expandMessageId ? span.messages.some((inside) => inside.id === props.expandMessageId) : false}>
                  <ol className="m-0 flex list-none flex-col gap-6 p-0">
                    {span.messages.map((inside) => (
                      <li key={inside.id} data-tg-row="" data-message-id={inside.id} data-forkable={isForkable(inside)} className="flex flex-col">
                        {row(inside, true)}
                      </li>
                    ))}
                  </ol>
                </LazyFoldBlock>
              ) : (
                row(message)
              )}
            </li>
          );
        })}
      </ol>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </>
  );
}
