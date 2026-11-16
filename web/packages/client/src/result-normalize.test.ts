import { describe, expect, it } from "vitest";
import {
  normalizeBranchList,
  normalizeLinePage,
  normalizeMergeBranchResult,
  normalizeMessagePage,
  normalizeMoveBranchResult,
  normalizeNote,
  normalizeNotesView,
  normalizeNoteWriteResult,
  normalizeStreamPage,
} from "./result-normalize";

describe("response bodies with Go nil slices (review H1)", () => {
  it("turns null lists into empty arrays", () => {
    expect(normalizeLinePage({ lines: null })).toEqual({ lines: [], nextCursor: "" });
    expect(normalizeMessagePage({ messages: null }).messages).toEqual([]);
    expect(normalizeStreamPage({ deltas: null }).deltas).toEqual([]);
    expect(normalizeBranchList({ branches: null }).branches).toEqual([]);
    expect(normalizeNotesView({ notes: null }).notes).toEqual([]);
    expect(normalizeMoveBranchResult({ movedMessageIds: null, reparented: null })).toMatchObject({ movedMessageIds: [], reparented: [] });
  });

  it("normalizes each list item", () => {
    const page = normalizeLinePage({ lines: [{ id: "a", branchCounts: null }], nextCursor: "c" });
    expect(page.lines[0]!.branchCounts.open).toBe(0);
    expect(normalizeBranchList({ branches: [{ lineId: "b", closedAt: 3 }] }).branches[0]!.closedAt).toBeNull();
  });

  it("defaults note limits and keeps optional parts optional", () => {
    expect(normalizeNotesView({ limits: { maxRunes: 50 } }).limits).toEqual({ maxActive: 200, maxTotal: 1000, maxRunes: 50, maxChangesPerMerge: 10 });
    expect("superseded" in normalizeNoteWriteResult({ note: { id: "n" } })).toBe(false);
    expect("notes" in normalizeMergeBranchResult({})).toBe(false);
    expect(normalizeMergeBranchResult({ notes: { revision: 2, created: null, superseded: null } }).notes).toEqual({ rootLineId: "", revision: 2, created: [], superseded: [] });
  });

  it("keeps an unknown note section as sent", () => {
    expect(normalizeNotesView({ notes: [{ id: "n", section: "risk" }] }).notes[0]!.section).toBe("risk");
  });
});

describe("normalizeNote", () => {
  it("keeps the source label snapshot when the server sends one (DESIGN §12), and adds no key otherwise", () => {
    expect(normalizeNote({ id: "n", sourceLabel: "順口問・scrub" }).sourceLabel).toBe("順口問・scrub");
    expect("sourceLabel" in normalizeNote({ id: "n" })).toBe(false);
    expect("sourceLabel" in normalizeNote({ id: "n", sourceLabel: "" })).toBe(false);
  });
});
