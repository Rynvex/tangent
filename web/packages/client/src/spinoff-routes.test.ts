import { describe, expect, it } from "vitest";
import { normalizeLine, normalizeMessage } from "./line-normalize";
import { normalizeNote } from "./result-normalize";
import { normalizeLink, normalizeLinkList, normalizeSpinoffPreview, normalizeSpinoffResult } from "./spinoff-routes";

/** B8 phase B shapes the client reads already in F4 phase 1 (the UI comes in phase 2). */
describe("spinoff shapes (B8 phase B)", () => {
  it("reads LineView.spunOffFrom, null on an ordinary line", () => {
    expect(normalizeLine({}).spunOffFrom).toBeNull();
    expect(normalizeLine({ spunOffFrom: { lineId: "a", messageId: "m", title: "Trip", available: true } }).spunOffFrom).toEqual({ lineId: "a", messageId: "m", title: "Trip", available: true });
    // B8.2: false when the other side is gone; an older server that does not say counts as there.
    expect(normalizeLine({ spunOffFrom: { lineId: "a", available: false } }).spunOffFrom?.available).toBe(false);
    expect(normalizeLine({ spunOffFrom: { lineId: "a" } }).spunOffFrom?.available).toBe(true);
  });

  it("keeps a marker's spunOffTo and a copied note's copiedFromNoteId only when sent", () => {
    expect(normalizeMessage({ meta: {} }).meta).not.toHaveProperty("spunOffTo");
    expect(normalizeMessage({ meta: { spunOffTo: { lineId: "n", messageId: "m", title: "T", available: false } } }).meta.spunOffTo).toEqual({ lineId: "n", messageId: "m", title: "T", available: false });
    expect(normalizeNote({})).not.toHaveProperty("copiedFromNoteId");
    expect(normalizeNote({ copiedFromNoteId: "x" }).copiedFromNoteId).toBe("x");
  });

  it("reads links and a spinoff result", () => {
    expect(normalizeLink({ kind: "weird" }).kind).toBe("spinoff");
    expect(normalizeLinkList({ links: null })).toEqual({ links: [] });
    const result = normalizeSpinoffResult({ mode: "fresh", line: { id: "n" }, link: {}, marker: {}, moved: null, sourceLineId: "s", rootLineId: "r" });
    expect(result).toMatchObject({ mode: "fresh", moved: [], sourceLineId: "s", rootLineId: "r" });
    expect(result).not.toHaveProperty("branch");
    expect(result).not.toHaveProperty("notes");
  });

  it("reads the capsule preview (B8.2)", () => {
    expect(normalizeSpinoffPreview({ mode: "fresh", capsule: { text: "## Where", tokenEstimate: 299, tokenBudget: 6000, truncated: true }, notesToCopy: 3 })).toEqual({
      mode: "fresh",
      capsule: { text: "## Where", tokenEstimate: 299, tokenBudget: 6000, truncated: true },
      notesToCopy: 3,
    });
    expect(normalizeSpinoffPreview({}).capsule).toEqual({ text: "", tokenEstimate: 0, tokenBudget: 0, truncated: false });
  });
});
