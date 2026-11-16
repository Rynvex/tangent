import { describe, expect, it } from "vitest";
import { branchDescendants, busyBranchUnder, canDeleteBranch, classifyContinueError, classifyDeleteBranchError } from "./aside-rules";
import { normalizeBranchView } from "./branch-normalize";
import { TangentError } from "./errors";
import type { BranchView } from "./types";

/** A discarded branch unless told otherwise. */
const branch = (lineId: string, parentLineId: string, more: Partial<BranchView> = {}): BranchView => ({ ...normalizeBranchView({ lineId, parentLineId, rootLineId: "root", status: "discarded" }), ...more });

describe("canDeleteBranch (domain.BranchDeletable)", () => {
  it.each([
    ["an answered aside", { kind: "aside", status: "discarded" }, true],
    ["an aside still answering", { kind: "aside", status: "open" }, false],
    ["a discarded branch", { kind: "investigate", status: "discarded" }, true],
    ["an open branch", { kind: "investigate", status: "open" }, false],
    ["a merged branch", { kind: "investigate", status: "merged" }, false],
    ["a promoted branch", { kind: "alternative", status: "promoted" }, false],
    ["the previous main line", { kind: "alternative", status: "discarded", origin: "previous_main_line" }, false],
    ["a branch combined into another", { kind: "investigate", status: "discarded", mergedIntoLineId: "b9" }, false],
  ] as const)("%s", (_name, fields, expected) => {
    expect(canDeleteBranch(branch("b", "root", fields as Partial<BranchView>))).toBe(expected);
  });
});

describe("the outline around a delete", () => {
  const tree = [branch("a", "root"), branch("a1", "a"), branch("a2", "a", { status: "open" }), branch("a1x", "a1", { lineStatus: "thinking" }), branch("b", "root")];

  it("lists everything under a branch, nearest first, never the branch itself", () => {
    expect(branchDescendants(tree, "a").map((item) => item.lineId)).toEqual(["a1", "a2", "a1x"]);
    expect(branchDescendants(tree, "b")).toEqual([]);
  });

  it("names the branch that blocks a delete: an open one first, else one that is answering", () => {
    expect(busyBranchUnder(tree, "a")?.lineId).toBe("a2");
    expect(busyBranchUnder(tree, "a1")?.lineId).toBe("a1x");
    expect(busyBranchUnder(tree, "b")).toBeNull();
  });
});

describe("refusals", () => {
  const error = (status: number, code: string, extra: Record<string, unknown> = {}) => new TangentError(status, code, code, extra);

  it("sorts a refused 接著問", () => {
    expect(classifyContinueError(error(404, "branch_not_found"))).toEqual({ kind: "gone" });
    expect(classifyContinueError(error(409, "no_messages"))).toEqual({ kind: "noAnswer" });
    expect(classifyContinueError(error(409, "branch_busy"))).toEqual({ kind: "busy" });
    expect(classifyContinueError(error(409, "branch_limit", { limit: 8 }))).toEqual({ kind: "branchLimit", limit: 8 });
    expect(classifyContinueError(error(409, "tree_limit"))).toEqual({ kind: "treeLimit", limit: 200 });
    expect(classifyContinueError(error(409, "depth_soft_limit", { depth: 4, limit: 3 }))).toEqual({ kind: "deeper", depth: 4, limit: 3 });
    expect(classifyContinueError(error(409, "depth_hard_limit"))).toEqual({ kind: "tooDeep" });
    expect(classifyContinueError(error(404, "anchor_not_found"))).toEqual({ kind: "anchorGone" });
    expect(classifyContinueError(error(409, "concurrent_change"))).toEqual({ kind: "retry" });
    expect(classifyContinueError(error(409, "parent_closed"))).toEqual({ kind: "parentClosed" });
    expect(classifyContinueError(error(409, "archived"))).toEqual({ kind: "archived" });
    expect(classifyContinueError(error(404, "feature_disabled"))).toEqual({ kind: "featureOff" });
    expect(classifyContinueError(new Error("offline"))).toEqual({ kind: "other" });
  });

  it("sorts a refused delete", () => {
    expect(classifyDeleteBranchError(error(404, "line_not_found"))).toEqual({ kind: "gone" });
    expect(classifyDeleteBranchError(error(409, "branch_busy"))).toEqual({ kind: "busy" });
    expect(classifyDeleteBranchError(error(409, "branch_not_deletable"))).toEqual({ kind: "notDeletable" });
    expect(classifyDeleteBranchError(error(409, "archived"))).toEqual({ kind: "archived" });
    expect(classifyDeleteBranchError(error(500, "internal"))).toEqual({ kind: "other" });
  });
});
