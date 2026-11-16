/**
 * Routes and fields B5 added (docs/devlog/B4-contract-diff.md, B5): renaming
 * a branch, previewing a new branch's background without writing it, full-text
 * search. (The card draft's `noteChanges` is read in branch-normalize.ts.)
 */
import type { BranchKind, BranchPack, BranchView } from "./types";
import { normalizeBranchPack, normalizeBranchView } from "./branch-normalize";
import { count, list, num, obj, oneOf, str } from "./wire";

// Rename ----------------------------------------------------------------------

/** `PATCH /lines/{id}/branch`: an open branch's purpose (same limits and cleaning as creating one). */
export interface RenameBranchInput {
  purpose: string;
}

export interface RenameBranchResult {
  branch: BranchView;
}

export function normalizeRenameBranchResult(raw: unknown): RenameBranchResult {
  return { branch: normalizeBranchView(obj(raw).branch) };
}

// Branch background preview ----------------------------------------------------

/** `POST /lines/{id}/branches/preview`: the create-branch fields that shape the pack. */
export interface PreviewBranchInput {
  anchorMessageId: string;
  /** May be left out: the form previews before a purpose is typed. */
  purpose?: string;
  kind: BranchKind;
  excerpt?: string;
  includeLater?: boolean;
}

/** The pack a branch opened now would get, its text and token estimate; nothing is written. */
export interface BranchPreview {
  pack: BranchPack;
  text: string;
  tokenEstimate: number;
}

export function normalizeBranchPreview(raw: unknown): BranchPreview {
  const body = obj(raw);
  return { pack: normalizeBranchPack(body.pack), text: str(body.text), tokenEstimate: count(body.tokenEstimate) };
}

// Search -------------------------------------------------------------------------

export const SEARCH_HIT_KINDS = ["title", "purpose", "message"] as const;
export type SearchHitKind = (typeof SEARCH_HIT_KINDS)[number];

export interface SearchQuery {
  /** 2–200 characters. */
  q: string;
  /** At most 50. */
  limit?: number;
  archived?: boolean;
  /** B14: only this conversation's tree (its main line's id; archived or not, folded messages too); a branch or unknown id is `404 line_not_found`. */
  root?: string;
}

/** Where a hit's matched text sits in `snippet` (character offsets, end exclusive). */
export interface SearchHighlight {
  start: number;
  end: number;
}

export interface SearchHit {
  kind: SearchHitKind;
  lineId: string;
  rootLineId: string;
  rootTitle: string;
  /** The branch's purpose ("" on a main line). */
  purpose: string;
  snippet: string;
  highlights: SearchHighlight[];
  score: number;
  at: string;
  /** Message hits only. */
  messageId?: string;
  seq?: number;
  role?: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
}

function normalizeHighlight(raw: unknown): SearchHighlight {
  const item = obj(raw);
  return { start: count(item.start), end: count(item.end) };
}

function normalizeSearchHit(raw: unknown): SearchHit {
  const hit = obj(raw);
  return {
    at: str(hit.at),
    highlights: list(hit.highlights, normalizeHighlight),
    kind: oneOf(hit.kind, SEARCH_HIT_KINDS, "message"),
    lineId: str(hit.lineId),
    ...(typeof hit.messageId === "string" ? { messageId: hit.messageId } : {}),
    purpose: str(hit.purpose),
    ...(typeof hit.role === "string" ? { role: hit.role } : {}),
    rootLineId: str(hit.rootLineId),
    rootTitle: str(hit.rootTitle),
    score: num(hit.score),
    ...(typeof hit.seq === "number" ? { seq: hit.seq } : {}),
    snippet: str(hit.snippet),
  };
}

export function normalizeSearchResult(raw: unknown): SearchResult {
  const body = obj(raw);
  return { hits: list(body.hits, normalizeSearchHit), query: str(body.query) };
}
