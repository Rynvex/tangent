import { describe, expect, it } from "vitest";
import { normalizeFold } from "./fold-routes";
import { canTag, foldEndOptions, foldSpans, foldSuggestionOf, TAG_KINDS } from "./folds";
import { normalizeMessage } from "./line-normalize";
import type { Suggestion } from "./types";

const message = (id: string, seq: number, over: Record<string, unknown> = {}) => normalizeMessage({ id, seq, role: seq % 2 ? "user" : "assistant", kind: "chat", status: "done", ...over });
const MESSAGES = [1, 2, 3, 4, 5, 6, 7].map((seq) => message(`m${seq}`, seq));

describe("folds on screen (D4)", () => {
  it("groups the messages each live fold covers by seq; removed folds and other lines are left out", () => {
    const folds = [
      normalizeFold({ id: "a", lineId: "l", fromSeq: 2, toSeq: 4, status: "active" }),
      normalizeFold({ id: "b", lineId: "l", fromSeq: 6, toSeq: 7, status: "drafting" }),
      normalizeFold({ id: "c", lineId: "l", fromSeq: 1, toSeq: 1, status: "removed" }),
      normalizeFold({ id: "d", lineId: "other", fromSeq: 5, toSeq: 5, status: "active" }),
    ];
    const spans = foldSpans(MESSAGES, folds, "l");
    expect([...spans.byFirst.entries()].map(([first, span]) => [first, span.fold.id, span.messages.map((item) => item.id)])).toEqual([
      ["m2", "a", ["m2", "m3", "m4"]],
      ["m6", "b", ["m6", "m7"]],
    ]);
    expect([...spans.covered].sort()).toEqual(["m2", "m3", "m4", "m6", "m7"]);
  });

  it("a fold ends at a later finished chat message of the line", () => {
    const messages = [...MESSAGES, message("p", 8, { status: "pending" }), message("card", 9, { kind: "branch_card" })];
    expect(foldEndOptions(messages, "m5").map((item) => item.id)).toEqual(["m6", "m7"]);
    expect(foldEndOptions(messages, "nope")).toEqual([]);
  });

  it("reads a fold suggestion; anything else is null", () => {
    const suggestion = { id: "s", feature: "fold", kind: "fold", payload: { fromMessageId: "m1", toMessageId: "m4", fromSeq: 1, toSeq: 4, title: "需求", summary: "S", messageCount: 4, tokensOriginal: 4200, tokensSummary: 180, jobId: "j" } } as unknown as Suggestion;
    expect(foldSuggestionOf(suggestion)).toEqual({ fromMessageId: "m1", toMessageId: "m4", fromSeq: 1, toSeq: 4, title: "需求", summary: "S", messageCount: 4, tokensOriginal: 4200, tokensSummary: 180, saved: 4020 });
    expect(foldSuggestionOf({ ...suggestion, feature: "goal" })).toBeNull();
  });
});

describe("argument tags (D2)", () => {
  it("has five kinds in the design's order", () => {
    expect(TAG_KINDS).toEqual(["question", "idea", "pro", "con", "decision"]);
  });

  it("only finished user and assistant chat messages can be tagged (not cards, not pending)", () => {
    expect(canTag(message("a", 1))).toBe(true);
    expect(canTag(message("b", 2, { status: "pending" }))).toBe(false);
    expect(canTag(message("c", 3, { kind: "branch_card" }))).toBe(false);
    expect(canTag(message("d", 4, { role: "system" }))).toBe(false);
  });
});
