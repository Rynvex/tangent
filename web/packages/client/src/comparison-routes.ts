/**
 * Diverge and converge (B10 phase B, the diverge feature; D3): a
 * comparison of 2–5 open sibling branches and the decision it leads to.
 * Shapes of `POST /lines/{id}/diverge|converge`, `GET /lines/{id}/comparisons`,
 * `GET /comparisons/{cid}`, `POST /comparisons/{cid}/decide` and
 * `comparison.changed`. Input is untrusted JSON.
 */
import type { JobStarted } from "./api-types";
import { normalizeBranchView } from "./branch-normalize";
import { normalizeLeaf } from "./p1-routes";
import { normalizeJobStarted } from "./result-normalize";
import type { BranchView, Leaf } from "./types";
import { count, isObject, list, nullableStr, obj, oneOf, str, strings } from "./wire";

/** `ready`: the table is written; `decided`: one option was chosen. */
export const COMPARISON_STATUSES = ["drafting", "ready", "failed", "decided"] as const;
export type ComparisonStatus = (typeof COMPARISON_STATUSES)[number];

/** One cell: a score 1–5, or 0 when the model gave none (shown as "—"). */
export interface ComparisonCell {
  score: number;
  why: string;
}

export interface ComparisonMatrix {
  /** The rows. */
  criteria: string[];
  /** The columns, in the requested order; `label` is the branch's purpose when compared. */
  options: Array<{ lineId: string; label: string }>;
  /** `scores[row][column]`. */
  scores: ComparisonCell[][];
  recommendation: { lineId: string; reason: string };
}

export interface Comparison {
  id: string;
  rootLineId: string;
  /** The line the compared branches hang on. */
  parentLineId: string;
  lineIds: string[];
  /** The user's criteria; [] when the model chose them (see `matrix.criteria`). */
  criteria: string[];
  status: ComparisonStatus;
  matrix: ComparisonMatrix | null;
  /** "" before the decision. */
  decidedLineId: string;
  createdBy: string;
  decidedBy: string;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

export interface ComparisonLimits {
  minOptions: number;
  maxOptions: number;
  maxCriteria: number;
}

/** domain.DefaultLimits().Diverge, for servers that leave `limits` out. */
export const DEFAULT_COMPARISON_LIMITS: ComparisonLimits = { minOptions: 2, maxOptions: 5, maxCriteria: 6 };
/** How many directions one diverge may ask for. */
export const DIVERGE_COUNT = { min: 2, max: 5 } as const;

export interface ComparisonList {
  lineId: string;
  rootLineId: string;
  /** Newest first. */
  comparisons: Comparison[];
  limits: ComparisonLimits;
}

export interface ConvergeStarted {
  comparison: Comparison;
  job: JobStarted;
}

/** The chosen branch (open, with a decision leaf), its decision, and the other compared branches it ended. */
export interface DecideResult {
  comparison: Comparison;
  chosen: BranchView;
  decision: Leaf;
  discarded: BranchView[];
}

export interface DivergeInput {
  anchorMessageId: string;
  /** 2–5. */
  count: number;
}

export interface ConvergeInput {
  lineIds: string[];
  /** ≤ 6, each ≤ 120 characters; left out for the model to choose. */
  criteria?: string[];
}

export interface DecideInput {
  lineId: string;
  /** The decision's line; left out for the recommendation's reason (or the branch's purpose). */
  line?: string;
}

const SCORE_MAX = 5;

function normalizeCell(raw: unknown): ComparisonCell {
  const cell = obj(raw);
  const score = count(cell.score);
  return { score: score >= 1 && score <= SCORE_MAX ? score : 0, why: str(cell.why) };
}

function normalizeMatrix(raw: unknown): ComparisonMatrix | null {
  if (!isObject(raw)) return null;
  const recommendation = obj(raw.recommendation);
  return {
    criteria: strings(raw.criteria),
    options: list(raw.options, (option) => ({ lineId: str(obj(option).lineId), label: str(obj(option).label) })),
    scores: list(raw.scores, (row) => list(row, normalizeCell)),
    recommendation: { lineId: str(recommendation.lineId), reason: str(recommendation.reason) },
  };
}

export function normalizeComparison(raw: unknown): Comparison {
  const comparison = obj(raw);
  return {
    id: str(comparison.id),
    rootLineId: str(comparison.rootLineId),
    parentLineId: str(comparison.parentLineId),
    lineIds: strings(comparison.lineIds),
    criteria: strings(comparison.criteria),
    status: oneOf(comparison.status, COMPARISON_STATUSES, "drafting"),
    matrix: normalizeMatrix(comparison.matrix),
    decidedLineId: str(comparison.decidedLineId),
    createdBy: str(comparison.createdBy),
    decidedBy: str(comparison.decidedBy),
    createdAt: str(comparison.createdAt),
    updatedAt: str(comparison.updatedAt),
    decidedAt: nullableStr(comparison.decidedAt),
  };
}

export function normalizeComparisonList(raw: unknown): ComparisonList {
  const body = obj(raw);
  const limits = obj(body.limits);
  const value = (key: keyof ComparisonLimits) => (typeof limits[key] === "number" ? count(limits[key]) : DEFAULT_COMPARISON_LIMITS[key]);
  return {
    lineId: str(body.lineId),
    rootLineId: str(body.rootLineId),
    comparisons: list(body.comparisons, normalizeComparison),
    limits: { minOptions: value("minOptions"), maxOptions: value("maxOptions"), maxCriteria: value("maxCriteria") },
  };
}

export function normalizeComparisonResult(raw: unknown): { comparison: Comparison } {
  return { comparison: normalizeComparison(obj(raw).comparison) };
}

export function normalizeConvergeStarted(raw: unknown): ConvergeStarted {
  const body = obj(raw);
  return { comparison: normalizeComparison(body.comparison), job: normalizeJobStarted(body.job) };
}

export function normalizeDecideResult(raw: unknown): DecideResult {
  const body = obj(raw);
  return { comparison: normalizeComparison(body.comparison), chosen: normalizeBranchView(body.chosen), decision: normalizeLeaf(body.decision), discarded: list(body.discarded, normalizeBranchView) };
}

/** `comparison.changed` data. */
export interface ComparisonChanged {
  rootLineId: string;
  comparison: Comparison;
}

export function normalizeComparisonChanged(raw: unknown): ComparisonChanged {
  const body = obj(raw);
  return { rootLineId: str(body.rootLineId), comparison: normalizeComparison(body.comparison) };
}
