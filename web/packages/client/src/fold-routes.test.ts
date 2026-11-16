import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { parseEvent } from "./events";
import { DEFAULT_FOLD_LIMITS, normalizeAppliedFold, normalizeFold, normalizeFoldCreated, normalizeFoldList } from "./fold-routes";
import { normalizeMessage } from "./line-normalize";
import { normalizePreviewResult } from "./result-normalize";

describe("B10 phase A shapes: argument tags and folds", () => {
  it("a message's tag only when it has one; an unknown kind or source is not a tag", () => {
    expect("tag" in normalizeMessage({ id: "m" })).toBe(false);
    expect(normalizeMessage({ id: "m", tag: { kind: "pro", source: "ai", status: "draft", updatedAt: "t" } }).tag).toEqual({ kind: "pro", source: "ai", status: "draft", updatedAt: "t" });
    expect("tag" in normalizeMessage({ id: "m", tag: { kind: "maybe" } })).toBe(false);
    expect(normalizeMessage({ id: "m", tag: { kind: "idea", source: "robot", status: "weird" } }).tag).toEqual({ kind: "idea", source: "user", status: "confirmed", updatedAt: "" });
  });

  it("a branch's anchorTag likewise", () => {
    expect("anchorTag" in normalizeBranchView({ lineId: "b" })).toBe(false);
    expect(normalizeBranchView({ lineId: "b", anchorTag: { kind: "question", source: "user", status: "confirmed", updatedAt: "t" } }).anchorTag?.kind).toBe("question");
  });

  it("reads a fold with its defaults", () => {
    expect(normalizeFold({ id: "f", status: "weird" })).toEqual({
      id: "f",
      lineId: "",
      fromMessageId: "",
      toMessageId: "",
      fromSeq: 0,
      toSeq: 0,
      summary: "",
      messageCount: 0,
      tokensOriginal: 0,
      tokensSummary: 0,
      status: "active",
      aiDrafted: false,
      createdBy: "",
      createdAt: "",
      updatedAt: "",
    });
  });

  it("fills the list's limits; a created fold has its job or null", () => {
    expect(normalizeFoldList({}).limits).toEqual(DEFAULT_FOLD_LIMITS);
    expect(normalizeFoldCreated({ fold: { id: "f" }, job: null }).job).toBeNull();
    expect(normalizeFoldCreated({ fold: { id: "f", status: "drafting" }, job: { jobId: "j", kind: "fold_summary", lineId: "l" } })).toMatchObject({ fold: { status: "drafting" }, job: { jobId: "j" } });
  });

  it("the preview reports the folds it applied, only when there are some", () => {
    expect("folds" in normalizePreviewResult({})).toBe(false);
    expect(normalizePreviewResult({ folds: [{ foldId: "f", fromSeq: 1, toSeq: 4, messages: 4, tokensOriginal: 47, tokensSummary: 15 }] }).folds).toEqual([
      normalizeAppliedFold({ foldId: "f", fromSeq: 1, toSeq: 4, messages: 4, tokensOriginal: 47, tokensSummary: 15 }),
    ]);
  });

  it("parses fold.changed", () => {
    const event = parseEvent("fold.changed", JSON.stringify({ type: "fold.changed", tenant: "", lineId: "l", rootLineId: "r", data: { lineId: "l", rootLineId: "r", fold: { id: "f", status: "removed" } } }));
    expect(event).toMatchObject({ type: "fold.changed", data: { lineId: "l", fold: { id: "f", status: "removed" } } });
  });
});
