import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { focusScope, noteCountsByNode, subtreeKeys } from "./branch-map-focus";
import { MAP_ROOT_KEY } from "./branch-map-layout";
import type { BranchView, Note } from "./types";

const view = (id: string, parent: string): BranchView => normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", createdAt: "2026-01-01T00:00:00Z" });

// root ─ a ─ a1 ─ a1x
//   │      └ a2
//   └ b ─ b1
const tree = [view("a", "root"), view("a1", "a"), view("a1x", "a1"), view("a2", "a"), view("b", "root"), view("b1", "b")];

const note = (id: string, sourceLineId: string, status: Note["status"] = "active"): Note => ({
  id,
  section: "fact",
  text: id,
  status,
  sourceLineId,
  sourceMessageId: "",
  sourceCardMessageId: "",
  supersededBy: "",
  createdBy: "",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

describe("focusScope", () => {
  it("keeps the focused node, its whole subtree and its way up to the main line", () => {
    expect([...focusScope("a1", tree)].sort()).toEqual([MAP_ROOT_KEY, "a", "a1", "a1x"].sort());
  });

  it("leaves siblings and other subtrees out", () => {
    const scope = focusScope("a", tree);
    expect(scope.has("a2")).toBe(true);
    expect(scope.has("b")).toBe(false);
    expect(scope.has("b1")).toBe(false);
  });

  it("keeps everything when the main line is focused", () => {
    expect(focusScope(MAP_ROOT_KEY, tree).size).toBe(tree.length + 1);
  });

  it("keeps everything for a line the outline does not know", () => {
    expect(focusScope("gone", tree).size).toBe(tree.length + 1);
  });

  it("stops on a cycle instead of looping", () => {
    const looped = [view("x", "y"), view("y", "x")];
    expect(focusScope("x", looped).has("y")).toBe(true);
  });
});

describe("subtreeKeys", () => {
  it("is the node and everything under it, without the way up", () => {
    expect([...subtreeKeys("a", tree)].sort()).toEqual(["a", "a1", "a1x", "a2"]);
  });

  it("is the whole tree for the main line", () => {
    expect(subtreeKeys(MAP_ROOT_KEY, tree).size).toBe(tree.length + 1);
  });
});

describe("noteCountsByNode", () => {
  it("counts active and done notes by their source line, the main line on its own key", () => {
    const counts = noteCountsByNode([note("1", "a"), note("2", "a", "done"), note("3", "root"), note("4", "b")], "root", tree);
    expect(counts.get("a")).toBe(2);
    expect(counts.get(MAP_ROOT_KEY)).toBe(1);
    expect(counts.get("b")).toBe(1);
  });

  it("leaves out replaced notes, notes without a source and lines not on the map", () => {
    const counts = noteCountsByNode([note("1", "a", "superseded"), note("2", ""), note("3", "elsewhere")], "root", tree);
    expect(counts.size).toBe(0);
  });
});
