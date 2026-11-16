import { describe, expect, it } from "vitest";
import {
  isHostNotice,
  asideDaysLeft,
  branchLoad,
  cardDelivery,
  chatNumbers,
  classifyOpenBranchError,
  forkContext,
  messagesSince,
  promotePlan,
} from "./branch-view";
import { TangentError } from "./errors";
import { message } from "./test-helpers";
import type { BranchView } from "./types";

const seqd = (id: string, role: "user" | "assistant" | "system", seq: number, kind: "chat" | "branch_card" | "branch_marker" = "chat") =>
  message(id, role, { seq, kind });

const main = [seqd("u1", "user", 1), seqd("a1", "assistant", 2), seqd("c1", "system", 3, "branch_card"), seqd("u2", "user", 4), seqd("a2", "assistant", 5), seqd("u3", "user", 6)];

function branch(lineId: string, over: Partial<BranchView> = {}): BranchView {
  return {
    lineId,
    parentLineId: "root",
    rootLineId: "root",
    anchorMessageId: "a1",
    depth: 1,
    purpose: lineId,
    kind: "investigate",
    status: "open",
    origin: "button",
    excerpt: "",
    conclusionLine: "",
    cardMessageId: "",
    provider: "",
    model: "",
    lineStatus: "idle",
    unread: 0,
    messageCount: 0,
    draftStatus: "none",
    archived: false,
    createdAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    lastActivityAt: "2026-01-01T00:00:00Z",
    leaf: null,
    mergedIntoLineId: "",
    ...over,
  };
}

describe("isHostNotice (B7.2)", () => {
  it("is a host's system message: role system, kind chat; never the library's cards or markers", () => {
    expect(isHostNotice({ role: "system", kind: "chat" })).toBe(true);
    expect(isHostNotice({ role: "system", kind: "branch_card" })).toBe(false);
    expect(isHostNotice({ role: "system", kind: "branch_marker" })).toBe(false);
    expect(isHostNotice({ role: "assistant", kind: "chat" })).toBe(false);
  });
});

describe("chatNumbers", () => {
  it("numbers the user and assistant chat messages by seq, skipping cards and markers", () => {
    const numbers = chatNumbers([...main].reverse());
    expect([...numbers.entries()]).toEqual([
      ["u1", 1],
      ["a1", 2],
      ["u2", 3],
      ["a2", 4],
      ["u3", 5],
    ]);
  });
});

describe("forkContext", () => {
  it("gives the anchor with the chat message before and after it", () => {
    const context = forkContext(main, "a1");
    expect([context.before?.id, context.anchor?.id, context.after?.id]).toEqual(["u1", "a1", "u2"]);
  });

  it("has no neighbours at the edges and no anchor when it is gone", () => {
    expect(forkContext(main, "u1").before).toBeNull();
    expect(forkContext(main, "u3").after).toBeNull();
    expect(forkContext(main, "gone")).toEqual({ before: null, anchor: null, after: null });
  });
});

describe("messagesSince", () => {
  it("lists the chat messages after the tip, by seq", () => {
    expect(messagesSince(main, "a1").map((m) => m.id)).toEqual(["u2", "a2", "u3"]);
  });

  it("is empty when the tip is the last message, unknown or empty", () => {
    expect(messagesSince(main, "u3")).toEqual([]);
    expect(messagesSince(main, "nope")).toEqual([]);
    expect(messagesSince(main, "")).toEqual([]);
  });
});

describe("branchLoad", () => {
  it("counts the open branches under one parent and every branch of the tree", () => {
    const branches = [branch("b1"), branch("b2", { status: "merged" }), branch("b3", { parentLineId: "b1" })];
    expect(branchLoad(branches, "root")).toEqual({ openUnderParent: 1, total: 3 });
    expect(branchLoad(branches, "b1")).toEqual({ openUnderParent: 1, total: 3 });
  });
});

describe("promotePlan", () => {
  it("counts what stays, what is put away and what moves up", () => {
    const branches = [
      branch("promoted", { anchorMessageId: "a1", messageCount: 4 }),
      branch("child", { parentLineId: "promoted", anchorMessageId: "x" }),
      branch("onTail", { anchorMessageId: "a2" }),
      branch("deep", { parentLineId: "onTail", anchorMessageId: "y", status: "open" }),
      branch("closedOnTail", { anchorMessageId: "u2", status: "merged" }),
    ];
    const plan = promotePlan(branches[0]!, main, branches);
    expect(plan).toMatchObject({ anchorNumber: 2, tailCount: 3, firstTailNumber: 3, branchMessages: 4 });
    expect(plan.blockers.map((b) => b.lineId)).toEqual(["onTail", "deep"]);
    expect(plan.lifted.map((b) => b.lineId)).toEqual(["child"]);
  });

  it("has nothing to put away when the anchor is the last message", () => {
    const plan = promotePlan(branch("p", { anchorMessageId: "u3" }), main, []);
    expect(plan).toMatchObject({ tailCount: 0, firstTailNumber: null, blockers: [] });
  });
});

describe("asideDaysLeft", () => {
  const day = 24 * 60 * 60 * 1000;
  it("counts whole days until the purge, rounding up", () => {
    const closed = "2026-01-01T00:00:00Z";
    expect(asideDaysLeft(closed, Date.parse(closed) + day / 2)).toBe(7);
    expect(asideDaysLeft(closed, Date.parse(closed) + 6.5 * day)).toBe(1);
    expect(asideDaysLeft(closed, Date.parse(closed) + 8 * day)).toBe(0);
  });

  it("is the full period while the aside is still open", () => {
    expect(asideDaysLeft(null, Date.now())).toBe(7);
    expect(asideDaysLeft("not a date", Date.now())).toBe(7);
  });
});

describe("cardDelivery", () => {
  it("is pending until a turn carried the card", () => {
    const card = seqd("c", "system", 1, "branch_card");
    expect(cardDelivery(card)).toBe("pending");
    expect(cardDelivery({ ...card, meta: { delivered: true } })).toBe("delivered");
  });
});

describe("classifyOpenBranchError", () => {
  const err = (status: number, code: string, extra: Record<string, unknown> = {}) => new TangentError(status, code, code, extra);

  it("asks to confirm a deeper branch with the depth and limit from the error", () => {
    expect(classifyOpenBranchError(err(409, "depth_soft_limit", { depth: 4, limit: 3 }))).toEqual({ kind: "depth", depth: 4, limit: 3 });
  });

  it("names the per-line and per-tree limits", () => {
    expect(classifyOpenBranchError(err(409, "branch_limit", { limit: 8 }))).toEqual({ kind: "branchLimit", limit: 8 });
    expect(classifyOpenBranchError(err(409, "tree_limit"))).toEqual({ kind: "treeLimit", limit: 200 });
  });

  it("knows a gone fork point, field problems and refused models", () => {
    expect(classifyOpenBranchError(err(404, "anchor_not_found"))).toEqual({ kind: "anchorGone" });
    expect(classifyOpenBranchError(err(422, "too_long", { field: "purpose", max: 120 }))).toEqual({ kind: "purposeTooLong", max: 120 });
    expect(classifyOpenBranchError(err(422, "model_not_allowed", { provider: "x", model: "y" }))).toEqual({ kind: "model" });
    expect(classifyOpenBranchError(err(404, "feature_disabled", { feature: "aside" }))).toEqual({ kind: "featureOff", feature: "aside" });
    expect(classifyOpenBranchError(new Error("boom"))).toEqual({ kind: "other" });
  });
});
