/**
 * Memos (B13, the memo feature): notes on a node that never go to the AI
 * (DESIGN §12.10). Not private: every reader of a conversation reads them.
 * Inputs are untrusted JSON; every reader fills the defaults.
 */
import { DEFAULT_MEMO_LIMITS, type MemoLimits } from "./memo-limits";
import { list, obj, oneOf, str } from "./wire";

export { DEFAULT_MEMO_LIMITS, type MemoLimits } from "./memo-limits";

export interface Memo {
  id: string;
  rootLineId: string;
  /** The node it was written on; "" once that line is gone (the memo stays, named by `sourceLabel`). */
  lineId: string;
  /** The node's name when the memo was written (a snapshot a rename leaves alone). */
  sourceLabel: string;
  text: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** `GET /lines/{id}/memos`: the conversation's memos, oldest first (one node's with `lineId`). */
export interface MemoList {
  rootLineId: string;
  memos: Memo[];
  limits: MemoLimits;
}

/** `POST /lines/{id}/memos`: `lineId` is the node (the path's line when absent), in the same conversation. */
export interface CreateMemoInput {
  lineId?: string;
  text: string;
}

export interface MemoListQuery {
  /** Only this node's memos. */
  lineId?: string;
}

/** `POST`, `PATCH`, `DELETE`: the memo (as it was, for a delete). */
export interface MemoResult {
  memo: Memo;
}

export const MEMO_CHANGES = ["created", "updated", "deleted"] as const;
export type MemoChangeKind = (typeof MEMO_CHANGES)[number];

/** `memo.changed`. */
export interface MemoChanged {
  rootLineId: string;
  memoId: string;
  change: MemoChangeKind;
}

export function normalizeMemo(raw: unknown): Memo {
  const body = obj(raw);
  return {
    id: str(body.id),
    rootLineId: str(body.rootLineId),
    lineId: str(body.lineId),
    sourceLabel: str(body.sourceLabel),
    text: str(body.text),
    createdBy: str(body.createdBy),
    createdAt: str(body.createdAt),
    updatedAt: str(body.updatedAt),
  };
}

const positive = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

export function normalizeMemoList(raw: unknown): MemoList {
  const body = obj(raw);
  const limits = obj(body.limits);
  return {
    rootLineId: str(body.rootLineId),
    memos: list(body.memos, normalizeMemo),
    limits: { maxTotal: positive(limits.maxTotal, DEFAULT_MEMO_LIMITS.maxTotal), maxRunes: positive(limits.maxRunes, DEFAULT_MEMO_LIMITS.maxRunes) },
  };
}

export function normalizeMemoResult(raw: unknown): MemoResult {
  return { memo: normalizeMemo(obj(raw).memo) };
}

export function normalizeMemoChanged(raw: unknown): MemoChanged {
  const body = obj(raw);
  return { rootLineId: str(body.rootLineId), memoId: str(body.memoId), change: oneOf(body.change, MEMO_CHANGES, "updated") };
}
