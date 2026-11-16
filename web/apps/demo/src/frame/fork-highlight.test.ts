import { normalizeBranchView } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { forksOf } from "./fork-highlight";

const branch = (id: string, parent: string, anchor: string, kind = "investigate") =>
  normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", anchorMessageId: anchor, kind, purpose: id, status: "open", createdAt: "2026-01-01T00:00:00Z" });

describe("forksOf (the fork point in view, FOCUS_MODE.md §6.1)", () => {
  it("lists the branches forking from each message of the line", () => {
    const forks = forksOf("root", [branch("a", "root", "m1"), branch("b", "root", "m1"), branch("c", "root", "m4"), branch("d", "a", "a-m1")]);
    expect(forks.get("m1")).toEqual(["a", "b"]);
    expect(forks.get("m4")).toEqual(["c"]);
    expect(forks.has("a-m1")).toBe(false);
  });

  it("leaves asides out (they are not on the map's main paths)", () => {
    expect(forksOf("root", [branch("x", "root", "m1", "aside")]).size).toBe(0);
  });
});
