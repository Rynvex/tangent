/**
 * Cross-conversation memory (B10 phase C, the memory feature; D1): what the
 * tenant learned, with its source; never deleted, replaced instead. Shapes
 * of `/memories`, `POST /memories/search`, `memory.changed` and the
 * preview's recalled memories. Input is untrusted JSON.
 */
import { bool, count, isObject, list, nullableStr, num, obj, oneOf, str } from "./wire";

export const MEMORY_KINDS = ["fact", "decision", "preference", "lesson"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_STATUSES = ["active", "superseded"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Where a memory came from; every field may be "" (no foreign keys: the label stays when the source is gone). */
export interface MemorySource {
  lineId: string;
  messageId: string;
  leafLineId: string;
  noteId: string;
  label: string;
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  /** One line, ≤ 500 characters. */
  text: string;
  status: MemoryStatus;
  /** "" while active. */
  supersededBy: string;
  /** 1–10. */
  importance: number;
  /** After it, the memory is no longer recalled (still readable). */
  validUntil: string | null;
  source: MemorySource;
  /** From extraction or consolidation and not rewritten by the user. */
  aiDrafted: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryLimits {
  textMaxRunes: number;
  topK: number;
  searchMax: number;
}

/** domain.DefaultLimits().Memory, for servers that leave `limits` out. */
export const DEFAULT_MEMORY_LIMITS: MemoryLimits = { textMaxRunes: 500, topK: 5, searchMax: 20 };
export const MEMORY_IMPORTANCE = { min: 1, max: 10, default: 5 } as const;

export interface MemoryList {
  /** Newest first (createdAt, then id). */
  memories: Memory[];
  /** The next page's `cursor` (B10.1); "" on the last page. */
  nextCursor: string;
  limits: MemoryLimits;
}

/** A memory recalled for a query: `score` = relevance × recency × importance. */
export interface RecalledMemory {
  memory: Memory;
  similarity: number;
  score: number;
}

export interface MemorySearchResult {
  query: string;
  results: RecalledMemory[];
}

/** The new memory and the ones it replaced. */
export interface SupersedeResult {
  memory: Memory;
  superseded: Memory[];
}

export interface MemoryListQuery {
  kind?: MemoryKind;
  status?: MemoryStatus | "all";
  /** 1–200, default 100. */
  limit?: number;
  /** The previous page's `nextCursor`, with the same kind and status. */
  cursor?: string;
}

export interface CreateMemoryInput {
  kind: MemoryKind;
  text: string;
  importance?: number;
  validUntil?: string;
  sourceLineId?: string;
}

/** Only the category, importance and expiry: the text changes by superseding. */
export interface UpdateMemoryInput {
  kind?: MemoryKind;
  importance?: number;
  /** null clears it. */
  validUntil?: string | null;
}

export interface SupersedeMemoryInput {
  text: string;
  kind?: MemoryKind;
  importance?: number;
  validUntil?: string;
}

export interface SearchMemoriesInput {
  query: string;
  /** Default 5, at most 20. */
  limit?: number;
}

function normalizeSource(raw: unknown): MemorySource {
  const source = obj(raw);
  return { lineId: str(source.lineId), messageId: str(source.messageId), leafLineId: str(source.leafLineId), noteId: str(source.noteId), label: str(source.label) };
}

export function normalizeMemory(raw: unknown): Memory {
  const memory = obj(raw);
  const importance = count(memory.importance);
  return {
    id: str(memory.id),
    kind: oneOf(memory.kind, MEMORY_KINDS, "fact"),
    text: str(memory.text),
    status: oneOf(memory.status, MEMORY_STATUSES, "active"),
    supersededBy: str(memory.supersededBy),
    importance: Math.min(MEMORY_IMPORTANCE.max, Math.max(typeof memory.importance === "number" ? MEMORY_IMPORTANCE.min : MEMORY_IMPORTANCE.default, importance || MEMORY_IMPORTANCE.default)),
    validUntil: nullableStr(memory.validUntil),
    source: normalizeSource(memory.source),
    aiDrafted: bool(memory.aiDrafted),
    createdBy: str(memory.createdBy),
    createdAt: str(memory.createdAt),
    updatedAt: str(memory.updatedAt),
  };
}

export function normalizeMemoryList(raw: unknown): MemoryList {
  const body = obj(raw);
  const limits = obj(body.limits);
  const value = (key: keyof MemoryLimits) => (typeof limits[key] === "number" ? count(limits[key]) : DEFAULT_MEMORY_LIMITS[key]);
  return {
    memories: list(body.memories, normalizeMemory),
    nextCursor: str(body.nextCursor),
    limits: { textMaxRunes: value("textMaxRunes"), topK: value("topK"), searchMax: value("searchMax") },
  };
}

export function normalizeRecalledMemory(raw: unknown): RecalledMemory {
  const item = obj(raw);
  return { memory: normalizeMemory(item.memory), similarity: num(item.similarity), score: num(item.score) };
}

export function normalizeMemorySearch(raw: unknown): MemorySearchResult {
  const body = obj(raw);
  return { query: str(body.query), results: list(body.results, normalizeRecalledMemory) };
}

export function normalizeMemoryResult(raw: unknown): { memory: Memory } {
  return { memory: normalizeMemory(obj(raw).memory) };
}

export function normalizeSupersedeResult(raw: unknown): SupersedeResult {
  const body = obj(raw);
  return { memory: normalizeMemory(body.memory), superseded: list(body.superseded, normalizeMemory) };
}

/** `memory.changed` data (the envelope's line ids are "": memories belong to the tenant). */
export type MemoryChanged = SupersedeResult;

export const normalizeMemoryChanged = (raw: unknown): MemoryChanged => (isObject(raw) ? normalizeSupersedeResult(raw) : normalizeSupersedeResult({}));
