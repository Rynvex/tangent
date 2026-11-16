import { describe, expect, it } from "vitest";
import { normalizeSuggestion } from "./p1-routes";
import { lastSpinoff, rebalanceOf, rebalanceResultOf, spinoffModes } from "./spinoff";
import { fixture } from "./testing/scenario";

const msg = (id: string, seq: number, role: "user" | "assistant", content: string) => fixture.message({ id, lineId: "b", seq, role, content });
const messages = [msg("u1", 1, "user", "a".repeat(40)), msg("a1", 2, "assistant", "b".repeat(40)), msg("u2", 3, "user", "c".repeat(40)), msg("a2", 4, "assistant", "d".repeat(40))];

describe("spinoff modes (B2)", () => {
  it("offers detach only for an open, non-aside branch, and fresh from a done chat message", () => {
    expect(spinoffModes({ branchStatus: "open", kind: "investigate", atMessageId: "a2" })).toEqual(["detach", "fresh"]);
    expect(spinoffModes({ branchStatus: "merged", kind: "investigate", atMessageId: "a2" })).toEqual(["fresh"]);
    expect(spinoffModes({ branchStatus: null, kind: null, atMessageId: "a2" })).toEqual(["fresh"]);
    expect(spinoffModes({ branchStatus: "open", kind: "aside", atMessageId: "" })).toEqual([]);
  });
});

describe("rebalance suggestions (B4)", () => {
  it("reads the payload, keeping only the actions it knows", () => {
    const suggestion = normalizeSuggestion({
      feature: "rebalance",
      kind: "promote_or_spinoff",
      lineId: "b",
      payload: { reason: "share", branchTurns: 7, parentTurns: 2, recentInBranch: false, actions: ["promote", "spinoff", "teleport"], parentIsMain: false, parentTitle: "Disks" },
    });
    expect(rebalanceOf(suggestion)).toEqual({ lineId: "b", reason: "share", branchTurns: 7, parentTurns: 2, recentInBranch: false, actions: ["promote", "spinoff"], parentIsMain: false, parentTitle: "Disks" });
    // An older server's payload: the parent counts as the main line.
    expect(rebalanceOf({ ...suggestion, payload: { reason: "share" } })).toMatchObject({ parentIsMain: true, parentTitle: "" });
    expect(rebalanceOf(normalizeSuggestion({ feature: "suggestion_probe", kind: "probe" }))).toBeNull();
  });

  it("reads an accepted rebalance's result", () => {
    const result = rebalanceResultOf({ action: "spinoff", line: { id: "n" }, link: { id: "l" } });
    expect(result?.action).toBe("spinoff");
    expect(result?.line.id).toBe("n");
    expect(result?.link?.id).toBe("l");
    expect(rebalanceResultOf({ accepted: true })).toBeNull();
  });
});

describe("lastSpinoff", () => {
  it("finds the newest spinoff marker of a line, ignoring move markers", () => {
    const marker = (id: string, seq: number, meta: Record<string, unknown>) => fixture.message({ id, lineId: "b", seq, role: "system", kind: "branch_marker", meta });
    expect(lastSpinoff(messages)).toBeNull();
    const list = [...messages, marker("m1", 5, { spunOffTo: { lineId: "x", messageId: "a1", title: "X" } }), marker("m2", 6, { branchLineId: "y" })];
    expect(lastSpinoff(list)).toEqual({ lineId: "x", messageId: "a1", title: "X", available: true, markerId: "m1" });
  });
});
