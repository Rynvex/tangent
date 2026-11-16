import { chatMessages, isFeatureOn, type BranchView, type LineView, type Message, type TermSearchHit } from "@tangent/client";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { keepsAsides } from "./aside-default";
import { focusComposerSoon } from "./composer-focus";
import { useF12ShellT } from "./f12-shell-messages";
import type { ToastAction } from "./hooks";
import {
  AsideNoteDialog,
  BranchCardEditDialog,
  describeError,
  EditBranchDialog,
  RegenerateDialog,
  SeedsBatchDialog,
  useCapabilities,
  useCreateLine,
  useF8T,
  BranchCardReview,
  DiscardBranchDialog,
  DivergeDialog,
  FoldDialog,
  MoveBranchDialog,
  OpenBranchDialog,
  PromoteBranchDialog,
  RelationDialog,
  SpinoffDialog,
  useBranchDetail,
  useBranches,
  useLine,
  useLineNames,
  useMessages,
  useUiT,
  type BranchModelOption,
  type DivergeMode,
  type OpenBranchRequest,
} from "@tangent/react";

/** F13 S3: the extract dialog is a chunk of its own, loaded on first use. */
const ExtractFlow = lazy(() => import("./extract-flow"));
/** F18: 接著問 (and its refusal's dialog), loaded the first time an aside is continued. */
const ContinueAsideFlow = lazy(() => import("./continue-aside-flow"));
/** F19: 存進名詞表 and 「之前問過」, loaded the first time one is asked for. */
const GlossaryFlow = lazy(() => import("./glossary-flow"));

/** Which branch dialog is open, and for which line. */
export type BranchFlow =
  /** `prefill` (F8 S10, the Feynman check): put in the new branch's composer, not sent, with a note above it. */
  | { kind: "open"; lineId: string; request: OpenBranchRequest; prefill?: { text: string; notice: string } }
  | { kind: "review"; lineId: string }
  | { kind: "discard"; lineId: string }
  | { kind: "promote"; lineId: string; suggestionId?: string }
  /** 獨立成新對話 (B2): from the branch bar (`atMessageId` = its last message), a message, or a tree-balance suggestion. */
  | { kind: "spinoff"; lineId: string; atMessageId: string; suggestionId?: string }
  | { kind: "move"; lineId: string; startMessageId: string }
  | { kind: "asideNote"; lineId: string }
  /** 關聯… (C3): relate this line, or one of its messages, to another place. */
  | { kind: "relation"; lineId: string; messageId?: string }
  /** 從這則起折疊… (D4): fold a run of the line's messages from this one. */
  | { kind: "fold"; lineId: string; messageId: string }
  /** 給我幾個方向… (D3): diverge from this reply; F8 S8 adds 跨模型平行比較 (`mode`). */
  | { kind: "diverge"; lineId: string; messageId: string; mode?: DivergeMode }
  /** F8 S6: 修改並分岔 a user message. */
  | { kind: "editBranch"; lineId: string; messageId: string }
  /** F8 S7: 分岔重答（可換模型） a reply. */
  | { kind: "regenerate"; lineId: string; messageId: string }
  /** F8 S11: park a reply's list items. */
  | { kind: "seedsBatch"; lineId: string; messageId: string }
  /** F8 decision #10: 改問，開成新對話… from the line's first message (spinoff when on, else a new conversation), its text in the composer. */
  | { kind: "askAgain"; lineId: string; messageId: string }
  /** F12 S6 編輯結論: a merged branch's conclusion card (`lineId` is the branch). */
  | { kind: "cardEdit"; lineId: string }
  /** F13 S3 從這則抽成支線…: a stretch of `lineId` from `messageId` (a reply's from its question). */
  | { kind: "extract"; lineId: string; messageId: string }
  /** F18 接著問: the answered aside `lineId` becomes an open branch at the same place; the frame goes there. */
  | { kind: "continueAside"; lineId: string }
  /**
   * F18 刪除支線 / 丟掉: an ended aside or a discarded branch (`lineId`), with what is under it. Never reaches
   * `BranchFlows`: the frame hands it to its delete host, which outlives the flow (a delete waits for its undo).
   */
  | { kind: "deleteBranch"; lineId: string }
  /**
   * F19 存進名詞表, saved from `lineId`: an answered aside's own action (nothing else given), a message's menu
   * (`messageId`) or the selection toolbar (`selection` in `messageId`).
   */
  | { kind: "saveTerm"; lineId: string; messageId?: string; selection?: string }
  /** F19 §2.4 「之前問過」: what another conversation's glossary says about the selected words, and copying it here. */
  | { kind: "askedBefore"; lineId: string; hit: TermSearchHit; messageId?: string };

/** The frame's toast, with one optional action (F8). */
export type Toast = (message: string, action?: ToastAction) => void;

/** Switch to a line; highlight one of its messages when given. */
export type Navigate = (lineId: string, messageId?: string) => void;

export interface BranchFlowsProps {
  flow: BranchFlow | null;
  onChange: (flow: BranchFlow | null) => void;
  navigate: Navigate;
  toast: Toast;
  /** Mock mode offers a cheaper model next to the parent's (the API does not list allowed models yet). */
  modelOptions?: readonly BranchModelOption[];
  /** F8: put text in a line's composer (not sent), with a note above it when given. */
  onPrefill?: (lineId: string, text: string, notice?: string) => void;
  /** F8 S11: 看停車場 after parking a list. */
  onShowParking?: () => void;
  /** F13 S3: the messages the extract dialog would move ([] when it closes); the frame outlines them. */
  onHighlight?: (messageIds: readonly string[]) => void;
  /** F19: 查看 after a term was saved: the side panel's 名詞表, open at that term. */
  onShowGlossary?: (termId: string) => void;
}

const rootOf = (line: LineView | undefined) => (line ? (line.conversationBranch?.rootLineId ?? line.id) : null);

function OpenFlow({ flow, close, navigate, toast, modelOptions, onPrefill }: { flow: Extract<BranchFlow, { kind: "open" }>; close: () => void; navigate: Navigate; toast: Toast; modelOptions?: readonly BranchModelOption[] | undefined; onPrefill: BranchFlowsProps["onPrefill"] }) {
  const t = useUiT();
  const line = useLine(flow.lineId);
  const messages = useMessages(flow.lineId);
  const branches = useBranches(rootOf(line.data));
  if (!line.data || !messages.data) return null;
  // The Feynman check's prompt is the dialog's first question: sent with 開啟支線並送出問題, else waiting in the composer.
  // F18 §2.2: a conversation set to 保留 keeps the asides opened here from the start.
  const request = { ...flow.request, ...(flow.prefill ? { question: flow.prefill.text } : {}), ...(keepsAsides(rootOf(line.data)) ? { keepAside: true } : {}) };
  return (
    <OpenBranchDialog
      open
      onOpenChange={(open) => !open && close()}
      line={line.data}
      messages={messages.data.messages}
      branches={branches.data?.branches ?? []}
      request={request}
      {...(modelOptions ? { modelOptions } : {})}
      onCreated={(result, outcome) => {
        navigate(result.line.id);
        if (outcome.sent || !outcome.question) return;
        // 只開支線，稍後再問 (or a send that failed): the question waits in the new branch's composer.
        if (outcome.sendError !== undefined) toast(t("branch.sendFailed", { reason: describeError(outcome.sendError, t) }));
        onPrefill?.(result.line.id, outcome.question, outcome.sendError === undefined ? flow.prefill?.notice : undefined);
        focusComposerSoon();
      }}
    />
  );
}

/** The dialogs that need the branch itself (discard, promote, keep an aside's answer). */
function BranchFlowDialogs({ flow, branch, close, navigate, toast, openFlow }: { flow: BranchFlow; branch: BranchView; close: () => void; navigate: Navigate; toast: (message: string) => void; openFlow: (flow: BranchFlow) => void }) {
  const t = useUiT();
  const shell = useF12ShellT();
  const main = useMessages(flow.kind === "promote" ? branch.rootLineId : null);
  const outline = useBranches(flow.kind === "promote" ? branch.rootLineId : null);
  const aside = useMessages(flow.kind === "asideNote" ? branch.lineId : null);
  const parent = useMessages(flow.kind === "cardEdit" ? branch.parentLineId : null);
  const onOpenChange = (open: boolean) => !open && close();
  switch (flow.kind) {
    case "discard":
      return <DiscardBranchDialog open onOpenChange={onOpenChange} branch={branch} onDiscarded={() => undefined} />;
    case "promote":
      if (!main.data || !outline.data) return null;
      return (
        <PromoteBranchDialog
          open
          onOpenChange={onOpenChange}
          branch={branch}
          mainMessages={main.data.messages}
          branches={outline.data.branches}
          {...(flow.suggestionId ? { suggestionId: flow.suggestionId } : {})}
          onPromoted={(result) => navigate(result.line.id)}
          onOpenBranch={(lineId) => {
            close();
            navigate(lineId);
          }}
        />
      );
    case "cardEdit": {
      const card = parent.data?.messages.find((message) => message.id === branch.cardMessageId);
      if (!card) return null;
      return <BranchCardEditDialog open onOpenChange={onOpenChange} branch={branch} message={card} onSaved={() => toast(shell("card.edited"))} />;
    }
    case "asideNote":
      if (!aside.data) return null;
      return <AsideNoteDialog open onOpenChange={onOpenChange} branch={branch} messages={aside.data.messages} onSaved={() => toast(t("asideNote.saved"))} />;
    case "review":
      return (
        <BranchCardReview
          open
          onOpenChange={onOpenChange}
          lineId={branch.lineId}
          onMerged={(result) => {
            close();
            navigate(result.message.lineId, result.message.id);
          }}
          onDiscard={() => openFlow({ kind: "discard", lineId: branch.lineId })}
        />
      );
    default:
      return null;
  }
}

function SpinoffFlow({ flow, close, navigate }: { flow: Extract<BranchFlow, { kind: "spinoff" }>; close: () => void; navigate: Navigate }) {
  const line = useLine(flow.lineId);
  const messages = useMessages(flow.lineId);
  if (!line.data || !messages.data) return null;
  return (
    <SpinoffDialog
      open
      onOpenChange={(open) => !open && close()}
      line={line.data}
      messages={messages.data.messages}
      atMessageId={flow.atMessageId}
      {...(flow.suggestionId ? { suggestionId: flow.suggestionId } : {})}
      onDone={(result) => navigate(result.line.id)}
    />
  );
}

function MoveFlow({ flow, close, navigate }: { flow: Extract<BranchFlow, { kind: "move" }>; close: () => void; navigate: Navigate }) {
  const line = useLine(flow.lineId);
  const messages = useMessages(flow.lineId);
  if (!line.data || !messages.data) return null;
  return (
    <MoveBranchDialog
      open
      onOpenChange={(open) => !open && close()}
      line={line.data}
      messages={messages.data.messages}
      startMessageId={flow.startMessageId}
      onMoved={(result) => navigate(result.sourceLineId, result.marker.id)}
    />
  );
}

/** The relation dialog from a message's 關聯…: the start is named as the line shows it (「主線・#n」). */
function RelationFlow({ flow, close }: { flow: Extract<BranchFlow, { kind: "relation" }>; close: () => void }) {
  const line = useLine(flow.lineId);
  const messages = useMessages(flow.messageId ? flow.lineId : null);
  const root = rootOf(line.data);
  const { name } = useLineNames(root ?? flow.lineId);
  if (!line.data || !root || (flow.messageId && !messages.data)) return null;
  const n = flow.messageId ? chatMessages(messages.data?.messages ?? []).findIndex((message) => message.id === flow.messageId) + 1 : 0;
  const label = n > 0 ? `${name(flow.lineId)} #${n}` : name(flow.lineId);
  return <RelationDialog open onOpenChange={(open) => !open && close()} rootLineId={root} from={{ lineId: flow.lineId, ...(flow.messageId ? { messageId: flow.messageId } : {}), label }} />;
}

/** 折疊成摘要 from a message's action (D4): the dialog numbers the line's messages as the transcript does. */
function FoldFlow({ flow, close }: { flow: Extract<BranchFlow, { kind: "fold" }>; close: () => void }) {
  const messages = useMessages(flow.lineId);
  const list = messages.data?.messages;
  const start = list?.find((message) => message.id === flow.messageId);
  if (!list || !start) return null;
  const numbers = new Map(chatMessages(list).map((message, index) => [message.id, index + 1]));
  return <FoldDialog open onOpenChange={(open) => !open && close()} lineId={flow.lineId} start={start} messages={list} numbers={numbers} />;
}

/** 給我幾個方向 from a reply's action (D3): the directions open under it. */
function DivergeFlow({ flow, close }: { flow: Extract<BranchFlow, { kind: "diverge" }>; close: () => void }) {
  const line = useLine(flow.lineId);
  const messages = useMessages(flow.lineId);
  const root = rootOf(line.data);
  const anchor = messages.data?.messages.find((message) => message.id === flow.messageId);
  if (!root || !anchor) return null;
  return <DivergeDialog open onOpenChange={(open) => !open && close()} lineId={flow.lineId} rootLineId={root} anchor={anchor} messages={messages.data?.messages ?? []} {...(flow.mode ? { initialMode: flow.mode } : {})} />;
}

/** F8 S6 / S7: 修改並分岔 and 分岔重答 open a branch, send there and go there; a failed send is said, the branch stays. */
function RewriteFlow({ flow, close, navigate, toast, onAskAgain }: { flow: Extract<BranchFlow, { kind: "editBranch" | "regenerate" }>; close: () => void; navigate: Navigate; toast: (message: string) => void; onAskAgain: (message: Message) => void }) {
  const line = useLine(flow.lineId);
  const messages = useMessages(flow.lineId);
  if (!line.data || !messages.data) return null;
  const onDone = (lineId: string, sendError?: string) => {
    navigate(lineId);
    if (sendError) toast(sendError);
  };
  const common = { open: true, onOpenChange: (open: boolean) => !open && close(), line: line.data, messages: messages.data.messages, onDone };
  return flow.kind === "editBranch" ? <EditBranchDialog {...common} messageId={flow.messageId} /> : <RegenerateDialog {...common} replyId={flow.messageId} onAskAgain={onAskAgain} />;
}

/** F8 S11: the reply's list into the parking lot. */
function SeedsFlow({ flow, close, toast, onShowParking }: { flow: Extract<BranchFlow, { kind: "seedsBatch" }>; close: () => void; toast: Toast; onShowParking: (() => void) | undefined }) {
  const t = useF8T();
  const line = useLine(flow.lineId);
  const messages = useMessages(flow.lineId);
  const root = rootOf(line.data);
  const message = messages.data?.messages.find((item) => item.id === flow.messageId);
  if (!root || !message) return null;
  return (
    <SeedsBatchDialog
      open
      onOpenChange={(open) => !open && close()}
      rootLineId={root}
      lineId={flow.lineId}
      message={message}
      onDone={(count) => toast(t("seeds.saved", { n: count }), onShowParking ? { label: t("seeds.showParking"), run: onShowParking } : undefined)}
    />
  );
}

/**
 * F8 decision #10: the first message cannot be edited into a branch; ask it
 * again in a new conversation instead — a fresh spinoff from it while
 * spinoff is on (the link back stays), otherwise a plain new conversation —
 * with the original text in the composer to change before sending.
 */
function AskAgainFlow({ flow, close, navigate, onPrefill, toast }: { flow: Extract<BranchFlow, { kind: "askAgain" }>; close: () => void; navigate: Navigate; onPrefill: BranchFlowsProps["onPrefill"]; toast: Toast }) {
  const t = useUiT();
  const capabilities = useCapabilities();
  const line = useLine(flow.lineId);
  const messages = useMessages(flow.lineId);
  const create = useCreateLine();
  const message = messages.data?.messages.find((item) => item.id === flow.messageId);
  const spinoffOn = isFeatureOn(capabilities.data, "spinoff");
  const started = useStartOnce(!spinoffOn && Boolean(message) && capabilities.isSuccess, () => {
    void create.mutateAsync({}).then(
      (created) => {
        close();
        navigate(created.id);
        if (message) onPrefill?.(created.id, message.content);
        focusComposerSoon();
      },
      (error: unknown) => {
        close();
        toast(describeError(error, t));
      },
    );
  });
  if (!line.data || !messages.data || !message || !spinoffOn || started) return null;
  return (
    <SpinoffDialog
      open
      onOpenChange={(open) => !open && close()}
      line={line.data}
      messages={messages.data.messages}
      atMessageId={message.id}
      onDone={(result) => {
        navigate(result.line.id);
        onPrefill?.(result.line.id, message.content);
        focusComposerSoon();
      }}
    />
  );
}

/** Runs `start` once, the first render `ready` is true (a ref, so StrictMode's second effect run does not start it again); true from then on. */
function useStartOnce(ready: boolean, start: () => void): boolean {
  const started = useRef(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    setDone(true);
    start();
  }, [ready, start]);
  return done;
}

/**
 * The demo's host for the F2 dialogs: one at a time, each fed from the query
 * cache, and what happens after (switch lines, highlight the card or marker).
 */
const LINE_FLOWS = new Set<BranchFlow["kind"]>(["open", "move", "spinoff", "relation", "fold", "diverge", "editBranch", "regenerate", "seedsBatch", "askAgain", "extract", "continueAside", "deleteBranch", "saveTerm", "askedBefore"]);

export function BranchFlows({ flow, onChange, navigate, toast, modelOptions, onPrefill, onShowParking, onHighlight, onShowGlossary }: BranchFlowsProps) {
  const branchLineId = flow && !LINE_FLOWS.has(flow.kind) ? flow.lineId : null;
  const detail = useBranchDetail(branchLineId);
  const close = () => onChange(null);
  if (!flow) return null;
  if (flow.kind === "open") return <OpenFlow flow={flow} close={close} navigate={navigate} toast={toast} modelOptions={modelOptions} onPrefill={onPrefill} />;
  if (flow.kind === "editBranch" || flow.kind === "regenerate")
    return <RewriteFlow flow={flow} close={close} navigate={navigate} toast={toast} onAskAgain={(message) => onChange({ kind: "askAgain", lineId: flow.lineId, messageId: message.id })} />;
  if (flow.kind === "seedsBatch") return <SeedsFlow flow={flow} close={close} toast={toast} onShowParking={onShowParking} />;
  if (flow.kind === "askAgain") return <AskAgainFlow key={flow.messageId} flow={flow} close={close} navigate={navigate} onPrefill={onPrefill} toast={toast} />;
  if (flow.kind === "move") return <MoveFlow flow={flow} close={close} navigate={navigate} />;
  if (flow.kind === "extract")
    return (
      <Suspense fallback={null}>
        <ExtractFlow lineId={flow.lineId} messageId={flow.messageId} close={close} navigate={navigate} toast={toast} {...(onHighlight ? { onHighlight } : {})} />
      </Suspense>
    );
  if (flow.kind === "continueAside")
    return (
      <Suspense fallback={null}>
        <ContinueAsideFlow key={flow.lineId} lineId={flow.lineId} close={close} navigate={navigate} toast={toast} openFlow={onChange} />
      </Suspense>
    );
  // The frame's delete host takes these; nothing to show here.
  if (flow.kind === "deleteBranch") return null;
  if (flow.kind === "saveTerm" || flow.kind === "askedBefore")
    return (
      <Suspense fallback={null}>
        <GlossaryFlow flow={flow} close={close} toast={toast} {...(onShowGlossary ? { onShowGlossary } : {})} />
      </Suspense>
    );
  if (flow.kind === "spinoff") return <SpinoffFlow flow={flow} close={close} navigate={navigate} />;
  if (flow.kind === "relation") return <RelationFlow flow={flow} close={close} />;
  if (flow.kind === "fold") return <FoldFlow flow={flow} close={close} />;
  if (flow.kind === "diverge") return <DivergeFlow flow={flow} close={close} />;
  if (!detail.data) return null;
  return <BranchFlowDialogs flow={flow} branch={detail.data.branch} close={close} navigate={navigate} toast={toast} openFlow={onChange} />;
}
