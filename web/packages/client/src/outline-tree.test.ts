import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { OUTLINE_MAIN_KEY, moveOutlineFocus, outlineItems, outlineRange, outlineSiblings, outlineTypeahead } from "./outline-tree";
import type { BranchView } from "./types";

let seq = 0;
function view(id: string, parent: string, extra: Record<string, unknown> = {}): BranchView {
  seq += 1;
  return normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", purpose: id, createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, ...extra });
}

// root ─ a ─ a1
//      │   └ a2
//      ├ b (aside)
//      └ c
const BRANCHES = [view("alpha", "root"), view("alpha-1", "alpha"), view("alpha-2", "alpha"), view("bee", "root", { kind: "aside" }), view("cedar", "root")];
const keys = (items: ReturnType<typeof outlineItems>) => items.map((item) => item.key);

describe("outlineItems", () => {
  it("lists the main line, then the tree in order, with level, set size and position among siblings; asides hidden by default", () => {
    const items = outlineItems(BRANCHES, { collapsed: new Set(), showAsides: false });
    expect(keys(items)).toEqual([OUTLINE_MAIN_KEY, "alpha", "alpha-1", "alpha-2", "cedar"]);
    expect(items.map((item) => [item.level, item.posInSet, item.setSize])).toEqual([
      [1, 1, 1],
      [2, 1, 2],
      [3, 1, 2],
      [3, 2, 2],
      [2, 2, 2],
    ]);
    expect(items[1]).toMatchObject({ hasChildren: true, expanded: true, parentKey: OUTLINE_MAIN_KEY });
    expect(items[2]).toMatchObject({ hasChildren: false, parentKey: "alpha" });
  });

  it("shows asides on request and skips the children of collapsed rows", () => {
    const items = outlineItems(BRANCHES, { collapsed: new Set(["alpha"]), showAsides: true });
    expect(keys(items)).toEqual([OUTLINE_MAIN_KEY, "alpha", "bee", "cedar"]);
    expect(items[1]).toMatchObject({ expanded: false, hasChildren: true });
    expect(items[2]).toMatchObject({ posInSet: 2, setSize: 3 });
    expect(keys(outlineItems(BRANCHES, { collapsed: new Set([OUTLINE_MAIN_KEY]), showAsides: false }))).toEqual([OUTLINE_MAIN_KEY]);
  });
});

describe("moveOutlineFocus", () => {
  const items = outlineItems(BRANCHES, { collapsed: new Set(), showAsides: false });
  it("moves through visible rows and the hierarchy", () => {
    expect(moveOutlineFocus(items, "alpha", "next")).toBe("alpha-1");
    expect(moveOutlineFocus(items, OUTLINE_MAIN_KEY, "prev")).toBe(OUTLINE_MAIN_KEY);
    expect(moveOutlineFocus(items, "cedar", "next")).toBe("cedar");
    expect(moveOutlineFocus(items, "alpha-2", "first")).toBe(OUTLINE_MAIN_KEY);
    expect(moveOutlineFocus(items, "alpha", "last")).toBe("cedar");
    expect(moveOutlineFocus(items, "alpha-2", "parent")).toBe("alpha");
    expect(moveOutlineFocus(items, OUTLINE_MAIN_KEY, "parent")).toBe(OUTLINE_MAIN_KEY);
    expect(moveOutlineFocus(items, "alpha", "firstChild")).toBe("alpha-1");
    expect(moveOutlineFocus(items, "cedar", "firstChild")).toBe("cedar");
  });
});

describe("outlineSiblings, outlineTypeahead, outlineRange", () => {
  const items = outlineItems(BRANCHES, { collapsed: new Set(), showAsides: true });
  it("finds the rows of the same parent", () => {
    expect(outlineSiblings(items, "cedar")).toEqual(["alpha", "bee", "cedar"]);
  });

  it("finds the next row whose label starts with the typed text, wrapping, ignoring case", () => {
    const label = (key: string) => (key === OUTLINE_MAIN_KEY ? "Main line" : key);
    expect(outlineTypeahead(items, "alpha", "C", label)).toBe("cedar");
    expect(outlineTypeahead(items, "cedar", "al", label)).toBe("alpha");
    expect(outlineTypeahead(items, "alpha", "alpha", label)).toBe("alpha-1");
    expect(outlineTypeahead(items, "alpha", "zz", label)).toBeNull();
  });

  it("selects a range of branch rows, never the main line or an aside", () => {
    expect(outlineRange(items, "alpha-1", "cedar")).toEqual(["alpha-1", "alpha-2", "cedar"]);
    expect(outlineRange(items, "cedar", OUTLINE_MAIN_KEY)).toEqual(["alpha", "alpha-1", "alpha-2", "cedar"]);
  });
});
