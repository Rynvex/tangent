import { describe, expect, it } from "vitest";
import { normalizeDelta, normalizeLine, normalizeMessage, normalizePrompt, normalizeSummary } from "./line-normalize";

describe("normalizeLine (review H1)", () => {
  it("fills a line whose summary lists and branch fields are null", () => {
    const line = normalizeLine({
      id: "l1",
      status: "thinking",
      summary: { topic: "t", decisions: null, openQuestions: null, files: null, suggestedLandings: null },
      conversationBranch: { parentLineId: "p", rootLineId: "r", kind: "alternative", status: "merged", origin: "move", depth: 2 },
      branchCounts: null,
      hostMeta: { a: 1 },
      archivedAt: null,
    });
    expect(line.summary).toEqual({ topic: "t", decisions: [], openQuestions: [], files: [], suggestedLandings: [], updatedAt: "" });
    expect(line.conversationBranch).toMatchObject({ parentLineId: "p", kind: "alternative", status: "merged", origin: "move", depth: 2 });
    expect(line.branchCounts).toEqual({ open: 0, merged: 0, discarded: 0, promoted: 0 });
    expect(line).toMatchObject({ status: "thinking", hostMeta: { a: 1 }, archivedAt: null });
  });

  it("defaults an unknown status and a missing host meta", () => {
    expect(normalizeLine({ status: "awaiting_input" })).toMatchObject({ status: "idle", hostMeta: {}, conversationBranch: null });
    expect(normalizeSummary(undefined).decisions).toEqual([]);
  });
});

describe("normalizeMessage", () => {
  it("keeps valid meta fields only and fills a null card's lists", () => {
    const message = normalizeMessage({
      id: "m",
      seq: 7,
      role: "assistant",
      kind: "branch_card",
      status: "done",
      meta: { card: { question: "q", evidence: null }, deliversCards: null, suggestions: [{ purpose: "p", kind: "odd" }], usage: { inputTokens: 3 }, delivered: "yes" },
    });
    expect(message).toMatchObject({ id: "m", seq: 7, role: "assistant", kind: "branch_card" });
    expect(message.meta.card?.evidence).toEqual([]);
    expect(message.meta.suggestions).toEqual([{ purpose: "p", kind: "investigate" }]);
    expect(message.meta.usage).toEqual({ inputTokens: 3, outputTokens: 0, costUsd: 0 });
    expect("deliversCards" in message.meta).toBe(false);
    expect("delivered" in message.meta).toBe(false);
  });

  it("maps the old agent role to system rather than trusting it", () => {
    expect(normalizeMessage({ role: "agent", kind: "proposal", meta: null })).toMatchObject({ role: "system", kind: "chat", meta: {} });
  });
});

describe("deltas and prompts", () => {
  it("normalizes both", () => {
    expect(normalizeDelta({ turnId: "t", seq: "1", kind: "reasoning", text: "x" })).toEqual({ turnId: "t", seq: 0, kind: "reasoning", text: "x" });
    expect(normalizePrompt({ sections: null, history: null, summary: null })).toMatchObject({ sections: [], history: [], summary: null });
  });
});
