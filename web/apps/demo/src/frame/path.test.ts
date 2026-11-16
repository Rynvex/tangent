import { normalizeBranchView } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { pathItems } from "./center";

const t = (key: string) => (key === "branch.previousMainLine" ? "原本的主線" : key);
const branch = (lineId: string, parentLineId: string, over: Record<string, unknown> = {}) =>
  normalizeBranchView({ lineId, parentLineId, rootLineId: "root", purpose: lineId, kind: "investigate", ...over });

describe("pathItems", () => {
  it("is only the main line on the main line", () => {
    expect(pathItems("root", "root", [], "主線", t)).toEqual([{ id: "root", label: "主線" }]);
  });

  it("walks from the main line down to a sub-branch, naming the previous main line by its origin", () => {
    const branches = [branch("b1", "root", { origin: "previous_main_line", kind: "alternative" }), branch("b2", "b1", { kind: "aside" })];
    expect(pathItems("root", "b2", branches, "主線", t)).toEqual([
      { id: "root", label: "主線" },
      { id: "b1", label: "原本的主線", kind: "alternative" },
      { id: "b2", label: "b2", kind: "aside" },
    ]);
  });
});
