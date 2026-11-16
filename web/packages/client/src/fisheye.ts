/**
 * The shared token budget and the fisheye report of `POST /preview` (B9
 * phase B, docs/devlog/B4-contract-diff.md "B9 增補（階段 B）"): how the next
 * prompt's budget was spent, and — with the fisheye feature on — how much of
 * each message and branch the model will see.
 */
import { count, isObject, list, num, obj, oneOf, str } from "./wire";

/** How a prompt's budget was spent (`budget` of every preview). */
export interface PromptBudget {
  /** `Limits.Context.TokenBudget` (40000 by default). */
  total: number;
  /** In spending order: `core` (pack / capsule / card notices), feature names (`notes`, `goal`, `summary`…), `host`, `history`; owners that spent nothing are left out. */
  shares: { owner: string; tokens: number }[];
  /** What the recent messages could take (the rest, at most 24000). */
  history: number;
  /** The shares' sum. */
  used: number;
}

export const FISHEYE_LEVELS = ["full", "summary", "leaf_only", "hidden"] as const;
/** 完整 / 摘要 / 只有一句收尾 / 看不到. */
export type FisheyeLevel = (typeof FISHEYE_LEVELS)[number];
/** `group` (B9 phase C): a group whose summary is ready stands for its members; `lineId` is "". */
export const FISHEYE_KINDS = ["message", "branch", "group", "fold"] as const;
export type FisheyeKind = (typeof FISHEYE_KINDS)[number];

/** One message of the line, one other branch, or a group of the tree, and how much of it the model sees. */
export interface FisheyeItem {
  kind: FisheyeKind;
  /** A message id, a branch line's id, or a group id. */
  id: string;
  lineId: string;
  level: FisheyeLevel;
  /** Innate importance minus distance (may be negative); pinned messages get +100. */
  score: number;
  /** What this level costs. */
  tokens: number;
}

export interface FisheyeReport {
  /** Messages in time order (oldest first), then branches by score. */
  items: FisheyeItem[];
  tokens: number;
  budget: number;
}

export function normalizePromptBudget(raw: unknown): PromptBudget {
  const budget = obj(raw);
  return {
    total: count(budget.total),
    shares: list(budget.shares, (item) => ({ owner: str(obj(item).owner), tokens: count(obj(item).tokens) })),
    history: count(budget.history),
    used: count(budget.used),
  };
}

function normalizeFisheyeItem(raw: unknown): FisheyeItem {
  const item = obj(raw);
  return {
    kind: oneOf(item.kind, FISHEYE_KINDS, "message"),
    id: str(item.id),
    lineId: str(item.lineId),
    level: oneOf(item.level, FISHEYE_LEVELS, "hidden"),
    score: num(item.score),
    tokens: count(item.tokens),
  };
}

/** The report, or undefined when the server sent none (fisheye off). */
export function normalizeFisheye(raw: unknown): FisheyeReport | undefined {
  if (!isObject(raw)) return undefined;
  return { items: list(raw.items, normalizeFisheyeItem), tokens: count(raw.tokens), budget: count(raw.budget) };
}

/** The message items, in prompt (time) order. */
export function fisheyeMessages(report: FisheyeReport): FisheyeItem[] {
  return report.items.filter((item) => item.kind === "message");
}

/** A message's or branch's level, or null when the report does not list it. */
export function fisheyeLevelOf(report: FisheyeReport, id: string): FisheyeLevel | null {
  return report.items.find((item) => item.id === id)?.level ?? null;
}

/** A fold the turn's prompt applied (B10 phase A, `PreviewTurn.folds`): `messages` is how many it replaced this turn. */
export interface AppliedFold {
  foldId: string;
  fromSeq: number;
  toSeq: number;
  messages: number;
  tokensOriginal: number;
  tokensSummary: number;
}

export function normalizeAppliedFold(raw: unknown): AppliedFold {
  const fold = obj(raw);
  return {
    foldId: str(fold.foldId),
    fromSeq: count(fold.fromSeq),
    toSeq: count(fold.toSeq),
    messages: count(fold.messages),
    tokensOriginal: count(fold.tokensOriginal),
    tokensSummary: count(fold.tokensSummary),
  };
}
