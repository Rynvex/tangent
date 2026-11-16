/**
 * Pure logic of cross-conversation memory on screen (D1): reading the two
 * memory suggestions and each memory's replaced versions.
 */
import { MEMORY_KINDS, normalizeMemory, type Memory, type MemoryKind, type MemorySource } from "./memory-routes";
import type { Suggestion } from "./types";
import { count, obj, oneOf, str, strings } from "./wire";

export interface MemoryProposal {
  action: "add" | "update";
  kind: MemoryKind;
  text: string;
  importance: number;
  /** The memory an `update` replaces; "" for `add`. */
  targetMemoryId: string;
  source: MemorySource;
}

/** A `memory` suggestion's payload; null for any other suggestion. */
export function memorySuggestionOf(suggestion: Pick<Suggestion, "feature" | "kind" | "payload">): MemoryProposal | null {
  if (suggestion.feature !== "memory" || suggestion.kind !== "memory") return null;
  const payload = obj(suggestion.payload);
  const memory = normalizeMemory({ source: payload.source });
  return {
    action: payload.action === "update" ? "update" : "add",
    kind: oneOf(payload.kind, MEMORY_KINDS, "fact"),
    text: str(payload.text),
    importance: count(payload.importance),
    targetMemoryId: str(payload.targetMemoryId),
    source: memory.source,
  };
}

export interface ConsolidateProposal {
  /** `merge`: they say the same; `conflict`: they disagree (always the user's call). */
  action: "merge" | "conflict";
  /** The older first. */
  memoryIds: string[];
  texts: string[];
  kind: MemoryKind;
  text: string;
  importance: number;
  reason: string;
}

/** A `memory_consolidate` suggestion's payload; null for any other suggestion. */
export function consolidateSuggestionOf(suggestion: Pick<Suggestion, "feature" | "kind" | "payload">): ConsolidateProposal | null {
  if (suggestion.feature !== "memory" || suggestion.kind !== "memory_consolidate") return null;
  const payload = obj(suggestion.payload);
  return {
    action: payload.action === "conflict" ? "conflict" : "merge",
    memoryIds: strings(payload.memoryIds),
    texts: strings(payload.texts),
    kind: oneOf(payload.kind, MEMORY_KINDS, "fact"),
    text: str(payload.text),
    importance: count(payload.importance),
    reason: str(payload.reason),
  };
}

/** Each memory's replaced versions (following `supersededBy`), newest first; only memories that replaced something have an entry. */
export function memoryHistory(memories: readonly Memory[]): Map<string, Memory[]> {
  const byReplacer = new Map<string, Memory[]>();
  for (const memory of memories) {
    if (!memory.supersededBy) continue;
    byReplacer.set(memory.supersededBy, [...(byReplacer.get(memory.supersededBy) ?? []), memory]);
  }
  const chain = (id: string, seen: Set<string>): Memory[] =>
    (byReplacer.get(id) ?? []).filter((memory) => !seen.has(memory.id)).flatMap((memory) => [memory, ...chain(memory.id, new Set([...seen, memory.id]))]);
  const history = new Map<string, Memory[]>();
  for (const memory of memories) {
    if (memory.status !== "active") continue;
    const older = chain(memory.id, new Set([memory.id])).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (older.length > 0) history.set(memory.id, older);
  }
  return history;
}
