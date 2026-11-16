import {
  classifyOpenBranchError,
  describeBranchError,
  driftByMessage,
  summarizeTopic,
  featureMode,
  firstUnreadId,
  hasErrorCode,
  isFeatureOn,
  isHostNotice,
  type BranchSuggestion,
  type BranchView,
  type Link,
  type Message,
  type MessageSelection,
} from "@tangent/client";
import {
  BranchResultBar,
  Button,
  ChapterStrip,
  Composer,
  describeError,
  IconButton,
  LazyRegion,
  MessageList,
  SelectionToolbar,
  SpinoffOrigin,
  Skeleton,
  StatusBanner,
  useArchiveLine,
  useBranchDetail,
  useBranches,
  useFolds,
  LazyMemoryRecall,
  useCancelTurn,
  useCapabilities,
  useChapters,
  useConversationBanner,
  useDeleteMilestone,
  useLine,
  useMarkRead,
  useMessages,
  usePinMessage,
  usePreview,
  useReadOnly,
  useReconnect,
  useRetryTurn,
  useSendMessage,
  useSuggestions,
  useSummaryDue,
  useCommand,
  useTangent,
  useUiT,
  useUpdateLine,
  useQuickAsk,
  LazyAskedBefore,
  useTermMarking,
  type AsideAction,
  type StatusBannerState,
} from "@tangent/react";
import { Archive, Lock, X } from "lucide-react";
import { lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useBranchCommands, useBranchHere } from "./branch-commands";
import type { BranchFlow, Navigate } from "./branch-flows";
import { useMessageFocus, type MessageFocus } from "./focus";
import { keepsAsides } from "./aside-default";
import { CHAT_WIDTH_CLASSES, prefsStore, usePrefs } from "./prefs";
import { useComposerHint } from "./prefs-apply";
import { composerSlot } from "./composer-slot";
import { EmptyGuide } from "./empty-guide";
import { LineModelNote, ModelPill } from "./model-pill";
import { useDebounced, useStickToBottom } from "./hooks";
import { useNoteActions } from "./note-actions";
import { useParkActions } from "./park-actions";

/** The summary-due offer loads only when a line is due (B8.2). */
const SummaryDue = lazy(() => import("./summary-due-host").then((module) => ({ default: module.SummaryDue })));
/** The drift hint (C4) loads only when a reply has one. */
const DriftHost = lazy(() => import("./drift-host").then((module) => ({ default: module.DriftHost })));
/** F10 §4.3: the ways on under an answered aside, loaded only for one. */
const AsideWrapUp = lazy(() => import("./aside-wrap-up").then((module) => ({ default: module.AsideWrapUp })));
/** The branch bar (and its fork peek and pack panel) loads the first time a branch is shown. */
const BranchHeader = lazy(() => import("./branch-header").then((module) => ({ default: module.BranchHeader })));
/** Wait this long after typing stops before estimating the turn (POST /preview). */
const ESTIMATE_DEBOUNCE_MS = 400;
/** How long the first message must rest before the memory search (D1). */
const RECALL_DEBOUNCE_MS = 600;
/** F19 §2.4: only a selection this short is looked up in the other conversations' glossaries (`TERM_LOOKUP_MAX_RUNES`). */
const ASKED_BEFORE_MAX_CHARS = 60;
/** G2 "stop and send": how often, and how far apart, the follow-up is tried again while the stopped turn is still closing. */
const FOLLOW_UP_RETRIES = 10;
const FOLLOW_UP_RETRY_MS = 150;
/** A new conversation is named after its first message's topic (F11 §2; the first reply's [TOPIC] may rename it), else its start. */
const TITLE_FROM_MESSAGE_CHARS = 40;

export interface ConversationViewProps {
  lineId: string;
  draft: string;
  onDraftChange: (value: string) => void;
  /** `?state=` forces an A14 banner (prototype parity); null follows the live state. */
  forcedBanner: StatusBannerState | null;
  /** A message to scroll to and highlight (fork links, card links). */
  focus: MessageFocus | null;
  onFlow: (flow: BranchFlow) => void;
  navigate: Navigate;
  onPreview: () => void;
  /** A short message in the frame's live region. */
  toast: (message: string) => void;
  /** Memos on (B13; F10: in normal mode too): 記成備忘 of the selection toolbar and a message's menu, 存成備忘 of the composer. Resolves true once written; never rejects. */
  onMemo?: (text: string) => Promise<boolean>;
  /** F10: put text in another line's composer (秒問解釋's question when its send failed). */
  onPrefill?: (lineId: string, text: string) => void;
  /** F8: a note above the composer about text put there (the Feynman check: 「已填進輸入框，還沒送出。…」); sending or ✕ clears it. */
  notice?: string | null;
  onDismissNotice?: () => void;
  /** F8 S3: the fold holding this message shows open while the in-tree search is open. */
  expandMessageId?: string | null;
  /** F8 S12: a 前提已更新 reason's 看紀要 (the side panel's notes). */
  onShowNotes?: () => void;
  /** F12 S1: the asides open in place under their messages (the frame keeps them, so its reply toast leaves them out). */
  inlineAsides?: ReadonlySet<string>;
  /** The aside just opened on purpose (its card takes focus). */
  focusAsideId?: string | null;
  onToggleAside?: (branch: BranchView, open?: boolean) => void;
  /** F19 §2.3: a known term in a reply was pressed: the frame shows it in the side panel's 名詞表. */
  onShowTerm?: (termId: string) => void;
}

function Bar({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-2 border-t border-tg-border bg-tg-surface-sunken px-4 py-3.5 text-tg-sm text-tg-muted">
      {icon}
      {children}
    </div>
  );
}

function Loading() {
  const t = useUiT();
  return (
    <div role="status" aria-label={t("ui.loading")} className="flex flex-col gap-4.5">
      <Skeleton className="h-4.5 w-[70%]" />
      <Skeleton className="h-16 w-[92%]" />
      <Skeleton className="h-4.5 w-[54%] self-end" />
      <Skeleton className="h-16 w-[84%]" />
    </div>
  );
}

interface BranchRequestExtra {
  excerpt?: string;
  suggestion?: BranchSuggestion & { messageId: string };
}

/**
 * The drift hints of this line's replies (C4): only on the main line, while
 * the goal suggests (or acts) and the inbox is on, and only read when the
 * tree has open suggestions. At most one per reply; never a popup.
 */
function useDriftExtras(rootId: string | null, isMain: boolean, openSuggestions: number, navigate: Navigate): ReadonlyMap<string, ReactNode> | null {
  const capabilities = useCapabilities();
  const mode = featureMode(capabilities.data, "goal");
  const on = isMain && (mode === "suggest" || mode === "auto") && isFeatureOn(capabilities.data, "suggestions");
  const suggestions = useSuggestions(rootId, on && openSuggestions > 0);
  const list = suggestions.data?.suggestions;
  return useMemo(() => {
    if (!on || !list || !rootId) return null;
    const hints = driftByMessage(list);
    if (hints.size === 0) return null;
    return new Map(
      [...hints].map(([messageId, suggestion]) => [
        messageId,
        <LazyRegion key={suggestion.id}>
          <DriftHost rootLineId={rootId} suggestion={suggestion} navigate={navigate} />
        </LazyRegion>,
      ]),
    );
  }, [on, list, rootId, navigate]);
}

/** A2 / A4: a main line or a branch on real data — banner, branch bar, messages (streaming), composer or the result. */
export function ConversationView({ lineId, draft, onDraftChange, forcedBanner, focus, onFlow, navigate, onPreview, toast, onMemo, onPrefill, notice, onDismissNotice, expandMessageId, onShowNotes, inlineAsides, focusAsideId, onToggleAside, onShowTerm }: ConversationViewProps) {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const line = useLine(lineId);
  const messages = useMessages(lineId);
  const rootId = line.data ? (line.data.conversationBranch?.rootLineId ?? line.data.id) : null;
  // G1: a branch runs with its main line's reasoning effort unless it sets its own.
  const rootLine = useLine(line.data?.conversationBranch ? rootId : null);
  // Asides included (F12 S1/S2: their fork rows and excerpt anchors open them in place); the same query the outline reads.
  const branches = useBranches(rootId, true);
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const liveBanner = useConversationBanner(lineId);
  const reconnect = useReconnect();
  const send = useSendMessage(lineId);
  const cancel = useCancelTurn(lineId);
  const retryTurn = useRetryTurn(lineId);
  const rename = useUpdateLine();
  const { mutate: markRead } = useMarkRead();
  const archive = useArchiveLine();
  const settled = useDebounced(draft.trim(), ESTIMATE_DEBOUNCE_MS);
  const estimate = usePreview(lineId, settled, settled !== "" && !readOnly);
  const { scroller, content, release } = useStickToBottom<HTMLDivElement, HTMLDivElement>(lineId);
  const highlighted = useMessageFocus(content, focus, messages.isSuccess, release);
  const chaptersOn = isFeatureOn(capabilities.data, "chapters");
  const chapters = useChapters(rootId, lineId, chaptersOn);
  const deleteMilestone = useDeleteMilestone(rootId ?? lineId, lineId);
  // F14 S4: the chapter strip once the line has chapters someone set (a milestone, e.g. an import's cuts) and two or more.
  const stripChapters = chaptersOn && chapters.data && chapters.data.chapters.length > 1 && chapters.data.chapters.some((chapter) => chapter.kind === "milestone") ? chapters.data.chapters : null;
  const scrollBox = useCallback(() => scroller.current, [scroller]);

  const list = messages.data?.messages ?? [];
  const streaming = list.some((message) => message.status === "pending");
  const archived = Boolean(line.data?.archivedAt);
  const unread = line.data?.unread ?? 0;
  // Feature modes (handoff 其他決定): AI suggestions show in suggest and auto (the same for branch_suggest, DESIGN §12);
  // manual has no AI proposals at all, only the user's own 開支線.
  const suggestMode = featureMode(capabilities.data, "branch_suggest");
  const showSuggestions = suggestMode === "suggest" || suggestMode === "auto";
  const branchInfo = line.data?.conversationBranch ?? null;
  // F11 §1: an aside is a one-turn leaf; nothing forks inside it (the server refuses), so no forking action is offered there.
  const isAside = branchInfo?.kind === "aside";
  // The outline leaves asides out, so an aside's own view comes from its detail.
  const detail = useBranchDetail(branchInfo && branchInfo.kind === "aside" ? lineId : null);
  const branchView = branches.data?.branches.find((item) => item.lineId === lineId) ?? detail.data?.branch ?? null;
  const mergedInto = branchView?.mergedIntoLineId ? (branches.data?.branches.find((item) => item.lineId === branchView.mergedIntoLineId) ?? null) : null;
  const ended = branchInfo !== null && branchInfo.status !== "open";
  // A still-loading line or branch view never falls through to the composer (or any other writing control):
  // a closed branch would otherwise flash one, and Esc from the outline could focus it just before it goes.
  const slot = composerSlot({ readOnly, permissionsLoaded: !capabilities.isPending, lineLoaded: line.data !== undefined, ended, branchLoaded: branchView !== null, archived });
  const writable = slot === "composer" || slot === "archived";

  useEffect(() => {
    if (unread > 0 && !readOnly) markRead(lineId);
  }, [lineId, unread, readOnly, markRead]);
  // A branch's unread count when it was entered: its divider stays for the visit, after the line is marked read.
  const [unreadAtEntry, setUnreadAtEntry] = useState<number | null>(null);
  if (unreadAtEntry === null && line.data) setUnreadAtEntry(line.data.unread);
  const unreadFrom = branchInfo && unreadAtEntry ? firstUnreadId(list, unreadAtEntry) : null;

  // G2 (Settings → Chat): the column's width, and whether a draft sent while a reply streams stops that reply first.
  const prefs = usePrefs();
  const chatWidth = CHAT_WIDTH_CLASSES[prefs.chatWidth];
  const composerHint = useComposerHint();
  const stopAndSend = prefs.followUp === "stop_and_send";
  /** Stops the running reply, then sends; the server may need a moment to close the stopped turn (`turn_pending`). */
  const sendAfterStop = async (text: string) => {
    await cancel.mutateAsync();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send.mutateAsync(text);
      } catch (error) {
        if (attempt >= FOLLOW_UP_RETRIES || !hasErrorCode(error, "turn_pending")) throw error;
        await new Promise((resolve) => setTimeout(resolve, FOLLOW_UP_RETRY_MS));
      }
    }
  };
  const sendMessage = async (text: string) => {
    if (streaming && stopAndSend) await sendAfterStop(text);
    else await send.mutateAsync(text);
    onDismissNotice?.();
    if (line.data && !line.data.title) rename.mutate({ lineId, input: { title: summarizeTopic(text) || Array.from(text.trim()).slice(0, TITLE_FROM_MESSAGE_CHARS).join("") } });
  };
  // 開支線 (⌘B) forks from the last chat message; a host's notice after it is not one (B7.2).
  const lastId = list.filter((message) => message.kind === "chat" && !isHostNotice(message)).at(-1)?.id;
  const openBranch = (anchorMessageId: string | undefined, { excerpt, suggestion }: BranchRequestExtra = {}) => {
    if (!anchorMessageId) return;
    const accepted = suggestion ? { suggestion: { messageId: suggestion.messageId, purpose: suggestion.purpose, kind: suggestion.kind } } : {};
    onFlow({ kind: "open", lineId, request: { anchorMessageId, ...(excerpt ? { excerpt } : {}), ...accepted } });
  };
  const branchHere = useBranchHere(content, lastId, openBranch, toast);
  // F10 ⚡ 秒問解釋: an aside asked at once; a deeper branch to confirm opens the dialog instead, other refusals are said.
  // F18 §2.2: a conversation set to 保留 keeps what 秒問解釋 asks from the start (read when asked).
  const quickAsk = useQuickAsk(lineId, { keepAside: () => prefsStore.get().asideDefault === "keep" || keepsAsides(rootId) });
  const onQuickAsk = (selection: MessageSelection) =>
    void quickAsk.ask(selection).then((outcome) => {
      // F12 S1: an aside answers in place under the message; the main line's reading place stays.
      if ("created" in outcome) return outcome.created.branch.kind === "aside" && onToggleAside ? onToggleAside(outcome.created.branch, true) : navigate(outcome.created.line.id);
      const { failure } = outcome;
      if (failure.stage === "send") {
        navigate(failure.created.line.id);
        onPrefill?.(failure.created.line.id, outcome.question);
        return toast(t("branch.sendFailed", { reason: describeError(failure.error, t, hostErrorText) }));
      }
      if (classifyOpenBranchError(failure.error).kind === "depth") return openBranch(selection.messageId, { excerpt: selection.text });
      toast(t("selection.quickAskFailed", { reason: describeBranchError(failure.error, t, hostErrorText).message }));
    });
  // ⌘B opens nothing inside an aside (bringing back is never offered for one either).
  useBranchCommands({ line: line.data ?? null, readOnly: !writable || isAside, onBranch: branchHere, navigate, onFlow });
  const lastReply = list.filter((message) => message.role === "assistant" && message.kind === "chat" && message.status === "done").at(-1);
  const notes = useNoteActions(lineId, writable && isFeatureOn(capabilities.data, "notes"), content, lastReply, toast);
  // 停車 (B3): the composer's button and ⌘⇧S, a message's action, the selection toolbar; all gone while parking is off.
  const park = useParkActions(lineId, slot === "composer" && isFeatureOn(capabilities.data, "parking"), draft, onDraftChange, toast);
  const showLeaves = isFeatureOn(capabilities.data, "leaf");
  const summaryDue = useSummaryDue(lineId);
  // 從這裡開新對話 (B2): a reply's action while spinoff is on and the line can be written.
  const spinoffOn = writable && isFeatureOn(capabilities.data, "spinoff");
  const pin = usePinMessage();
  const drift = useDriftExtras(rootId, branchInfo === null, line.data?.openSuggestions ?? 0, navigate);
  // 釘選 (B9, core): one mutation for every message, each press awaiting its own result (R7).
  const onPin = (message: Message, pinned: boolean) =>
    void pin.mutateAsync({ messageId: message.id, pinned }).catch((error: unknown) => toast(t("pin.failed", { reason: describeError(error, t, hostErrorText) })));
  // 關聯… (C3): relations on and the line writable.
  const relateOn = writable && isFeatureOn(capabilities.data, "relations");
  // D2: argument tags on every finished chat message while ibis is on; D4: the line's folds while fold is on.
  const tagsOn = isFeatureOn(capabilities.data, "ibis") && rootId !== null;
  const foldOn = isFeatureOn(capabilities.data, "fold");
  const folds = useFolds(lineId, foldOn);
  // D3: a reply's diverged directions as one marker; 給我幾個方向… on finished replies while the line can be written.
  const divergeOn = isFeatureOn(capabilities.data, "diverge");
  // F8 S12: conclusion cards say 前提已更新 while notes or relations can change their premise (memoised: card rows stay memoised).
  const staleOn = isFeatureOn(capabilities.data, "notes") || isFeatureOn(capabilities.data, "relations");
  const stale = useMemo(
    () => (staleOn && rootId ? { rootLineId: rootId, ...(onShowNotes ? { onGoToNote: () => onShowNotes() } : {}), onGoToRelation: (relation: Link) => navigate(relation.fromLineId, relation.fromMessageId || undefined) } : undefined),
    [staleOn, rootId, onShowNotes, navigate],
  );
  // F8 S8: the palette's 跨模型平行比較… diverges from the last finished reply.
  useCommand("diverge.models", () => lastReply && onFlow({ kind: "diverge", lineId, messageId: lastReply.id, mode: "models" }), divergeOn && writable && lastReply !== undefined);
  // D1: only a new conversation (a main line with no message yet) recalls, from the first message as typed.
  const recallOn = isFeatureOn(capabilities.data, "memory") && line.data?.conversationBranch === null && list.every((message) => message.kind !== "chat" || isHostNotice(message));
  const recallQuery = useDebounced(recallOn ? draft.trim() : "", RECALL_DEBOUNCE_MS);
  // F19: the tree's glossary. Its terms are underlined in finished replies (nothing is asked while the feature is off,
  // nothing loaded while the tree has none); 存進名詞表 wherever the line takes a turn.
  const glossaryOn = isFeatureOn(capabilities.data, "glossary");
  const termMarking = useTermMarking(rootId, glossaryOn, (termId) => onShowTerm?.(termId));
  const canSaveTerm = glossaryOn && slot === "composer";
  const asideFlow = (branch: BranchView, action: AsideAction): BranchFlow => ({ kind: action === "continue" ? "continueAside" : action === "term" ? "saveTerm" : "deleteBranch", lineId: branch.lineId });

  const composerError = send.error
    ? t("composer.sendFailed", { reason: describeError(send.error, t, hostErrorText) })
    : (cancel.error ?? retryTurn.error)
      ? describeError(cancel.error ?? retryTurn.error, t, hostErrorText)
      : null;

  return (
    <section aria-label={t("shell.conversation")} data-tg-focus-region="chat" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <StatusBanner state={forcedBanner ?? liveBanner} {...(!forcedBanner && liveBanner?.kind === "reconnecting" ? { onAction: reconnect } : {})} />
      {line.data?.spunOffFrom && <SpinoffOrigin origin={line.data.spunOffFrom} onGo={(target, messageId) => navigate(target, messageId)} />}
      {line.data && branchInfo && branchView && (
        // Holds the branch bar's height while its code loads, so the messages do not jump down.
        <LazyRegion fallback={<div aria-hidden className="min-h-22 shrink-0 border-b border-tg-border bg-tg-primary-soft" />} className="border-b border-tg-border">
          <BranchHeader branch={branchView} readOnly={readOnly} navigate={navigate} onFlow={onFlow} toast={toast} />
        </LazyRegion>
      )}
      {stripChapters && messages.isSuccess && <ChapterStrip chapters={stripChapters} scroller={scrollBox} />}
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-8">
        <div ref={content} data-tg-chat-width={prefs.chatWidth} className={`mx-auto flex ${chatWidth} flex-col gap-5`}>
          {messages.isPending && <Loading />}
          {messages.isError && (
            <div role="alert" className="flex flex-col items-start gap-2 text-tg-sm text-tg-muted">
              {t("message.loadFailed")}
              <Button size="sm" onClick={() => void messages.refetch()}>
                {t("message.reload")}
              </Button>
            </div>
          )}
          {messages.isSuccess && list.length === 0 && <p className="m-0 text-tg-sm text-tg-muted">{t("message.empty")}</p>}
          {messages.isSuccess && list.length === 0 && writable && branchInfo === null && <EmptyGuide modelNote={line.data ? <LineModelNote line={line.data} /> : null} />}
          {messages.isSuccess && (
            <MessageList
              lineId={lineId}
              messages={list}
              branches={branches.data?.branches ?? []}
              branchesLoaded={branches.isSuccess}
              readOnly={!writable}
              showSuggestions={showSuggestions && !isAside}
              showLeaves={showLeaves}
              highlightedId={highlighted}
              {...(chaptersOn && chapters.data ? { chapters: chapters.data.chapters, onDeleteMilestone: (id: string) => deleteMilestone.mutate(id) } : {})}
              {...(isAside ? {} : { onBranch: (message: Message) => openBranch(message.id) })}
              {...(notes ? { onNote: notes.onNoteMessage } : {})}
              {...(park ? { onPark: park.onParkMessage } : {})}
              {...(onMemo && !archived ? { onMemo: (message: Message) => void onMemo(message.content) } : {})}
              {...(spinoffOn && !isAside ? { onSpinoff: (message: Message) => onFlow({ kind: "spinoff", lineId, atMessageId: message.id }) } : {})}
              {...(writable ? { onPin } : {})}
              {...(relateOn ? { onRelate: (message: Message) => onFlow({ kind: "relation", lineId, messageId: message.id }) } : {})}
              {...(drift ? { replyExtras: drift } : {})}
              {...(tagsOn && rootId ? { tags: { rootLineId: rootId } } : {})}
              {...(foldOn && folds.data ? { folds: folds.data.folds } : {})}
              {...(foldOn && writable ? { onFold: (message: Message) => onFlow({ kind: "fold", lineId, messageId: message.id }) } : {})}
              {...(divergeOn ? { showDiverge: true } : {})}
              {...(divergeOn && writable && !isAside ? { onDiverge: (message: Message) => onFlow({ kind: "diverge", lineId, messageId: message.id }) } : {})}
              {...(writable && !isAside
                ? {
                    onEditBranch: (message: Message) => onFlow({ kind: "editBranch", lineId, messageId: message.id }),
                    onAskAgain: (message: Message) => onFlow({ kind: "askAgain", lineId, messageId: message.id }),
                    onRegenerate: (message: Message) => onFlow({ kind: "regenerate", lineId, messageId: message.id }),
                  }
                : {})}
              {...(writable ? { onTagFailed: toast } : {})}
              {...(park ? { onListToSeeds: (message: Message) => onFlow({ kind: "seedsBatch", lineId, messageId: message.id }) } : {})}
              {...(expandMessageId ? { expandMessageId } : {})}
              {...(stale ? { stale } : {})}
              unread={unreadFrom && unreadAtEntry ? { messageId: unreadFrom, count: unreadAtEntry } : null}
              onRetry={() => retryTurn.mutate()}
              {...(isAside ? {} : { onSuggestion: (message: Message, suggestion: BranchSuggestion) => openBranch(message.id, { suggestion: { ...suggestion, messageId: message.id } }) })}
              onEnterBranch={(branch) => navigate(branch.lineId)}
              {...(onToggleAside ? { onToggleAside: (branch: BranchView) => onToggleAside(branch), inlineAsides: inlineAsides ?? new Set<string>(), focusAsideId: focusAsideId ?? null } : {})}
              // F18: an answered aside opened in place: 接著問 becomes a branch, 丟掉 goes to the frame's delete host (with its undo).
              // An archived conversation takes none of the three (the server refuses), so its cards do not offer them.
              {...(writable && !archived ? { onAsideAction: (branch: BranchView, action: AsideAction) => onFlow(asideFlow(branch, action)), asideTerms: glossaryOn } : {})}
              {...(termMarking ? { terms: termMarking } : {})}
              {...(canSaveTerm ? { onTerm: (message: Message) => onFlow({ kind: "saveTerm", lineId, messageId: message.id }) } : {})}
              {...(writable ? { onStop: () => cancel.mutate(), stopping: cancel.isPending } : {})}
              {...(writable && !isAside
                ? {
                    onEditCard: (_message: Message, branch: BranchView) => onFlow({ kind: "cardEdit", lineId: branch.lineId }),
                    onFollowUpCard: (message: Message, branch: BranchView) =>
                      onFlow({
                        kind: "open",
                        lineId,
                        request: { anchorMessageId: message.id, fromCard: { title: branch.purpose, conclusion: message.meta.card?.conclusion || message.content, openItems: message.meta.card?.openItems ?? [] } },
                      }),
                  }
                : {})}
              {...(isAside ? {} : { onExtract: (message: Message) => onFlow({ kind: "extract", lineId, messageId: message.id }) })}
              onOpenBranch={(branchLineId, messageId) => navigate(branchLineId, messageId)}
              onGoToMessage={(messageId) => navigate(lineId, messageId)}
            />
          )}
          {slot === "result" && branchView?.kind === "aside" && !archived && (
            <LazyRegion>
              <AsideWrapUp branch={branchView} messages={list} navigate={navigate} onFlow={onFlow} toast={toast} canSaveTerm={glossaryOn} />
            </LazyRegion>
          )}
        </div>
      </div>
      {writable && (
        <SelectionToolbar
          containerRef={content}
          {...(isAside ? {} : { onBranch: (selection: MessageSelection) => openBranch(selection.messageId, { excerpt: selection.text }) })}
          {...(quickAsk.pending || archived || isAside ? {} : { onQuickAsk })}
          {...(notes ? { onNote: notes.onNoteSelection } : {})}
          {...(park ? { onPark: park.onParkSelection } : {})}
          {...(onMemo && !archived ? { onMemo: (selection: MessageSelection) => onMemo(selection.text) } : {})}
          {...(canSaveTerm ? { onTerm: (selection: MessageSelection) => onFlow({ kind: "saveTerm", lineId, messageId: selection.messageId, selection: selection.text }) } : {})}
          // F19 §2.4: 「之前問過」 for a short selection; it loads, asks and shows on its own, and never holds 秒問解釋 back.
          {...(glossaryOn && rootId
            ? {
                hint: (selection: MessageSelection, close: () => void) =>
                  Array.from(selection.text.trim()).length <= ASKED_BEFORE_MAX_CHARS ? (
                    <LazyAskedBefore
                      text={selection.text}
                      rootLineId={rootId}
                      onOpen={(hit) => {
                        close();
                        onFlow({ kind: "askedBefore", lineId, hit, messageId: selection.messageId });
                      }}
                    />
                  ) : null,
              }
            : {})}
        />
      )}
      {slot === "readOnly" && <Bar icon={<Lock aria-hidden className="size-3.5" />}>{t("shell.readonlyBar")}</Bar>}
      {slot === "result" && branchView && (
        <BranchResultBar
          branch={branchView}
          archived={archived}
          onShowCard={() => navigate(branchView.parentLineId, branchView.cardMessageId)}
          // Combined into another branch (C2): 已合併到「…」, and the way there.
          {...(mergedInto ? { mergedIntoTitle: mergedInto.purpose, onShowMerged: () => navigate(mergedInto.lineId) } : {})}
          // F18: the branch it was combined into is no longer in the (loaded) outline: said, with no way there.
          mergedIntoGone={branches.isSuccess && mergedInto === null}
        />
      )}
      {slot === "archived" && (
        <Bar icon={<Archive aria-hidden className="size-3.5" />}>
          {t("shell.archivedBar")}
          <Button size="sm" loading={archive.isPending} onClick={() => archive.mutate({ lineId, archived: false })}>
            {t("shell.unarchive", { title: line.data?.title || t("shell.untitled") })}
          </Button>
        </Bar>
      )}
      {slot === "composer" && (
        <div className="px-4 pb-4 sm:px-8">
          {/* D1: a new conversation's first message finds what was concluded before; never a popup, nothing comes in unasked. */}
          {recallOn && (
            <LazyMemoryRecall query={recallQuery} onUse={(block) => onDraftChange(draft.trim() ? `${block}\n\n${draft}` : `${block}\n\n`)} className={`mx-auto mb-2 ${chatWidth}`} />
          )}
          {/* B8.2: summary.due (summary in suggest mode) offers 整理摘要 above the composer; never a popup. */}
          {summaryDue && (
            <LazyRegion>
              <SummaryDue lineId={lineId} />
            </LazyRegion>
          )}
          {notice && (
            <p role="status" className={`mx-auto mb-2 flex ${chatWidth} items-start gap-2 rounded-tg-sm bg-tg-primary-soft px-3 py-2 text-tg-xs text-tg-foreground`}>
              <span className="min-w-0 flex-1">{notice}</span>
              {onDismissNotice && <IconButton label={t("ui.close")} icon={<X />} size="sm" tooltip={false} className="-my-1.5" onClick={onDismissNotice} />}
            </p>
          )}
          <Composer
            className={`mx-auto ${chatWidth}`}
            {...(composerHint ? { hint: composerHint } : {})}
            sendWhileStreaming={stopAndSend}
            value={draft}
            onValueChange={onDraftChange}
            onSend={sendMessage}
            streaming={streaming}
            onStop={() => cancel.mutate()}
            {...(isAside ? {} : { onBranch: branchHere })}
            {...(park ? { onPark: park.onParkComposer } : {})}
            {...(onMemo ? { onMemo } : {})}
            onPreview={onPreview}
            estimate={estimate.data && settled === draft.trim() ? { tokens: estimate.data.totalTokens, costUsd: estimate.data.estimatedCostUsd } : null}
            {...(branchInfo ? { placeholder: t("branch.composerPlaceholder") } : {})}
            {...(line.data ? { modelControl: <ModelPill line={line.data} rootLine={rootLine.data ?? null} onError={toast} /> } : {})}
            error={composerError}
          />
        </div>
      )}
    </section>
  );
}
