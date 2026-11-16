import type { SearchHit } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { groupHits, highlightParts, leadToHit, loadIncludeArchived, mergeHits, nextIndex, saveIncludeArchived, searchPhase, SEARCH_MIN_CHARS } from "./search-model";

const hit = (kind: SearchHit["kind"], lineId: string, over: Partial<SearchHit> = {}): SearchHit => ({
  kind, lineId, rootLineId: "r", rootTitle: "Trip", purpose: "", snippet: "Kyoto trip", highlights: [], score: 0.5, at: "", ...over,
});

describe("highlightParts", () => {
  it("splits the snippet at the returned offsets (UTF-16), marking the hits", () => {
    expect(highlightParts("Trip to Kyoto", [{ start: 8, end: 13 }])).toEqual([
      { text: "Trip to ", hit: false },
      { text: "Kyoto", hit: true },
    ]);
    expect(highlightParts("😀 京都 京都", [{ start: 3, end: 5 }, { start: 6, end: 8 }])).toEqual([
      { text: "😀 ", hit: false },
      { text: "京都", hit: true },
      { text: " ", hit: false },
      { text: "京都", hit: true },
    ]);
  });

  it("survives offsets out of order, overlapping, empty or past the end", () => {
    expect(highlightParts("abcdef", [{ start: 4, end: 9 }, { start: 1, end: 3 }, { start: 2, end: 4 }, { start: 5, end: 5 }])).toEqual([
      { text: "a", hit: false },
      { text: "bcdef", hit: true },
    ]);
    expect(highlightParts("abc", [])).toEqual([{ text: "abc", hit: false }]);
    expect(highlightParts("", [{ start: 0, end: 2 }])).toEqual([]);
  });
});

describe("groupHits", () => {
  it("groups titles, purposes and messages in that order, keeping the server's order inside", () => {
    const groups = groupHits([hit("message", "m1"), hit("title", "t1"), hit("message", "m2"), hit("purpose", "p1")]);
    expect(groups.map((group) => [group.kind, group.hits.map((item) => item.lineId)])).toEqual([
      ["title", ["t1"]],
      ["purpose", ["p1"]],
      ["message", ["m1", "m2"]],
    ]);
    expect(groupHits([])).toEqual([]);
  });
});

describe("searchPhase", () => {
  it("is idle when empty, too short under 2 characters, else a search", () => {
    expect(SEARCH_MIN_CHARS).toBe(2);
    expect(searchPhase("  ")).toBe("idle");
    expect(searchPhase(" 京 ")).toBe("tooShort");
    expect(searchPhase("京都")).toBe("search");
  });
});

describe("nextIndex", () => {
  it("moves through the results and wraps; nothing to move in an empty list", () => {
    expect(nextIndex(-1, 1, 3)).toBe(0);
    expect(nextIndex(2, 1, 3)).toBe(0);
    expect(nextIndex(0, -1, 3)).toBe(2);
    expect(nextIndex(-1, -1, 3)).toBe(2);
    expect(nextIndex(-1, 1, 0)).toBe(-1);
  });
});

describe("leadToHit", () => {
  it("cuts a long lead-in so the first hit shows in a narrow list, marking the cut", () => {
    const parts = highlightParts(`${"x".repeat(50)}rclone sync`, [{ start: 50, end: 56 }]);
    expect(leadToHit(parts, 10)).toEqual([
      { text: `…${"x".repeat(10)}`, hit: false },
      { text: "rclone", hit: true },
      { text: " sync", hit: false },
    ]);
  });

  it("never starts on half of an emoji when the cut falls inside one (R5)", () => {
    // "😀" is two UTF-16 units; the last 10 units start on its low surrogate.
    const parts = highlightParts(`${"x".repeat(20)}😀${"y".repeat(9)}zfs`, [{ start: 31, end: 34 }]);
    const [lead] = leadToHit(parts, 10);
    expect(lead).toEqual({ text: `…😀${"y".repeat(9)}`, hit: false });
    expect(lead!.text.codePointAt(1)).toBe(0x1f600);
  });

  it("leaves short lead-ins and hit-first snippets alone", () => {
    const parts = highlightParts("ab rclone", [{ start: 3, end: 9 }]);
    expect(leadToHit(parts, 10)).toBe(parts);
    const first = highlightParts("rclone sync", [{ start: 0, end: 6 }]);
    expect(leadToHit(first, 10)).toBe(first);
  });
});

describe("mergeHits (包含封存)", () => {
  it("adds the archived conversations' hits, marked, ranked with the active ones by score", () => {
    const merged = mergeHits([hit("title", "a", { score: 0.6 })], [hit("title", "z", { score: 0.9 }), hit("message", "y", { score: 0.1 })]);
    expect(merged.map((item) => [item.lineId, item.archived])).toEqual([
      ["z", true],
      ["a", false],
      ["y", true],
    ]);
    expect(mergeHits([hit("title", "a")], undefined).map((item) => item.archived)).toEqual([false]);
  });
});

describe("the include-archived preference", () => {
  const memory = () => {
    const data: Record<string, string> = {};
    return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value) };
  };

  it("is off by default and kept per browser", () => {
    const storage = memory();
    expect(loadIncludeArchived(storage)).toBe(false);
    saveIncludeArchived(storage, true);
    expect(loadIncludeArchived(storage)).toBe(true);
    expect(loadIncludeArchived(null)).toBe(false);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadIncludeArchived(broken)).toBe(false);
    expect(() => saveIncludeArchived(broken, true)).not.toThrow();
  });
});
