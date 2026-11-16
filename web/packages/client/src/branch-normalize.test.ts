import { describe, expect, it } from "vitest";
import { normalizeBranchDetail, normalizeBranchDraft, normalizeBranchView, totalBranches } from "./branch-normalize";
import { normalizeLine } from "./line-normalize";

describe("normalizeLine", () => {
  it("fills the branch fields an older payload lacks", () => {
    const line = normalizeLine({ id: "l1", title: "old" });
    expect(line.conversationBranch).toBeNull();
    expect(line.branchCounts).toEqual({ open: 0, merged: 0, discarded: 0, promoted: 0 });
    expect(line.branchUnread).toBe(0);
    expect(line.title).toBe("old");
  });

  it("keeps real values and counts branches", () => {
    const line = normalizeLine({ id: "l1", branchCounts: { open: 2, merged: 1 }, branchUnread: 3 });
    expect(totalBranches(line.branchCounts)).toBe(3);
    expect(line.branchUnread).toBe(3);
  });
});

describe("normalizeBranchView", () => {
  it("does not crash on a view with missing fields", () => {
    const view = normalizeBranchView({ lineId: "b1" });
    expect(view.lineId).toBe("b1");
    expect(view.purpose).toBe("");
    expect(view.closedAt).toBeNull();
    expect(view.lineStatus).toBe("idle");
    expect(view.lastActivityAt).toBe("");
  });
});

describe("normalizeBranchDraft and detail", () => {
  it("defaults an unknown status and a missing card", () => {
    const draft = normalizeBranchDraft({ status: "weird" });
    expect(draft).toMatchObject({ status: "none", card: null, warnings: [], startedAt: null, uptoSeq: 0, manualCardAvailable: true });
  });

  it("fills every list of a partial card", () => {
    const draft = normalizeBranchDraft({ status: "ready", card: { question: "q", needsDecision: [{ branchClaim: "b", mainLineClaim: "", mainLineMessageId: "" }] } });
    expect(draft.card).toEqual({ question: "q", conclusion: "", evidence: [], impact: "", openItems: [], needsDecision: [{ branchClaim: "b", mainLineClaim: "" }], excerpts: [] });
  });

  it("defaults the tip and the draft of a detail", () => {
    const detail = normalizeBranchDetail({ branch: { lineId: "b" }, pack: {} });
    expect(detail.parentTipMessageId).toBe("");
    expect(detail.draft.status).toBe("none");
  });
});

describe("Go nil slices and wrong types (review H1)", () => {
  it("turns null lists of a detail into empty arrays", () => {
    const detail = normalizeBranchDetail({
      branch: { lineId: "b", kind: "aside", status: "nope" },
      pack: { recent: null, rendered: 5 },
      draft: { status: "ready", warnings: null, card: { question: "q", evidence: null, openItems: null, needsDecision: null, excerpts: null } },
    });
    expect(detail.pack.recent).toEqual([]);
    expect(detail.pack.rendered).toBe("");
    expect(detail.branch).toMatchObject({ kind: "aside", status: "open" });
    expect(detail.draft.warnings).toEqual([]);
    expect(detail.draft.card).toEqual({ question: "q", conclusion: "", evidence: [], impact: "", openItems: [], needsDecision: [], excerpts: [] });
  });

  it("survives a body that is not an object at all", () => {
    expect(normalizeBranchDetail(null).branch.lineId).toBe("");
    expect(normalizeBranchView("x").status).toBe("open");
    expect(normalizeBranchDraft([]).card).toBeNull();
  });
});
