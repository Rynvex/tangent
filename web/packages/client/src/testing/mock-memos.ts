/**
 * The mock's memos (B13): the server's rules for `/memos` — the node in the
 * same tree, 1–4,000 characters, 500 per tree, archived trees refuse
 * writes — and `memo.changed` after each write. Never part of a preview.
 */
import { isFeatureOn } from "../capabilities";
import { TangentError } from "../errors";
import { DEFAULT_MEMO_LIMITS, type CreateMemoInput, type Memo, type MemoChangeKind, type MemoList, type MemoListQuery, type MemoResult } from "../memo-routes";
import type { MockContext } from "./mock-context";
import { mockSourceLabel } from "./mock-notes";
import { findLine, newId, rootOf } from "./mock-store";

export interface MockMemos {
  list(lineId: string, query: MemoListQuery): MemoList;
  create(lineId: string, input: CreateMemoInput): MemoResult;
  update(memoId: string, text: string): MemoResult;
  remove(memoId: string): MemoResult;
}

export function createMockMemos(ctx: MockContext): MockMemos {
  const { maxTotal, maxRunes } = DEFAULT_MEMO_LIMITS;
  function require(): void {
    if (!isFeatureOn(ctx.scenario.capabilities, "memo")) throw new TangentError(404, "the memo feature is off", "feature_disabled", { feature: "memo" });
  }
  const rootFor = (lineId: string) => rootOf(findLine(ctx.state(), lineId));
  function nodeIn(root: string, lineId: string): string {
    if (rootFor(lineId) !== root) throw new TangentError(404, `line ${lineId} not found`, "line_not_found");
    return lineId;
  }
  function writable(root: string): void {
    if (findLine(ctx.state(), root).archivedAt) throw new TangentError(409, "the conversation is archived", "archived");
  }
  function clean(text: string): string {
    const trimmed = text.replace(/\r\n/g, "\n").trim();
    if (trimmed === "") throw new TangentError(422, "a memo must not be empty", "invalid_input");
    if (Array.from(trimmed).length > maxRunes) throw new TangentError(422, "the text is too long", "too_long", { field: "text", max: maxRunes });
    return trimmed;
  }
  function find(memoId: string): Memo {
    const memo = ctx.state().memos.find((item) => item.id === memoId);
    if (!memo) throw new TangentError(404, "memo not found", "memo_not_found");
    return memo;
  }
  function publish(memo: Memo, change: MemoChangeKind): void {
    ctx.bus.publish("memo.changed", { lineId: memo.lineId, rootLineId: memo.rootLineId }, { rootLineId: memo.rootLineId, memoId: memo.id, change });
  }

  return {
    list(lineId, query) {
      require();
      const root = rootFor(lineId);
      const node = query.lineId ? nodeIn(root, query.lineId) : null;
      const memos = ctx.state().memos.filter((memo) => memo.rootLineId === root && (node === null || memo.lineId === node));
      return { rootLineId: root, memos: [...memos], limits: { maxTotal, maxRunes } };
    },
    create(lineId, input) {
      require();
      const root = rootFor(lineId);
      writable(root);
      const node = input.lineId ? nodeIn(root, input.lineId) : lineId;
      const text = clean(input.text);
      if (ctx.state().memos.filter((memo) => memo.rootLineId === root).length >= maxTotal) {
        throw new TangentError(409, "this conversation has reached its limit of memos", "memo_limit", { limit: maxTotal });
      }
      const [id, next] = newId(ctx.state(), "memo");
      const now = ctx.now();
      const memo: Memo = { id, rootLineId: root, lineId: node, sourceLabel: mockSourceLabel(next, root, { sourceLineId: node, sourceMessageId: "" }), text, createdBy: "mock-user", createdAt: now, updatedAt: now };
      ctx.commit({ ...next, memos: [...next.memos, memo] });
      publish(memo, "created");
      return { memo };
    },
    update(memoId, text) {
      require();
      const before = find(memoId);
      writable(before.rootLineId);
      const memo = { ...before, text: clean(text), updatedAt: ctx.now() };
      const state = ctx.state();
      ctx.commit({ ...state, memos: state.memos.map((item) => (item.id === memoId ? memo : item)) });
      publish(memo, "updated");
      return { memo };
    },
    remove(memoId) {
      require();
      const memo = find(memoId);
      writable(memo.rootLineId);
      const state = ctx.state();
      ctx.commit({ ...state, memos: state.memos.filter((item) => item.id !== memoId) });
      publish(memo, "deleted");
      return { memo };
    },
  };
}
