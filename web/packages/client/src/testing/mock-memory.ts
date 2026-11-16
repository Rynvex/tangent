/**
 * Simulated cross-conversation memory (B10 phase C): the tenant's memories,
 * superseding, search and each turn's recall like runner/fake's Embedder
 * (the same tokens and FNV hashing, so the same cosines), and the extraction
 * suggestion like the fake runner ("Remembered: …"). Test-only simplifications: no consolidation
 * loop (an accepted consolidation is still carried out), recency counts the
 * same for every memory.
 */
import { isFeatureOn, featureMode } from "../capabilities";
import { TangentError } from "../errors";
import {
  DEFAULT_MEMORY_LIMITS,
  MEMORY_IMPORTANCE,
  MEMORY_KINDS,
  type CreateMemoryInput,
  type Memory,
  type MemoryKind,
  type MemoryList,
  type MemoryListQuery,
  type MemorySearchResult,
  type MemorySource,
  type RecalledMemory,
  type SearchMemoriesInput,
  type SupersedeMemoryInput,
  type SupersedeResult,
  type UpdateMemoryInput,
} from "../memory-routes";
import type { Suggestion } from "../types";
import { type MockContext } from "./mock-context";
import { findLine, newId } from "./mock-store";

/** domain `Limits.Memory.MinSimilarityPct`: below it nothing is recalled. */
const MIN_SIMILARITY = 0.3;
const IMPORTANCE_WEIGHT = 20;
const RECALL_SECTION = "## Remembered from earlier conversations";
const EXTRACT_IMPORTANCE = 6;
/** GET /memories `limit`: default and most. */
const LIST_DEFAULT = 100;
const LIST_MAX = 200;

/** runner/fake `DefaultEmbeddingDim`. */
const EMBEDDING_DIM = 256;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/** The scripts runner/fake splits into single characters. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** unicode.IsLetter or unicode.IsDigit. */
const WORD_CHAR = /[\p{L}\p{Nd}]/u;
const encoder = new TextEncoder();

/** runner/fake `tokens`: words (letters and digits, case folded) and each Han, kana or hangul character. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const char of text.toLowerCase()) {
    if (CJK.test(char) || !WORD_CHAR.test(char)) {
      if (word) out.push(word);
      word = "";
      if (CJK.test(char)) out.push(char);
    } else {
      word += char;
    }
  }
  if (word) out.push(word);
  return out;
}

/** FNV-1a (32 bit) of the token's UTF-8 bytes, as Go's hash/fnv. */
function fnv32a(token: string): number {
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(token)) hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  return hash;
}

/** runner/fake `vector`: token counts hashed onto 256 dimensions, as a unit vector (never zero). */
function embed(text: string): number[] {
  const counts = tokens(text).reduce((vector, token) => {
    const at = fnv32a(token) % EMBEDDING_DIM;
    return vector.map((value, index) => (index === at ? value + 1 : value));
  }, new Array<number>(EMBEDDING_DIM).fill(0));
  const norm = Math.sqrt(counts.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return counts.map((_, index) => (index === EMBEDDING_DIM - 1 ? 1 : 0));
  return counts.map((value) => value / norm);
}

/** Cosine of two unit vectors. */
function similarity(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index]!, 0);
}

export interface MockMemory {
  list(query: MemoryListQuery): MemoryList;
  create(input: CreateMemoryInput): { memory: Memory };
  update(memoryId: string, input: UpdateMemoryInput): { memory: Memory };
  supersede(memoryId: string, input: SupersedeMemoryInput): SupersedeResult;
  search(input: SearchMemoriesInput): MemorySearchResult;
  /** Each turn's recall for the preview (feature on): the results, or none. */
  recall(query: string): RecalledMemory[];
  /** The trailing block those results make. */
  recallBlock(results: readonly RecalledMemory[]): string;
  /** A branch's ending or a card's conclusion was written (suggest / auto): the extraction. */
  afterSource(lineId: string, line: string): void;
  act(suggestion: Suggestion, body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null;
}

export interface MockMemoryDeps {
  propose(suggestion: Omit<Suggestion, "id" | "status" | "createdAt" | "decidedAt">): void;
}

export function createMockMemory(ctx: MockContext, deps: MockMemoryDeps): MockMemory {
  const state = ctx.state;
  const on = () => isFeatureOn(ctx.scenario.capabilities, "memory");

  function require(): void {
    if (!on()) throw new TangentError(404, "the memory feature is off", "feature_disabled", { feature: "memory" });
  }
  const invalid = (why: string) => new TangentError(422, why, "invalid_memory");

  function checkFields(kind: unknown, text: string | undefined, importance: number | undefined): void {
    if (kind !== undefined && !(MEMORY_KINDS as readonly unknown[]).includes(kind)) throw invalid("unknown kind");
    if (text !== undefined) {
      if (text.trim() === "") throw invalid("the text is empty");
      if (Array.from(text.trim()).length > DEFAULT_MEMORY_LIMITS.textMaxRunes) throw new TangentError(422, "the text is too long", "too_long", { field: "text", max: DEFAULT_MEMORY_LIMITS.textMaxRunes });
    }
    if (importance !== undefined && (!Number.isInteger(importance) || importance < MEMORY_IMPORTANCE.min || importance > MEMORY_IMPORTANCE.max)) throw invalid("importance is 1–10");
  }

  /** Changed memories keep their place (the list stays oldest first by creation); new ones go last. */
  function save(memory: Memory, superseded: Memory[] = []): Memory {
    const changed = new Map([memory, ...superseded].map((item) => [item.id, item]));
    const kept = state().memories.map((item) => changed.get(item.id) ?? item);
    const added = [...changed.values()].filter((item) => !state().memories.some((old) => old.id === item.id));
    ctx.commit({ ...state(), memories: [...kept, ...added] });
    ctx.bus.publish("memory.changed", { lineId: "", rootLineId: "" }, { memory, superseded });
    return memory;
  }

  function find(memoryId: string): Memory {
    const memory = state().memories.find((item) => item.id === memoryId);
    if (!memory) throw new TangentError(404, "memory not found", "memory_not_found");
    return memory;
  }

  function sourceOf(lineId: string | undefined): MemorySource {
    if (!lineId) return { lineId: "", messageId: "", leafLineId: "", noteId: "", label: "" };
    const line = findLine(state(), lineId);
    return { lineId, messageId: "", leafLineId: "", noteId: "", label: line.title || line.conversationBranch?.purpose || "" };
  }

  function make(fields: { kind: MemoryKind; text: string; importance: number; validUntil: string | null; source: MemorySource; aiDrafted: boolean }): Memory {
    const [id, next] = newId(state(), "memory");
    ctx.commit(next);
    const now = ctx.now();
    return { id, ...fields, text: fields.text.trim(), status: "active", supersededBy: "", createdBy: "mock-user", createdAt: now, updatedAt: now };
  }

  function replace(old: Memory, input: SupersedeMemoryInput, aiDrafted = false): SupersedeResult {
    if (old.status === "superseded") throw new TangentError(409, "the memory was superseded", "memory_superseded");
    const memory = make({
      kind: input.kind ?? old.kind,
      text: input.text,
      importance: input.importance ?? old.importance,
      validUntil: input.validUntil ?? old.validUntil,
      source: old.source,
      aiDrafted,
    });
    const superseded = [{ ...old, status: "superseded" as const, supersededBy: memory.id, updatedAt: ctx.now() }];
    save(memory, superseded);
    return { memory, superseded };
  }

  function search(query: string, limit: number): RecalledMemory[] {
    const wanted = embed(query);
    const now = ctx.now();
    return state()
      .memories.filter((memory) => memory.status === "active" && (!memory.validUntil || memory.validUntil > now))
      .map((memory) => {
        const similar = similarity(wanted, embed(memory.text));
        return { memory, similarity: similar, score: similar * (0.5 + memory.importance / IMPORTANCE_WEIGHT) };
      })
      .filter((item) => item.similarity >= MIN_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return {
    list(query) {
      require();
      const status = query.status ?? "active";
      const newest = [...state().memories].reverse();
      const picked = newest.filter((memory) => (status === "all" || memory.status === status) && (!query.kind || memory.kind === query.kind));
      // The cursor is the last memory of the previous page (opaque to callers; memories are never deleted).
      const after = query.cursor ? newest.findIndex((memory) => memory.id === query.cursor) : -1;
      if (query.cursor && after < 0) throw new TangentError(400, "cursor is not valid", "invalid_input");
      const rest = after < 0 ? picked : picked.filter((memory) => newest.indexOf(memory) > after);
      const limit = Math.min(Math.max(query.limit ?? LIST_DEFAULT, 1), LIST_MAX);
      const page = rest.slice(0, limit);
      return { memories: page, nextCursor: rest.length > limit ? page[page.length - 1]!.id : "", limits: DEFAULT_MEMORY_LIMITS };
    },
    create(input) {
      require();
      checkFields(input.kind, input.text, input.importance);
      const memory = make({ kind: input.kind, text: input.text, importance: input.importance ?? MEMORY_IMPORTANCE.default, validUntil: input.validUntil ?? null, source: sourceOf(input.sourceLineId), aiDrafted: false });
      return { memory: save(memory) };
    },
    update(memoryId, input) {
      require();
      const memory = find(memoryId);
      if (memory.status === "superseded") throw new TangentError(409, "the memory was superseded", "memory_superseded");
      checkFields(input.kind, undefined, input.importance);
      const changed: Memory = {
        ...memory,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.importance !== undefined ? { importance: input.importance } : {}),
        ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
        updatedAt: ctx.now(),
      };
      return { memory: save(changed) };
    },
    supersede(memoryId, input) {
      require();
      checkFields(input.kind, input.text, input.importance);
      return replace(find(memoryId), input);
    },
    search(input) {
      require();
      if (input.query.trim() === "") throw new TangentError(400, "the query is empty", "invalid_input");
      return { query: input.query, results: search(input.query, Math.min(input.limit ?? DEFAULT_MEMORY_LIMITS.topK, DEFAULT_MEMORY_LIMITS.searchMax)) };
    },
    recall: (query) => (on() && query.trim() ? search(query, DEFAULT_MEMORY_LIMITS.topK) : []),
    recallBlock: (results) => `${RECALL_SECTION}\n\n${results.map((item) => `> [${item.memory.kind}] ${item.memory.text}${item.memory.source.label ? ` (from: ${item.memory.source.label})` : ""}`).join("\n")}`,
    afterSource(lineId, line) {
      if (!on() || !line.trim()) return;
      const mode = featureMode(ctx.scenario.capabilities, "memory");
      if (mode !== "suggest" && mode !== "auto") return;
      const [jobId, next] = newId(state(), "job");
      ctx.commit(next);
      const first = line.split("\n")[0]!.trim();
      const source = { ...sourceOf(lineId), leafLineId: lineId };
      ctx.timers.setTimeout(() => {
        deps.propose({
          rootLineId: findLine(state(), lineId).conversationBranch?.rootLineId ?? lineId,
          lineId,
          feature: "memory",
          kind: "memory",
          targetKey: `memory:${jobId}:0`,
          payload: { action: "add", kind: "fact", text: `Remembered: ${first} (fake runner)`, importance: EXTRACT_IMPORTANCE, source: { ...source }, jobId },
        });
      }, ctx.draftMs);
    },
    act(suggestion, body) {
      if (suggestion.feature !== "memory") return null;
      const payload = suggestion.payload as { action?: string; kind?: MemoryKind; text?: string; importance?: number; targetMemoryId?: string; source?: MemorySource; memoryIds?: string[] };
      const text = typeof body.text === "string" && body.text.trim() ? body.text : (payload.text ?? "");
      const edited = text.trim() !== (payload.text ?? "").trim();
      const kind = (typeof body.kind === "string" ? body.kind : payload.kind) as MemoryKind;
      const importance = typeof body.importance === "number" ? body.importance : (payload.importance ?? MEMORY_IMPORTANCE.default);
      checkFields(kind, text, importance);
      if (suggestion.kind === "memory_consolidate") {
        const olds = (payload.memoryIds ?? []).map(find);
        if (olds.some((old) => old.status === "superseded")) throw new TangentError(409, "the memory was superseded", "memory_superseded");
        const memory = make({ kind, text, importance, validUntil: null, source: olds[0]?.source ?? sourceOf(undefined), aiDrafted: !edited });
        const superseded = olds.map((old) => ({ ...old, status: "superseded" as const, supersededBy: memory.id, updatedAt: ctx.now() }));
        save(memory, superseded);
        return { memory, superseded };
      }
      if (payload.action === "update" && payload.targetMemoryId) return { ...replace(find(payload.targetMemoryId), { text, kind, importance }, !edited) };
      const memory = save(make({ kind, text, importance, validUntil: null, source: payload.source ?? sourceOf(suggestion.lineId), aiDrafted: !edited }));
      return { memory, superseded: [] };
    },
  };
}
