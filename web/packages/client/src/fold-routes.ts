/**
 * Folds (B10 phase A, the fold feature; D4): a run of a line's messages that
 * the model sees as one summary. Shapes of `GET/POST /lines/{id}/folds`,
 * `DELETE /folds/{fid}`, `fold.changed` and a fold's job. Input is untrusted JSON.
 */
import type { JobStarted } from "./api-types";
import { normalizeJobStarted } from "./result-normalize";
import { bool, count, isObject, list, obj, oneOf, str } from "./wire";

export { normalizeAppliedFold, type AppliedFold } from "./fisheye";

/** `drafting`: AI writes the summary (not applied yet); only `active` is applied; `removed` is not listed. */
export const FOLD_STATUSES = ["drafting", "active", "failed", "removed"] as const;
export type FoldStatus = (typeof FOLD_STATUSES)[number];

export interface Fold {
  id: string;
  lineId: string;
  /** Both ends included; seq ascending. */
  fromMessageId: string;
  toMessageId: string;
  fromSeq: number;
  toSeq: number;
  /** ≤ 1000 characters; "" while drafting or after a failure. */
  summary: string;
  /** Messages in the range when it was made. */
  messageCount: number;
  /** Estimated tokens of the original text, and of the summary. */
  tokensOriginal: number;
  tokensSummary: number;
  status: FoldStatus;
  /** The summary is AI's as written. */
  aiDrafted: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FoldLimits {
  summaryMaxRunes: number;
  minMessages: number;
  maxMessages: number;
  maxActivePerLine: number;
}

/** domain.DefaultLimits().Fold, for servers that leave `limits` out. */
export const DEFAULT_FOLD_LIMITS: FoldLimits = { summaryMaxRunes: 1000, minMessages: 2, maxMessages: 200, maxActivePerLine: 50 };

export interface FoldList {
  lineId: string;
  rootLineId: string;
  folds: Fold[];
  limits: FoldLimits;
}

/** `POST /lines/{id}/folds`: without a summary AI drafts one (`drafting`, a `fold_summary` job). */
export interface FoldCreated {
  fold: Fold;
  job: JobStarted | null;
}

/** Ends in either order; leave `summary` out for AI to draft it. */
export interface CreateFoldInput {
  fromMessageId: string;
  toMessageId: string;
  summary?: string;
}

/** `PATCH /folds/{fid}` (B10 phase B): the user's summary; the fold becomes active, `aiDrafted` false. */
export interface UpdateFoldInput {
  summary: string;
}

export function normalizeFoldResult(raw: unknown): { fold: Fold } {
  return { fold: normalizeFold(obj(raw).fold) };
}

export function normalizeFold(raw: unknown): Fold {
  const fold = obj(raw);
  return {
    id: str(fold.id),
    lineId: str(fold.lineId),
    fromMessageId: str(fold.fromMessageId),
    toMessageId: str(fold.toMessageId),
    fromSeq: count(fold.fromSeq),
    toSeq: count(fold.toSeq),
    summary: str(fold.summary),
    messageCount: count(fold.messageCount),
    tokensOriginal: count(fold.tokensOriginal),
    tokensSummary: count(fold.tokensSummary),
    status: oneOf(fold.status, FOLD_STATUSES, "active"),
    aiDrafted: bool(fold.aiDrafted),
    createdBy: str(fold.createdBy),
    createdAt: str(fold.createdAt),
    updatedAt: str(fold.updatedAt),
  };
}

function normalizeFoldLimits(raw: unknown): FoldLimits {
  const limits = obj(raw);
  const value = (key: keyof FoldLimits) => (typeof limits[key] === "number" ? count(limits[key]) : DEFAULT_FOLD_LIMITS[key]);
  return { summaryMaxRunes: value("summaryMaxRunes"), minMessages: value("minMessages"), maxMessages: value("maxMessages"), maxActivePerLine: value("maxActivePerLine") };
}

export function normalizeFoldList(raw: unknown): FoldList {
  const body = obj(raw);
  return { lineId: str(body.lineId), rootLineId: str(body.rootLineId), folds: list(body.folds, normalizeFold), limits: normalizeFoldLimits(body.limits) };
}

export function normalizeFoldCreated(raw: unknown): FoldCreated {
  const body = obj(raw);
  return { fold: normalizeFold(body.fold), job: isObject(body.job) ? normalizeJobStarted(body.job) : null };
}

/** `fold.changed` data. */
export interface FoldChanged {
  lineId: string;
  rootLineId: string;
  fold: Fold;
}

export function normalizeFoldChanged(raw: unknown): FoldChanged {
  const body = obj(raw);
  return { lineId: str(body.lineId), rootLineId: str(body.rootLineId), fold: normalizeFold(body.fold) };
}
