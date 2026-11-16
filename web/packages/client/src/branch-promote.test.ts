import { describe, expect, it } from "vitest";
import { blockingBranches, promoteBlock } from "./branch-promote";
import { normalizeBranchView } from "./branch-normalize";
import { TangentError } from "./errors";

const top = { parentLineId: "root", rootLineId: "root" };

describe("promoteBlock", () => {
  it("allows any open branch directly under the main line, whatever its kind (DESIGN §4.3)", () => {
    expect(promoteBlock({ status: "open", ...top })).toBeNull();
  });
  it("blocks a branch that ended or sits deeper", () => {
    expect(promoteBlock({ status: "merged", ...top })).toBe("notOpen");
    expect(promoteBlock({ status: "open", parentLineId: "b1", rootLineId: "root" })).toBe("notTopLevel");
  });
});

describe("blockingBranches", () => {
  const branches = [normalizeBranchView({ lineId: "b1", purpose: "one" }), normalizeBranchView({ lineId: "b2", purpose: "two" })];

  it("lists the branches named by open_branches_on_old_tail", () => {
    const error = new TangentError(409, "open", "open_branches_on_old_tail", { lineIds: ["b2", "gone", 4] });
    expect(blockingBranches(error, branches).map((b) => b.lineId)).toEqual(["b2"]);
  });
  it("is empty for other errors", () => {
    expect(blockingBranches(new TangentError(409, "busy", "parent_busy"), branches)).toEqual([]);
    expect(blockingBranches(new TangentError(409, "open", "open_branches_on_old_tail"), branches)).toEqual([]);
    expect(blockingBranches(new Error("x"), branches)).toEqual([]);
  });
});
