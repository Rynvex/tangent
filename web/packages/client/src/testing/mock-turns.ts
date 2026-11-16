/**
 * Simulated turns: `sendMessage` stores the user message and a pending
 * assistant message, streams the canned reply as `message.delta` events, then
 * completes it — the same event order and message shapes the Engine produces
 * (DESIGN §6, contract samples). The fake runner's directives work here too,
 * so one e2e flow runs against both: `[fake:retry]` reports one automatic
 * retry first, `[fake:slow]` waits before answering, `[fake:error]` fails;
 * mock only, `[fake:list]` answers with a Markdown list (F8 S11).
 */
import type { CancelResult, PreviewTurnResult, SendMessageResult, StreamPage } from "../api-types";
import { TangentError } from "../errors";
import { isHostNotice } from "../branch-view";
import type { Delta, Message, MessageMeta } from "../types";
import { closeBranch } from "./mock-branches";
import { address, publishLine, type MockContext } from "./mock-context";
import { mockPreview, tokensOf } from "./mock-preview";
import { findLine, messagesOf, newId, takeSeq, withDeltas, withLine, withMessage } from "./mock-store";
import { fixture } from "./scenario";

const CHUNK_CHARS = 6;
/** The fake runner's `SlowDelay`. */
const SLOW_MS = 3000;
const MOCK_PROVIDER = "mock";
const MOCK_MODEL = "mock-1";
const MOCK_ACTOR = "operator";
const FAILED_TEXT = "the fake runner was told to fail";

export const DIRECTIVES = { error: "[fake:error]", retry: "[fake:retry]", slow: "[fake:slow]" } as const;
/**
 * Mock only (the server's fake runner has no hosts): a host's notice right
 * after the pending reply, so it sits after a reply that still streams, or
 * after a failed one (B7.2).
 */
export const NOTICE_DIRECTIVE = "[fake:notice]";
/** Mock only (F8 S11): the reply is a Markdown list, so 將清單存入停車場 can be tried. */
export const LIST_DIRECTIVE = "[fake:list]";
const LIST_REPLY = "可以先查這幾件事：\n\n1. **UPS** 的續航時間\n2. 硬碟的保固年限\n3. 備份到 [Backblaze B2](https://www.backblaze.com/) 的月費\n4. 路由器支不支援 `WireGuard`\n\n查完再決定。";
export const NOTICE_TEXT = "Host notice (fake runner)";

interface RunningTurn {
  turnId: string;
  startedAt: number;
  timer: unknown;
}

export interface MockTurns {
  send(lineId: string, content: string): SendMessageResult;
  /** Runs the last, failed turn again under the same user message (B4.1 `POST /retry`). */
  retry(lineId: string): SendMessageResult;
  cancel(lineId: string): CancelResult;
  stream(lineId: string, afterSeq?: number): StreamPage;
  preview(lineId: string, content: string): PreviewTurnResult;
  /** A host's system message at the end of the line (B7.2 `Engine.AppendSystemMessage`), also while a reply streams. */
  notice(lineId: string, content: string): Message;
  dispose(): void;
}

function chunks(text: string): string[] {
  const chars = Array.from(text);
  const result: string[] = [];
  for (let i = 0; i < chars.length; i += CHUNK_CHARS) result.push(chars.slice(i, i + CHUNK_CHARS).join(""));
  return result;
}


export function createMockTurns(ctx: MockContext): MockTurns {
  const running = new Map<string, RunningTurn>();

  function assertCanSend(lineId: string): void {
    const line = findLine(ctx.state(), lineId);
    if (line.archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
    if (line.conversationBranch && line.conversationBranch.status !== "open") throw new TangentError(409, "the branch has ended", "branch_closed");
    if (line.status === "thinking" || running.has(lineId)) throw new TangentError(409, "a turn is already running", "turn_pending");
  }

  function addMessage(raw: Record<string, unknown>): Message {
    const [seq, afterSeq] = takeSeq(ctx.state());
    const [id, next] = newId(afterSeq, "msg");
    const message = fixture.message({ id, seq, createdAt: ctx.now(), ...raw });
    ctx.commit(withMessage(next, message));
    return message;
  }

  /** Completes the pending message like `CompleteTurn`: the line goes idle (or error) and both are published. */
  function finish(lineId: string, turn: RunningTurn, content: string, status: Message["status"], meta: MessageMeta, lineStatus: "idle" | "error" = "idle"): Message | null {
    running.delete(lineId);
    const pending = ctx.state().messages.find((message) => message.id === turn.turnId);
    if (!pending) return null;
    const done: Message = { ...pending, content, status, meta: { ...pending.meta, durationMs: Date.now() - turn.startedAt, ...meta } };
    const line = findLine(ctx.state(), lineId);
    const spent = done.meta.usage;
    const usage = spent
      ? { inputTokens: line.usage.inputTokens + spent.inputTokens, outputTokens: line.usage.outputTokens + spent.outputTokens, costUsd: line.usage.costUsd + spent.costUsd }
      : line.usage;
    const statusDetail = lineStatus === "error" ? (meta.error ?? "") : "";
    ctx.commit(withMessage(ctx.state(), done));
    ctx.commit(withLine(ctx.state(), { ...line, status: lineStatus, statusDetail, usage, lastActivityAt: ctx.now() }));
    if (status === "done" && !done.meta.cancelled) deliverCards(done.meta.deliversCards ?? []);
    ctx.bus.publish("message.updated", address(ctx, lineId), done);
    publishLine(ctx, lineId);
    if (status === "done" && !done.meta.cancelled) endAnsweredAside(lineId);
    return done;
  }

  /** Like `CompleteTurn`: the cards the turn carried are delivered (the server publishes no event for them). */
  function deliverCards(ids: readonly string[]): void {
    for (const id of ids) {
      const card = ctx.state().messages.find((message) => message.id === id);
      if (card) ctx.commit(withMessage(ctx.state(), { ...card, meta: { ...card.meta, delivered: true } }));
    }
  }

  /** An open aside ends (discarded) once its one answer is in. */
  function endAnsweredAside(lineId: string): void {
    const branch = ctx.state().branches.find((item) => item.lineId === lineId);
    if (!branch || branch.kind !== "aside" || branch.status !== "open") return;
    const ended = closeBranch(ctx, branch, { status: "discarded" });
    ctx.bus.publish("branch.changed", address(ctx, lineId), { change: "discarded", branch: ended });
    publishLine(ctx, branch.parentLineId);
  }

  /** The conclusion cards of a line no turn carried yet (the next turn's notice). */
  function undeliveredCards(lineId: string): string[] {
    return messagesOf(ctx.state(), lineId)
      .filter((message) => message.kind === "branch_card" && !message.meta.delivered)
      .map((message) => message.id);
  }

  function appendDelta(lineId: string, turnId: string, text: string): void {
    const state = ctx.state();
    const seq = state.deltaSeq + 1;
    const delta: Delta = { turnId, seq, kind: "text", text };
    ctx.commit(withDeltas({ ...state, deltaSeq: seq }, lineId, [...(state.deltas[lineId] ?? []), delta]));
    ctx.bus.publish("message.delta", address(ctx, lineId), delta);
  }

  function streamReply(lineId: string, turn: RunningTurn, pieces: readonly string[], index: number, userContent: string): void {
    if (index >= pieces.length) {
      const content = pieces.join("");
      const usage = { inputTokens: 1200, outputTokens: tokensOf(content), costUsd: 0.004 };
      if (finish(lineId, turn, content, "done", { usage })) ctx.afterTurn?.(lineId, userContent);
      return;
    }
    appendDelta(lineId, turn.turnId, pieces[index]!);
    turn.timer = ctx.timers.setTimeout(() => streamReply(lineId, turn, pieces, index + 1, userContent), ctx.chunkMs);
  }

  function start(lineId: string, turn: RunningTurn, content: string): void {
    if (content.includes(DIRECTIVES.error)) {
      finish(lineId, turn, `Turn failed: ${FAILED_TEXT}`, "error", { error: FAILED_TEXT }, "error");
      return;
    }
    const reply = content.includes(LIST_DIRECTIVE) ? LIST_REPLY : (ctx.scenario.replies[lineId] ?? ctx.scenario.replies["*"] ?? `Fake reply to: ${content}`);
    streamReply(lineId, turn, chunks(reply), 0, content);
  }

  /** Adds the pending reply to `userMessage` and starts streaming it (send and retry). */
  function begin(lineId: string, userMessage: Message): SendMessageResult {
    const content = userMessage.content;
    const cards = undeliveredCards(lineId);
    const pendingMessage = addMessage({
      lineId,
      role: "assistant",
      content: "",
      status: "pending",
      meta: { actor: MOCK_ACTOR, provider: MOCK_PROVIDER, model: MOCK_MODEL, ...(cards.length > 0 ? { deliversCards: cards } : {}) },
    });
    const line = findLine(ctx.state(), lineId);
    ctx.commit(withDeltas(withLine(ctx.state(), { ...line, status: "thinking", statusDetail: "", lastActivityAt: ctx.now() }), lineId, []));
    ctx.bus.publish("message.created", address(ctx, lineId), pendingMessage);
    publishLine(ctx, lineId);
    // The turn id is the pending assistant message's id (DESIGN §6).
    const turn: RunningTurn = { turnId: pendingMessage.id, startedAt: Date.now(), timer: null };
    running.set(lineId, turn);
    if (content.includes(DIRECTIVES.retry)) {
      ctx.bus.publish("turn.retrying", address(ctx, lineId), { turnId: turn.turnId, attempt: 1, maxAttempts: 2, nextRetryAt: ctx.now() });
    }
    const delay = content.includes(DIRECTIVES.slow) ? SLOW_MS : ctx.chunkMs;
    turn.timer = ctx.timers.setTimeout(() => start(lineId, turn, content), delay);
    if (content.includes(NOTICE_DIRECTIVE)) notice(lineId, NOTICE_TEXT);
    return { turnId: turn.turnId, userMessage, pendingMessage };
  }

  /** Like `AppendSystemMessage`: role system, kind chat, the next seq; refused on an archived conversation or an ended branch. */
  function notice(lineId: string, content: string): Message {
    const line = findLine(ctx.state(), lineId);
    const root = line.conversationBranch ? findLine(ctx.state(), line.conversationBranch.rootLineId) : line;
    if (root.archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
    if (line.conversationBranch && line.conversationBranch.status !== "open") throw new TangentError(409, "the branch has ended", "branch_closed");
    const message = addMessage({ lineId, role: "system", kind: "chat", content, status: "done" });
    ctx.bus.publish("message.created", address(ctx, lineId), message);
    return message;
  }

  return {
    send(lineId, content) {
      assertCanSend(lineId);
      const userMessage = addMessage({ lineId, role: "user", content });
      ctx.bus.publish("message.created", address(ctx, lineId), userMessage);
      return begin(lineId, userMessage);
    },

    retry(lineId) {
      assertCanSend(lineId);
      // A host's notices after the failed reply do not count (the server's RetryTurn skips them, B7.2).
      const [question, reply] = messagesOf(ctx.state(), lineId)
        .filter((message) => !isHostNotice(message))
        .slice(-2);
      if (!question || !reply || question.role !== "user" || reply.role !== "assistant" || reply.status !== "error") {
        throw new TangentError(409, "the last turn did not fail", "nothing_to_retry");
      }
      return begin(lineId, question);
    },

    cancel(lineId) {
      findLine(ctx.state(), lineId);
      const turn = running.get(lineId);
      if (!turn) return { cancelled: false, line: publishLine(ctx, lineId), message: null };
      ctx.timers.clearTimeout(turn.timer);
      const partial = (ctx.state().deltas[lineId] ?? []).filter((delta) => delta.turnId === turn.turnId).map((delta) => delta.text).join("");
      const message = finish(lineId, turn, partial, "done", { cancelled: true });
      return { cancelled: true, line: findLine(ctx.state(), lineId), message };
    },

    notice,

    stream(lineId, afterSeq = 0) {
      findLine(ctx.state(), lineId);
      const deltas = ctx.state().deltas[lineId] ?? [];
      return { deltas: deltas.filter((delta) => delta.seq > afterSeq), seq: deltas.at(-1)?.seq ?? 0, truncated: false };
    },

    preview: (lineId, content) => mockPreview(ctx, lineId, content),

    dispose() {
      for (const turn of running.values()) ctx.timers.clearTimeout(turn.timer);
      running.clear();
    },
  };
}
