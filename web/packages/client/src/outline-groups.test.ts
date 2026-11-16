import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { OUTLINE_MAIN_KEY, isEndedBranch, outlineEndedKind, outlineGroupKey, outlineItems, outlineToggleKey } from "./outline-tree";
import type { BranchView } from "./types";

let seq = 0;
function view(id: string, extra: Record<string, unknown> = {}): BranchView {
  seq += 1;
  return normalizeBranchView({ lineId: id, parentLineId: "root", rootLineId: "root", purpose: id, createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, ...extra });
}
const leaf = (kind: string) => ({ leaf: { kind, line: kind, status: "confirmed" } });

// Two open branches and seven ended ones under the main line: 2 decisions, 1 answer, 1 dead end (with a child), 3 without a leaf.
const BRANCHES = [
  view("open-1"),
  view("d-1", { status: "merged", ...leaf("decision") }),
  view("d-2", { status: "merged", ...leaf("decision") }),
  view("a-1", { status: "merged", ...leaf("answer") }),
  view("x-1", { status: "discarded", ...leaf("dead_end") }),
  normalizeBranchView({ lineId: "x-1-child", parentLineId: "x-1", rootLineId: "root", purpose: "child", status: "open", createdAt: "2026-01-02T00:00:00Z" }),
  view("o-1", { status: "discarded" }),
  view("o-2", { status: "merged", ...leaf("to_continue") }),
  view("o-3", { status: "discarded" }),
  view("open-2"),
  view("promoted", { status: "promoted" }),
];
const keys = (items: ReturnType<typeof outlineItems>) => items.map((item) => item.key);
const MAIN = OUTLINE_MAIN_KEY;

describe("ended branches grouped by how they ended (F9 B.4)", () => {
  it("counts merged and discarded as ended (a promoted branch is not) and groups by leaf kind, else 其他", () => {
    expect(BRANCHES.filter(isEndedBranch).map((branch) => branch.lineId)).toEqual(["d-1", "d-2", "a-1", "x-1", "o-1", "o-2", "o-3"]);
    expect(BRANCHES.filter(isEndedBranch).map(outlineEndedKind)).toEqual(["decision", "decision", "answer", "dead_end", "other", "other", "other"]);
  });

  it("from six ended: open ones in line, one closed row per kind in order, then the toggle", () => {
    const items = outlineItems(BRANCHES, { collapsed: new Set(), showAsides: false });
    expect(keys(items)).toEqual([MAIN, "open-1", "open-2", "promoted", ...["decision", "answer", "dead_end", "other"].map((kind) => outlineGroupKey(MAIN, kind as never)), outlineToggleKey(MAIN)]);
    const decision = items.find((item) => item.key === outlineGroupKey(MAIN, "decision"))!;
    expect(decision).toMatchObject({ branch: null, level: 2, hasChildren: true, expanded: false, group: { kind: "decision", count: 2 }, setSize: 8, posInSet: 4 });
    expect(items.at(-1)).toMatchObject({ toggle: { grouped: true, count: 7 }, hasChildren: false, posInSet: 8 });
  });

  it("an open group lists its branches one level down, with their own subtrees", () => {
    const group = outlineGroupKey(MAIN, "dead_end");
    const items = outlineItems(BRANCHES, { collapsed: new Set(), showAsides: false, openGroups: new Set([group]) });
    const at = keys(items).indexOf(group);
    expect(keys(items).slice(at, at + 3)).toEqual([group, "x-1", "x-1-child"]);
    expect(items[at + 1]).toMatchObject({ level: 3, parentKey: group, setSize: 1, posInSet: 1 });
    expect(items[at + 2]).toMatchObject({ level: 4, parentKey: "x-1" });
  });

  it("shown in full: today's rows, then the toggle that groups them again", () => {
    const items = outlineItems(BRANCHES, { collapsed: new Set(), showAsides: false, endedShown: new Set([MAIN]) });
    expect(keys(items)).toEqual([MAIN, "open-1", "d-1", "d-2", "a-1", "x-1", "x-1-child", "o-1", "o-2", "o-3", "open-2", "promoted", outlineToggleKey(MAIN)]);
    expect(items.at(-1)).toMatchObject({ toggle: { grouped: false, count: 7 }, setSize: 11, posInSet: 11 });
  });

  it("the line on screen keeps its group open, also from deeper down", () => {
    const shown = keys(outlineItems(BRANCHES, { collapsed: new Set(), showAsides: false, reveal: "x-1-child" }));
    expect(shown).toContain("x-1-child");
    expect(keys(outlineItems(BRANCHES, { collapsed: new Set(), showAsides: false, reveal: "o-2" }))).toContain("o-2");
    const other = outlineItems(BRANCHES, { collapsed: new Set(), showAsides: false, reveal: "o-2" }).find((item) => item.group?.kind === "other");
    expect(other).toMatchObject({ expanded: true, group: { revealed: true } });
  });

  it("five ended stay in line, without groups", () => {
    const fewer = BRANCHES.filter((branch) => !["o-1", "o-3"].includes(branch.lineId));
    expect(outlineItems(fewer, { collapsed: new Set(), showAsides: false }).some((item) => item.group || item.toggle)).toBe(false);
  });
});
