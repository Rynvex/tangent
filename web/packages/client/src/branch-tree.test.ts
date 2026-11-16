import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { branchPath, branchReadonlyKind, branchRowState, buildBranchTree, flattenBranchTree, summarizeBranchAttention } from "./branch-tree";
import type { BranchView } from "./types";

function view(id: string, parent: string, extra: Partial<BranchView> = {}): BranchView {
  return normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", createdAt: `2026-01-01T00:00:${id.length}${id}`, ...extra });
}

describe("buildBranchTree", () => {
  it("returns an empty tree for no branches", () => {
    expect(buildBranchTree([])).toEqual([]);
  });

  it("nests children under their parent across levels", () => {
    const tree = buildBranchTree([view("a", "root"), view("b", "a"), view("c", "b")]);
    expect(tree.map((n) => n.branch.lineId)).toEqual(["a"]);
    expect(tree[0]!.children[0]!.children[0]!.branch.lineId).toBe("c");
  });

  it("orders siblings by creation time", () => {
    const tree = buildBranchTree([view("z", "root", { createdAt: "2026-01-02" }), view("y", "root", { createdAt: "2026-01-01" })]);
    expect(tree.map((n) => n.branch.lineId)).toEqual(["y", "z"]);
  });

  it("hangs a branch with an unknown parent from the main line", () => {
    const tree = buildBranchTree([view("a", "ghost")]);
    expect(tree.map((n) => n.branch.lineId)).toEqual(["a"]);
  });

  it("keeps the first of repeated ids", () => {
    const tree = buildBranchTree([view("a", "root", { purpose: "first" }), view("a", "root", { purpose: "second" })]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.branch.purpose).toBe("first");
  });

  it("trusts the parent over a conflicting depth", () => {
    const tree = buildBranchTree([view("a", "root", { depth: 5 }), view("b", "a", { depth: 1 })]);
    expect(tree[0]!.children[0]!.branch.lineId).toBe("b");
  });

  it("does not lose or loop on a parent cycle", () => {
    const tree = buildBranchTree([view("a", "b"), view("b", "a")]);
    const rows = flattenBranchTree(tree, new Set());
    expect(rows.map((r) => r.branch.lineId).sort()).toEqual(["a", "b"]);
  });
});

describe("flattenBranchTree", () => {
  it("indents by level and hides the children of collapsed rows", () => {
    const tree = buildBranchTree([view("a", "root"), view("b", "a")]);
    expect(flattenBranchTree(tree, new Set()).map((r) => [r.branch.lineId, r.level])).toEqual([["a", 1], ["b", 2]]);
    const collapsed = flattenBranchTree(tree, new Set(["a"]));
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.hasChildren).toBe(true);
  });
});

describe("branchPath", () => {
  it("walks up to the branch under the main line", () => {
    const list = [view("a", "root"), view("b", "a"), view("c", "b")];
    expect(branchPath("c", list).map((b) => b.lineId)).toEqual(["a", "b", "c"]);
  });

  it("stops on a cycle and on an unknown id", () => {
    expect(branchPath("a", [view("a", "b"), view("b", "a")])).toHaveLength(2);
    expect(branchPath("nope", [view("a", "root")])).toEqual([]);
  });
});

describe("branchRowState", () => {
  it("marks the current row", () => {
    expect(branchRowState(view("a", "root"), "a").isCurrent).toBe(true);
    expect(branchRowState(view("a", "root"), "b").isCurrent).toBe(false);
  });

  it("ranks an error over thinking over unread", () => {
    const all = view("a", "root", { lineStatus: "error", unread: 3 });
    expect(branchRowState(all, null).primary).toBe("error");
    expect(branchRowState({ ...all, lineStatus: "thinking" }, null).primary).toBe("thinking");
    expect(branchRowState({ ...all, lineStatus: "idle" }, null).primary).toBe("unread");
    expect(branchRowState(view("a", "root"), null).primary).toBe("none");
  });

  it("shows markers only while open and greys a discarded branch", () => {
    const closed = view("a", "root", { status: "merged", lineStatus: "error", unread: 2 });
    expect(branchRowState(closed, null)).toMatchObject({ primary: "none", unread: 0 });
    expect(branchRowState(view("a", "root", { status: "discarded" }), null).isMuted).toBe(true);
    expect(branchRowState(view("a", "root", { status: "promoted" }), null).status).toBe("promoted");
  });
});

describe("branchReadonlyKind", () => {
  const info = (status: "open" | "merged" | "discarded" | "promoted") => ({ status }) as never;
  it("is null for a main line and an open branch", () => {
    expect(branchReadonlyKind({ conversationBranch: null, archivedAt: null })).toBeNull();
    expect(branchReadonlyKind({ conversationBranch: info("open"), archivedAt: null })).toBeNull();
  });
  it("follows the status, then the archive flag", () => {
    expect(branchReadonlyKind({ conversationBranch: info("merged"), archivedAt: null })).toBe("merged");
    expect(branchReadonlyKind({ conversationBranch: info("open"), archivedAt: "2026-01-01" })).toBe("archived");
  });
});

describe("summarizeBranchAttention", () => {
  const main = { branchUnread: 0 };
  it("is quiet without counters or marks", () => {
    expect(summarizeBranchAttention(main, [], {})).toEqual({ unread: false, level: null });
  });
  it("lights on the server counter", () => {
    expect(summarizeBranchAttention({ branchUnread: 2 }, [], {})).toMatchObject({ unread: true, level: null });
  });
  it("rolls an unwatched branch's live mark up to the main line", () => {
    const summary = summarizeBranchAttention(main, [view("a", "root")], { a: "error", other: "idle" });
    expect(summary).toEqual({ unread: true, level: "error" });
  });
  it("keeps the strongest mark", () => {
    const summary = summarizeBranchAttention(main, [view("a", "root"), view("b", "root")], { a: "idle", b: "error" });
    expect(summary.level).toBe("error");
  });
});

describe("creation order of RFC 3339 timestamps (review M6)", () => {
  it("orders by instant, not by string, when fractional zeros are trimmed", () => {
    // As text "…:00Z" sorts after "…:00.1Z", but it is 100ms earlier.
    const tree = buildBranchTree([view("late", "root", { createdAt: "2026-01-01T00:00:00.1Z" }), view("early", "root", { createdAt: "2026-01-01T00:00:00Z" })]);
    expect(tree.map((n) => n.branch.lineId)).toEqual(["early", "late"]);
  });

  it("orders across time zone offsets and breaks ties on the line id", () => {
    const tree = buildBranchTree([
      view("b", "root", { createdAt: "2026-01-01T08:00:00+08:00" }),
      view("a", "root", { createdAt: "2026-01-01T00:00:00Z" }),
      view("z", "root", { createdAt: "2025-12-31T23:59:59.999999999Z" }),
    ]);
    expect(tree.map((n) => n.branch.lineId)).toEqual(["z", "a", "b"]);
  });

  it("puts unparsable times last", () => {
    const tree = buildBranchTree([view("x", "root", { createdAt: "garbage" }), view("y", "root", { createdAt: "2026-01-01T00:00:00Z" })]);
    expect(tree.map((n) => n.branch.lineId)).toEqual(["y", "x"]);
  });
});
