/**
 * Routes and shapes B8 phase A added (docs/devlog/B4-contract-diff.md "B8
 * 增補"): the suggestion inbox, a branch's leaf and the parking lot. Inputs
 * are untrusted JSON; every reader fills the defaults.
 */
import { normalizeBranchPack, normalizeBranchView } from "./branch-normalize";
import { normalizeLine } from "./line-normalize";
import { normalizeNote } from "./result-normalize";
import {
  LEAF_KINDS,
  LEAF_STATUSES,
  SEED_STATUSES,
  SUGGESTION_STATUSES,
  type BranchKind,
  type BranchPack,
  type BranchView,
  type JsonValue,
  type Leaf,
  type LeafKind,
  type LineView,
  type Note,
  type NoteSection,
  type Seed,
  type Suggestion,
} from "./types";
import { bool, isObject, list, nullableStr, num, obj, oneOf, str } from "./wire";

// Inputs -----------------------------------------------------------------------

/** `?status=` of `GET /seeds` and `GET /suggestions`: comma-separated statuses or `all`; the server's default is `open`. */
export interface InboxListQuery {
  status?: string;
}

/** `PUT /lines/{id}/leaf` (and `leaf` of a discard): the kind defaults to `dead_end` on a discard only. */
export interface LeafInput {
  kind?: LeafKind;
  /** One line, at most 200 characters (the server flattens it). */
  line: string;
  /** At most 4000 characters. */
  body?: string;
}

/** `POST /lines/{id}/branch/discard` body (B8): a dead-end reason written in the same transaction. */
export interface DiscardBranchBody {
  leaf?: LeafInput;
}

/** `POST /lines/{id}/seeds`. Without an anchor the server stores the line's newest chat message. */
export interface CreateSeedInput {
  text: string;
  anchorMessageId?: string;
}

/** `POST /seeds/{sid}/expand`: the purpose defaults to the seed's text (cut to 200), the kind to `investigate`. */
export interface ExpandSeedInput {
  purpose?: string;
  kind?: BranchKind;
  confirmDeeper?: boolean;
}

/** `POST /seeds/{sid}/to-note`: the section defaults to `to_confirm`. */
export interface NoteSeedInput {
  section?: NoteSection;
}

// Results ----------------------------------------------------------------------

/** Why the newest leaf draft failed (B8.1); present only while that failure is the latest state. */
export interface LeafDraftError {
  code: "run_failed" | "unusable" | "timed_out" | "failed";
  message: string;
}

export interface LeafResult {
  leaf: Leaf | null;
  draftError?: LeafDraftError;
}

/** `GET /seeds` limits (B8.1). */
export interface SeedLimits {
  maxOpen: number;
  maxRunes: number;
}

/** domain.DefaultLimits().Parking, for a server that does not send them. */
export const DEFAULT_SEED_LIMITS: SeedLimits = { maxOpen: 100, maxRunes: 500 };

export interface SeedList {
  rootLineId: string;
  seeds: Seed[];
  limits: SeedLimits;
}

export interface SeedWrite {
  seed: Seed;
}

/** A seed expanded into a branch: the same shape as creating one, plus the seed (now `expanded`). */
export interface ExpandSeedResult {
  seed: Seed;
  line: LineView;
  branch: BranchView;
  pack: BranchPack;
}

export interface SeedNoteResult {
  seed: Seed;
  note: Note;
  revision: number;
  rootLineId: string;
}

export interface SuggestionList {
  rootLineId: string;
  suggestions: Suggestion[];
}

/** Accept / dismiss; `result` is the feature's own answer to an accept, only when it sent one. */
export interface SuggestionWrite {
  suggestion: Suggestion;
  result?: Readonly<Record<string, JsonValue>>;
}

// Readers ----------------------------------------------------------------------

function jsonObject(raw: unknown): Readonly<Record<string, JsonValue>> {
  return isObject(raw) ? (raw as Readonly<Record<string, JsonValue>>) : {};
}

export function normalizeLeaf(raw: unknown): Leaf {
  const leaf = obj(raw);
  return {
    lineId: str(leaf.lineId),
    rootLineId: str(leaf.rootLineId),
    kind: oneOf(leaf.kind, LEAF_KINDS, "conclusion"),
    line: str(leaf.line),
    body: str(leaf.body),
    status: oneOf(leaf.status, LEAF_STATUSES, "confirmed"),
    aiDrafted: bool(leaf.aiDrafted),
    createdBy: str(leaf.createdBy),
    createdAt: str(leaf.createdAt),
    updatedAt: str(leaf.updatedAt),
  };
}

const DRAFT_ERROR_CODES = ["run_failed", "unusable", "timed_out", "failed"] as const;

/** `draftError` (B8.1); undefined when absent. */
export function normalizeLeafDraftError(raw: unknown): LeafDraftError | undefined {
  if (!isObject(raw)) return undefined;
  return { code: oneOf(raw.code, DRAFT_ERROR_CODES, "failed"), message: str(raw.message) };
}

/** `GET` / `PUT /leaf`: `{leaf: null}` when the branch has none; `draftError` only when the server sent it. */
export function normalizeLeafResult(raw: unknown): LeafResult {
  const body = obj(raw);
  const draftError = normalizeLeafDraftError(body.draftError);
  return { leaf: isObject(body.leaf) ? normalizeLeaf(body.leaf) : null, ...(draftError ? { draftError } : {}) };
}

export function normalizeSeed(raw: unknown): Seed {
  const seed = obj(raw);
  return {
    id: str(seed.id),
    rootLineId: str(seed.rootLineId),
    anchorMessageId: str(seed.anchorMessageId),
    anchorLineId: str(seed.anchorLineId),
    sourceLabel: str(seed.sourceLabel),
    text: str(seed.text),
    status: oneOf(seed.status, SEED_STATUSES, "open"),
    expandedLineId: str(seed.expandedLineId),
    noteId: str(seed.noteId),
    createdBy: str(seed.createdBy),
    createdAt: str(seed.createdAt),
    updatedAt: str(seed.updatedAt),
  };
}

export function normalizeSeedList(raw: unknown): SeedList {
  const body = obj(raw);
  const limits = obj(body.limits);
  return {
    rootLineId: str(body.rootLineId),
    seeds: list(body.seeds, normalizeSeed),
    limits: { maxOpen: num(limits.maxOpen, DEFAULT_SEED_LIMITS.maxOpen), maxRunes: num(limits.maxRunes, DEFAULT_SEED_LIMITS.maxRunes) },
  };
}

export function normalizeSeedWrite(raw: unknown): SeedWrite {
  return { seed: normalizeSeed(obj(raw).seed) };
}

export function normalizeExpandSeedResult(raw: unknown): ExpandSeedResult {
  const body = obj(raw);
  return { seed: normalizeSeed(body.seed), line: normalizeLine(body.line), branch: normalizeBranchView(body.branch), pack: normalizeBranchPack(body.pack) };
}

export function normalizeSeedNoteResult(raw: unknown): SeedNoteResult {
  const body = obj(raw);
  return { seed: normalizeSeed(body.seed), note: normalizeNote(body.note), revision: typeof body.revision === "number" ? body.revision : 0, rootLineId: str(body.rootLineId) };
}

export function normalizeSuggestion(raw: unknown): Suggestion {
  const suggestion = obj(raw);
  return {
    id: str(suggestion.id),
    rootLineId: str(suggestion.rootLineId),
    lineId: str(suggestion.lineId),
    feature: str(suggestion.feature),
    kind: str(suggestion.kind),
    targetKey: str(suggestion.targetKey),
    payload: jsonObject(suggestion.payload),
    status: oneOf(suggestion.status, SUGGESTION_STATUSES, "open"),
    createdAt: str(suggestion.createdAt),
    decidedAt: nullableStr(suggestion.decidedAt),
  };
}

export function normalizeSuggestionList(raw: unknown): SuggestionList {
  const body = obj(raw);
  return { rootLineId: str(body.rootLineId), suggestions: list(body.suggestions, normalizeSuggestion) };
}

export function normalizeSuggestionWrite(raw: unknown): SuggestionWrite {
  const body = obj(raw);
  return { suggestion: normalizeSuggestion(body.suggestion), ...(isObject(body.result) ? { result: jsonObject(body.result) } : {}) };
}
