/**
 * The glossary (B24, the glossary feature): one list of "term → explanation"
 * per conversation (docs/devlog/B24-glossary.md). Only the terms reach the
 * AI; the explanations are for the reader. Only the wire shapes and their
 * readers live here (the client needs them in every bundle); the rules the
 * screens ask about are in `glossary-rules.ts`, the matcher in `term-match.ts`.
 * Inputs are untrusted JSON; every reader fills the defaults.
 */
import { normalizeBranchView } from "./branch-normalize";
import type { BranchView } from "./types";
import { isObject, list, obj, oneOf, str } from "./wire";

export interface Term {
  id: string;
  rootLineId: string;
  /** As written: one line, at most `termMaxRunes` characters. */
  term: string;
  /** No spaces, full-width ASCII folded, lower case; unique in the conversation. */
  termKey: string;
  /** At most `explanationMaxRunes` characters; may have line breaks. */
  explanation: string;
  /** The line it was saved from; "" once that line is gone (the term stays, named by `sourceLabel`). */
  sourceLineId: string;
  /** The message it was saved from; "" without one. */
  sourceMessageId: string;
  /** The source's name when the term was saved (a snapshot a rename leaves alone). */
  sourceLabel: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A term found across the tenant's conversations, with its conversation's title. */
export type TermSearchHit = Term & { rootTitle: string };

/** `GET /lines/{id}/terms` limits; the domain defaults when a body lacks them. */
export interface TermLimits {
  /** New terms are refused past this many (`409 term_limit`); a tree may hold more after an attach. */
  maxTotal: number;
  termMaxRunes: number;
  explanationMaxRunes: number;
}

export const DEFAULT_TERM_LIMITS: TermLimits = { maxTotal: 300, termMaxRunes: 60, explanationMaxRunes: 1000 };

/** `GET /lines/{id}/terms`: the conversation's terms by `termKey` (at most 1,000). */
export interface TermList {
  rootLineId: string;
  terms: Term[];
  limits: TermLimits;
}

/** `POST /lines/{id}/terms`; `{id}` is the line it is saved from. */
export interface CreateTermInput {
  term: string;
  explanation: string;
  /** A message of that line (`404 message_not_found` otherwise). */
  sourceMessageId?: string;
  /** Overwrites the stored explanation and source of the same term instead of `409 term_exists`. */
  replace?: boolean;
}

/** `PATCH /terms/{tid}`: at least one of the two. */
export interface UpdateTermInput {
  term?: string;
  explanation?: string;
}

export const TERM_WRITE_CHANGES = ["created", "updated"] as const;

/** `POST /lines/{id}/terms`: 201 `created`, 200 `updated` (a replace). */
export interface TermWriteResult {
  term: Term;
  change: (typeof TERM_WRITE_CHANGES)[number];
  /** The aside this save kept (saving from an aside that was not kept yet). */
  keptBranch?: BranchView;
}

/** `PATCH /terms/{tid}`. */
export interface TermResult {
  term: Term;
}

/** `GET /terms`: `limit` 1–100 (20 by default); an empty `q` lists every term. */
export interface TermSearchQuery {
  q?: string;
  limit?: number;
  cursor?: string;
}

/** Terms that start with the query first, then the ones that contain it; archived conversations left out. */
export interface TermSearchPage {
  terms: TermSearchHit[];
  /** "" on the last page. */
  nextCursor: string;
}

export const TERM_CHANGES = ["created", "updated", "deleted"] as const;
export type TermChangeKind = (typeof TERM_CHANGES)[number];

/** `terms.changed`; the envelope's `lineId` is the term's source line ("" once it is gone). */
export interface TermsChanged {
  rootLineId: string;
  termId: string;
  change: TermChangeKind;
}

export function normalizeTerm(raw: unknown): Term {
  const body = obj(raw);
  return {
    id: str(body.id),
    rootLineId: str(body.rootLineId),
    term: str(body.term),
    termKey: str(body.termKey),
    explanation: str(body.explanation),
    sourceLineId: str(body.sourceLineId),
    sourceMessageId: str(body.sourceMessageId),
    sourceLabel: str(body.sourceLabel),
    createdBy: str(body.createdBy),
    createdAt: str(body.createdAt),
    updatedAt: str(body.updatedAt),
  };
}

const positive = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

export function normalizeTermList(raw: unknown): TermList {
  const body = obj(raw);
  const limits = obj(body.limits);
  return {
    rootLineId: str(body.rootLineId),
    terms: list(body.terms, normalizeTerm),
    limits: {
      maxTotal: positive(limits.maxTotal, DEFAULT_TERM_LIMITS.maxTotal),
      termMaxRunes: positive(limits.termMaxRunes, DEFAULT_TERM_LIMITS.termMaxRunes),
      explanationMaxRunes: positive(limits.explanationMaxRunes, DEFAULT_TERM_LIMITS.explanationMaxRunes),
    },
  };
}

export function normalizeTermWriteResult(raw: unknown): TermWriteResult {
  const body = obj(raw);
  return {
    term: normalizeTerm(body.term),
    change: oneOf(body.change, TERM_WRITE_CHANGES, "created"),
    ...(isObject(body.keptBranch) ? { keptBranch: normalizeBranchView(body.keptBranch) } : {}),
  };
}

export function normalizeTermResult(raw: unknown): TermResult {
  return { term: normalizeTerm(obj(raw).term) };
}

export function normalizeTermSearchPage(raw: unknown): TermSearchPage {
  const body = obj(raw);
  return { terms: list(body.terms, (item) => ({ ...normalizeTerm(item), rootTitle: str(obj(item).rootTitle) })), nextCursor: str(body.nextCursor) };
}
