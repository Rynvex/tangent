/**
 * Routes B14 added (DESIGN §12.10, 2026-10-25): one conversation's whole tree
 * as data (`GET /lines/{id}/export`), branches opened across models
 * (`POST /lines/{id}/diverge/models`) and seeds parked in one go
 * (`POST /lines/{id}/seeds/batch`). Search within one tree is `root` on
 * `GET /search` (b5-routes.ts). Inputs are untrusted JSON; every reader
 * fills the defaults.
 */
import type { CreateBranchResult } from "./api-types";
import { normalizeBranchView } from "./branch-normalize";
import { normalizeChapters } from "./chapters";
import { normalizeComparison, type Comparison } from "./comparison-routes";
import { normalizeFold, type Fold } from "./fold-routes";
import { normalizeLine, normalizeMessage } from "./line-normalize";
import { normalizeMemo, type Memo } from "./memo-routes";
import { normalizeTerm, type Term } from "./glossary-routes";
import { normalizeGoal } from "./p2-routes";
import { normalizeSeed } from "./p1-routes";
import { normalizeCreateBranchResult, normalizeNote } from "./result-normalize";
import { normalizeLink } from "./spinoff-routes";
import type { BranchView, Chapter, Goal, LineView, Link, Message, Note, Seed } from "./types";
import { bool, isObject, list, obj, str } from "./wire";

// Export ------------------------------------------------------------------------

/** `ExportMaxMessagesPerLine`: each line's oldest messages up to this many; more sets `truncated`. */
export const EXPORT_MAX_MESSAGES_PER_LINE = 500;

/**
 * `GET /lines/{id}/export` (any line of the tree; a viewer may read it): the
 * tree as the server has it. Parts of a feature that is off are empty. Not a
 * snapshot: the parts are read one after the other.
 */
export interface TreeExport {
  rootLineId: string;
  exportedAt: string;
  /** A line had more than 500 messages, or the outline or the comparisons hit their cap. */
  truncated: boolean;
  rootLine: LineView;
  /** Asides included. */
  branches: BranchView[];
  /** Every line of the tree (the main line too), by line id; `[]` for a line without messages. */
  messagesByLine: Record<string, Message[]>;
  notes: Note[];
  memos: Memo[];
  /** The main line's chapters. */
  chapters: Chapter[];
  goal: Goal | null;
  comparisons: Comparison[];
  /** Spinoffs and relations touching the tree. */
  links: Link[];
  /** The folds that are not removed, by line id. */
  foldsByLine: Record<string, Fold[]>;
  /** B24: the conversation's glossary by `termKey`; `[]` when the feature is off. */
  terms: Term[];
}

/** A JSON object of lists keyed by id; anything else is an empty record. */
function byLine<T>(raw: unknown, item: (value: unknown) => T): Record<string, T[]> {
  if (!isObject(raw)) return {};
  return Object.fromEntries(Object.entries(raw).map(([lineId, value]) => [lineId, list(value, item)]));
}

export function normalizeTreeExport(raw: unknown): TreeExport {
  const body = obj(raw);
  return {
    rootLineId: str(body.rootLineId),
    exportedAt: str(body.exportedAt),
    truncated: bool(body.truncated),
    rootLine: normalizeLine(body.rootLine),
    branches: list(body.branches, normalizeBranchView),
    messagesByLine: byLine(body.messagesByLine, normalizeMessage),
    notes: list(body.notes, normalizeNote),
    memos: list(body.memos, normalizeMemo),
    chapters: normalizeChapters({ chapters: body.chapters }).chapters,
    goal: isObject(body.goal) ? normalizeGoal(body.goal) : null,
    comparisons: list(body.comparisons, normalizeComparison),
    links: list(body.links, normalizeLink),
    foldsByLine: byLine(body.foldsByLine, normalizeFold),
    terms: list(body.terms, normalizeTerm),
  };
}

// Diverge across models -----------------------------------------------------------

/** How many targets one call takes (`domain.CheckDivergeCount`); another count is `400 invalid_input`. */
export const DIVERGE_MODELS_COUNT = { min: 2, max: 5 } as const;

/** One model a cross-model diverge opens a branch for. */
export interface DivergeModelTarget {
  provider: string;
  model: string;
  /** The branch's own purpose; left out: "{purpose} · {model}" (or the anchor's start · model). */
  purpose?: string;
}

/** `POST /lines/{id}/diverge/models`: 2–5 sibling branches (kind alternative, origin diverge), all or none; no model runs. */
export interface DivergeModelsInput {
  anchorMessageId: string;
  purpose?: string;
  excerpt?: string;
  confirmDeeper?: boolean;
  targets: DivergeModelTarget[];
}

export interface DivergeModelsResult {
  parentLineId: string;
  rootLineId: string;
  /** In the targets' order. */
  branches: CreateBranchResult[];
}

export function normalizeDivergeModelsResult(raw: unknown): DivergeModelsResult {
  const body = obj(raw);
  return { parentLineId: str(body.parentLineId), rootLineId: str(body.rootLineId), branches: list(body.branches, normalizeCreateBranchResult) };
}

// Seeds in one go ---------------------------------------------------------------

/** `domain.SeedBatchMax`: at most this many texts per call (and at least one). */
export const SEED_BATCH_MAX = 20;

/** `POST /lines/{id}/seeds/batch`: all parked or none (`409 seed_limit` when the lot would overflow). */
export interface CreateSeedsBatchInput {
  /** The message they were parked from (on this line); the line's last message when left out. */
  anchorMessageId?: string;
  texts: string[];
}

export interface SeedsBatchResult {
  rootLineId: string;
  /** In the texts' order. */
  seeds: Seed[];
}

export function normalizeSeedsBatchResult(raw: unknown): SeedsBatchResult {
  const body = obj(raw);
  return { rootLineId: str(body.rootLineId), seeds: list(body.seeds, normalizeSeed) };
}
