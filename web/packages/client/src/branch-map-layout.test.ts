import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { BRANCH_MAP_METRICS, buildBranchMapLayout, chapterStageBoxes, cullLayout, defaultCollapsed, MAP_LARGE_TREE, MAP_ROOT_KEY, pathKeys } from "./branch-map-layout";
import type { BranchView } from "./types";

let seq = 0;
function view(id: string, parent: string): BranchView {
  seq += 1;
  return normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z` });
}
const none = new Set<string>();
const layout = (b: BranchView[], collapsed = none, currentId: string | null = null) =>
  buildBranchMapLayout(b, { collapsed, direction: "horizontal", currentId });

describe("buildBranchMapLayout", () => {
  it("holds only the main line when there are no branches", () => {
    const result = layout([]);
    expect(result.nodes.map((n) => n.key)).toEqual([MAP_ROOT_KEY]);
    expect(result.edges).toEqual([]);
  });

  it("puts a single level in one column with distinct rows", () => {
    const result = layout([view("a", "root"), view("b", "root")]);
    expect(result.byKey.get("a")!.depth).toBe(1);
    expect(result.byKey.get("a")!.y).not.toBe(result.byKey.get("b")!.y);
    expect(result.edges).toHaveLength(2);
  });

  it("nests deeper levels to the right and centres a parent over its children", () => {
    const result = layout([view("a", "root"), view("b", "a"), view("c", "a")]);
    expect(result.byKey.get("b")!.depth).toBe(2);
    const mid = (result.byKey.get("b")!.row + result.byKey.get("c")!.row) / 2;
    expect(result.byKey.get("a")!.row).toBe(mid);
  });

  it("hides the children of a collapsed branch and reports how many", () => {
    const result = layout([view("a", "root"), view("b", "a"), view("c", "b")], new Set(["a"]));
    expect(result.nodes.map((n) => n.key).sort()).toEqual([MAP_ROOT_KEY, "a"].sort());
    expect(result.byKey.get("a")).toMatchObject({ collapsed: true, hiddenCount: 2 });
  });

  it("hangs an orphan from the main line", () => {
    const result = layout([view("x", "missing")]);
    expect(result.edges.map((e) => e.id)).toEqual([`${MAP_ROOT_KEY}->x`]);
  });

  it("lays out 200 nodes without losing any", () => {
    const branches = Array.from({ length: 200 }, (_, i) => view(`n${i}`, i === 0 ? "root" : `n${Math.floor((i - 1) / 3)}`));
    const result = layout(branches);
    expect(result.nodes).toHaveLength(201);
    expect(new Set(result.nodes.map((n) => `${n.depth}:${n.row}`)).size).toBe(201);
  });

  it("marks only the edges on the way to the current branch", () => {
    const result = layout([view("a", "root"), view("b", "a"), view("c", "root")], none, "b");
    const onPath = result.edges.filter((e) => e.onPath).map((e) => e.id).sort();
    expect(onPath).toEqual([`${MAP_ROOT_KEY}->a`, "a->b"].sort());
  });
});

describe("pathKeys and defaultCollapsed", () => {
  it("collects the main line and every branch down to the current one", () => {
    const branches = [view("a", "root"), view("b", "a")];
    expect([...pathKeys("b", branches)].sort()).toEqual([MAP_ROOT_KEY, "a", "b"].sort());
    expect([...pathKeys("root", branches)]).toEqual([MAP_ROOT_KEY]);
  });

  it("folds nothing in a small tree", () => {
    expect(defaultCollapsed([view("a", "root"), view("b", "a")], null).size).toBe(0);
  });

  it("folds parents off the current path in a large tree", () => {
    const branches: BranchView[] = [];
    for (let i = 0; i < MAP_LARGE_TREE + 1; i += 1) {
      branches.push(view(`p${i}`, "root"), view(`k${i}`, `p${i}`));
    }
    const folded = defaultCollapsed(branches, "k3");
    expect(folded.has("p3")).toBe(false);
    expect(folded.has("p4")).toBe(true);
  });
});

describe("cullLayout", () => {
  it("renders only what is near the viewport", () => {
    const branches = Array.from({ length: 50 }, (_, i) => view(`n${i}`, "root"));
    const full = layout(branches);
    const part = cullLayout(full, { x: 0, y: 0, width: 400, height: 300 }, 0);
    expect(part.nodes.length).toBeGreaterThan(0);
    expect(part.nodes.length).toBeLessThan(full.nodes.length);
  });
});

describe("buildBranchMapLayout: the design's metrics (F2 phase 2)", () => {
  it("places 188×60 cards 236 apart by depth and 78 apart by row", () => {
    const branches = [normalizeBranchView({ lineId: "a", parentLineId: "root", rootLineId: "root", createdAt: "2026-01-01T00:00:00Z" }), normalizeBranchView({ lineId: "b", parentLineId: "root", rootLineId: "root", createdAt: "2026-01-02T00:00:00Z" })];
    const layout = buildBranchMapLayout(branches, { collapsed: new Set(), direction: "horizontal", currentId: null, metrics: BRANCH_MAP_METRICS });
    const a = layout.byKey.get("a")!;
    const b = layout.byKey.get("b")!;
    expect([a.width, a.height]).toEqual([188, 60]);
    expect(a.x - layout.byKey.get(MAP_ROOT_KEY)!.x).toBe(236);
    expect(b.y - a.y).toBe(78);
  });
});

describe("chapterStageBoxes (F11 §3)", () => {
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it("stacks the stages under the main node in its column, clear of every branch node and of each other", () => {
    const branches = [view("a", "root"), view("b", "a"), view("c", "a"), view("d", "root"), view("e", "root"), view("f", "e")];
    const result = buildBranchMapLayout(branches, { collapsed: none, direction: "horizontal", currentId: null, metrics: BRANCH_MAP_METRICS });
    const main = result.byKey.get(MAP_ROOT_KEY)!;
    const { boxes, bottom } = chapterStageBoxes(main, 4);
    expect(boxes).toHaveLength(4);
    for (const [i, box] of boxes.entries()) {
      expect(box.x).toBe(main.x);
      expect(box.y).toBeGreaterThan(i === 0 ? main.y + main.height : boxes[i - 1]!.y + boxes[i - 1]!.height);
      for (const node of result.nodes) expect(overlaps(box, node)).toBe(false);
      // Edges leave the main node on its right, so nothing is drawn across the column.
      expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width);
    }
    expect(bottom).toBe(boxes[3]!.y + boxes[3]!.height);
  });

  it("has nothing to place without chapters", () => {
    const main = layout([]).byKey.get(MAP_ROOT_KEY)!;
    expect(chapterStageBoxes(main, 0)).toEqual({ boxes: [], bottom: main.y + main.height });
  });
});
