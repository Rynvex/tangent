import { describe, expect, it } from "vitest";
import { parseEvent } from "./events";
import { consolidateSuggestionOf, memoryHistory, memorySuggestionOf } from "./memory";
import { DEFAULT_MEMORY_LIMITS, normalizeMemory, normalizeMemoryList, normalizeMemorySearch, normalizeSupersedeResult } from "./memory-routes";
import { normalizePreviewResult } from "./result-normalize";
import type { Suggestion } from "./types";

describe("B10 phase C shapes: memories", () => {
  it("reads a memory with its defaults; an unknown kind is a fact, importance stays 1–10", () => {
    expect(normalizeMemory({ id: "m", kind: "weird", importance: 99, status: "weird" })).toEqual({
      id: "m",
      kind: "fact",
      text: "",
      status: "active",
      supersededBy: "",
      importance: 10,
      validUntil: null,
      source: { lineId: "", messageId: "", leafLineId: "", noteId: "", label: "" },
      aiDrafted: false,
      createdBy: "",
      createdAt: "",
      updatedAt: "",
    });
  });

  it("fills the list's limits; reads search results, supersedes and the preview's recalled memories", () => {
    expect(normalizeMemoryList({}).limits).toEqual(DEFAULT_MEMORY_LIMITS);
    expect(normalizeMemoryList({}).nextCursor).toBe("");
    expect(normalizeMemoryList({ memories: [], nextCursor: 7 }).nextCursor).toBe("");
    expect(normalizeMemoryList({ memories: [], nextCursor: "c" }).nextCursor).toBe("c");
    expect(normalizeMemorySearch({ query: "q", results: [{ memory: { id: "m" }, similarity: 0.5, score: 0.45 }] }).results[0]).toMatchObject({ memory: { id: "m" }, similarity: 0.5, score: 0.45 });
    expect(normalizeSupersedeResult({ memory: { id: "n" }, superseded: [{ id: "o", status: "superseded", supersededBy: "n" }] }).superseded[0]).toMatchObject({ status: "superseded", supersededBy: "n" });
    expect("memories" in normalizePreviewResult({})).toBe(false);
    expect(normalizePreviewResult({ memories: [{ memory: { id: "m", kind: "lesson" }, similarity: 1, score: 1 }] }).memories?.[0]?.memory.kind).toBe("lesson");
  });

  it("B7.1: a host section marked for the tail keeps `trailing: true`; others have no such key", () => {
    const preview = normalizePreviewResult({ prompt: { sections: [{ key: "host", title: "", body: "b" }], trailing: [{ key: "late", title: "", body: "t", trailing: true }] } });
    expect(preview.prompt.trailing?.[0]).toEqual({ key: "late", title: "", body: "t", trailing: true });
    expect("trailing" in preview.prompt.sections[0]!).toBe(false);
  });

  it("parses memory.changed (a tenant's, with empty line ids)", () => {
    const event = parseEvent("memory.changed", JSON.stringify({ type: "memory.changed", tenant: "t", lineId: "", rootLineId: "", data: { memory: { id: "m" }, superseded: [] } }));
    expect(event).toMatchObject({ type: "memory.changed", data: { memory: { id: "m" }, superseded: [] } });
  });
});

describe("memories on screen (D1)", () => {
  const suggestion = (feature: string, kind: string, payload: Record<string, unknown>) => ({ id: "s", feature, kind, payload }) as unknown as Suggestion;

  it("reads a memory suggestion and a consolidation; anything else is null", () => {
    expect(memorySuggestionOf(suggestion("memory", "memory", { action: "add", kind: "fact", text: "T", importance: 6, source: { label: "Disks" } }))).toMatchObject({ action: "add", kind: "fact", text: "T", importance: 6, targetMemoryId: "", source: { label: "Disks" } });
    expect(consolidateSuggestionOf(suggestion("memory", "memory_consolidate", { action: "conflict", memoryIds: ["a", "b"], texts: ["x", "y"], kind: "fact", text: "both", importance: 5, reason: "r" }))).toMatchObject({ action: "conflict", memoryIds: ["a", "b"], texts: ["x", "y"], text: "both" });
    expect(memorySuggestionOf(suggestion("goal", "goal_propose", {}))).toBeNull();
    expect(consolidateSuggestionOf(suggestion("memory", "memory", {}))).toBeNull();
  });

  it("puts each memory's replaced versions under it, newest first", () => {
    const memories = [
      normalizeMemory({ id: "c", status: "active", updatedAt: "3" }),
      normalizeMemory({ id: "b", status: "superseded", supersededBy: "c", updatedAt: "2" }),
      normalizeMemory({ id: "a", status: "superseded", supersededBy: "b", updatedAt: "1" }),
      normalizeMemory({ id: "x", status: "active" }),
    ];
    const history = memoryHistory(memories);
    expect(history.get("c")?.map((memory) => memory.id)).toEqual(["b", "a"]);
    expect(history.get("x")).toBeUndefined();
  });
});
