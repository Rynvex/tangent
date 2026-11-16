import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { normalizeLine } from "./line-normalize";
import {
  normalizeExpandSeedResult,
  normalizeLeaf,
  normalizeLeafResult,
  normalizeSeed,
  normalizeSeedList,
  normalizeSuggestion,
  normalizeSuggestionList,
  normalizeSuggestionWrite,
} from "./p1-routes";

describe("leaf normalizers (B8)", () => {
  it("keeps a failed draft's reason only when sent (B8.1)", () => {
    expect(normalizeLeafResult({ leaf: null })).not.toHaveProperty("draftError");
    expect(normalizeLeafResult({ leaf: null, draftError: { code: "nope", message: "m" } }).draftError).toEqual({ code: "failed", message: "m" });
  });

  it("reads GET /leaf with no leaf as null", () => {
    expect(normalizeLeafResult({ leaf: null })).toEqual({ leaf: null });
    expect(normalizeLeafResult({})).toEqual({ leaf: null });
  });

  it("defaults every field and falls back to conclusion / confirmed for unknown values", () => {
    const leaf = normalizeLeaf({ kind: "maybe", line: "x", status: "weird" });
    expect(leaf).toEqual({
      lineId: "",
      rootLineId: "",
      kind: "conclusion",
      line: "x",
      body: "",
      status: "confirmed",
      aiDrafted: false,
      createdBy: "",
      createdAt: "",
      updatedAt: "",
    });
    expect(normalizeLeaf({ kind: "dead_end", status: "draft", aiDrafted: true }).status).toBe("draft");
  });

  it("puts the leaf summary on a BranchView, null when absent", () => {
    expect(normalizeBranchView({}).leaf).toBeNull();
    expect(normalizeBranchView({ leaf: { kind: "dead_end", line: "Too expensive", status: "confirmed", extra: 1 } }).leaf).toEqual({ kind: "dead_end", line: "Too expensive", status: "confirmed" });
  });

  it("accepts the seed origin on a branch", () => {
    expect(normalizeBranchView({ origin: "seed" }).origin).toBe("seed");
  });
});

describe("line inbox counts (B8)", () => {
  it("reads openSeeds and openSuggestions, 0 when absent", () => {
    expect(normalizeLine({}).openSeeds).toBe(0);
    expect(normalizeLine({ openSeeds: 3, openSuggestions: 1 })).toMatchObject({ openSeeds: 3, openSuggestions: 1 });
  });
});

describe("seed normalizers (B8)", () => {
  it("fills a seed and keeps unknown statuses out", () => {
    expect(normalizeSeed({ id: "s1", text: "UPS?", status: "gone" })).toEqual({
      id: "s1",
      rootLineId: "",
      anchorMessageId: "",
      anchorLineId: "",
      sourceLabel: "",
      text: "UPS?",
      status: "open",
      expandedLineId: "",
      noteId: "",
      createdBy: "",
      createdAt: "",
      updatedAt: "",
    });
  });

  it("reads a list with a null seeds array as empty, and the limits with defaults (B8.1)", () => {
    expect(normalizeSeedList({ rootLineId: "r", seeds: null })).toEqual({ rootLineId: "r", seeds: [], limits: { maxOpen: 100, maxRunes: 500 } });
    expect(normalizeSeedList({ limits: { maxOpen: 3, maxRunes: 50 } }).limits).toEqual({ maxOpen: 3, maxRunes: 50 });
  });

  it("reads an expansion like a created branch plus the seed", () => {
    const result = normalizeExpandSeedResult({ seed: { id: "s", status: "expanded" }, branch: { origin: "seed" }, line: { id: "b" }, pack: {} });
    expect(result.seed.status).toBe("expanded");
    expect(result.branch.origin).toBe("seed");
    expect(result.line.id).toBe("b");
    expect(result.pack.tokenEstimate).toBe(0);
  });
});

describe("suggestion normalizers (B8)", () => {
  it("keeps the feature's payload as sent and decidedAt as null while open", () => {
    const suggestion = normalizeSuggestion({ id: "g", kind: "probe", status: "open", decidedAt: null, payload: { reason: "r", n: 2 } });
    expect(suggestion.payload).toEqual({ reason: "r", n: 2 });
    expect(suggestion.decidedAt).toBeNull();
    expect(normalizeSuggestion({ payload: "nope" }).payload).toEqual({});
  });

  it("keeps an accept result only when the server sent one", () => {
    expect(normalizeSuggestionWrite({ suggestion: { id: "g" } })).not.toHaveProperty("result");
    expect(normalizeSuggestionWrite({ suggestion: { id: "g" }, result: { accepted: true } }).result).toEqual({ accepted: true });
  });

  it("reads a list", () => {
    expect(normalizeSuggestionList({ rootLineId: "r", suggestions: [{ id: "g", status: "expired" }] }).suggestions[0]?.status).toBe("expired");
  });
});
