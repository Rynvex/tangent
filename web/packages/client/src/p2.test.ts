import { describe, expect, it } from "vitest";
import type { Capabilities } from "./capabilities";
import { inboxCount } from "./p1";
import {
  driftByMessage,
  driftOf,
  GOAL_TEXT_MAX,
  goalLine,
  goalProposalOf,
  idleDays,
  relationSuggestionOf,
  validateGoal,
} from "./p2";
import { relationsOnMap, sameRelationEnds } from "./p2-map";
import type { Link, Suggestion } from "./types";

const caps = (...on: string[]): Capabilities => ({ features: on.map((name) => ({ name, enabled: true })) as Capabilities["features"] });

function suggestion(over: Partial<Suggestion>): Suggestion {
  return { id: "s", rootLineId: "r", lineId: "r", feature: "goal", kind: "goal_propose", targetKey: "", payload: {}, status: "open", createdAt: "2026-01-01T00:00:00Z", decidedAt: null, ...over };
}

function link(over: Partial<Link>): Link {
  return { id: "x", kind: "relation", fromLineId: "", fromMessageId: "", toLineId: "", toMessageId: "", label: "", fromTitle: "", toTitle: "", createdBy: "", createdAt: "", ...over };
}

describe("the 待處理 count (B9)", () => {
  it("adds the stale branches while open_loops is on", () => {
    const line = { openSeeds: 3, openSuggestions: 1, staleBranches: 2 };
    expect(inboxCount(caps("parking", "suggestions", "open_loops"), line)).toBe(6);
    expect(inboxCount(caps("parking", "suggestions"), line)).toBe(4);
    expect(inboxCount(caps("open_loops"), line)).toBe(2);
  });
});

describe("goal text", () => {
  it("is one line, required and at most 300 characters", () => {
    expect(goalLine("  a\n b  ")).toBe("a b");
    expect(validateGoal(" ")).toBe("required");
    expect(validateGoal("x".repeat(GOAL_TEXT_MAX))).toBeNull();
    expect(validateGoal("字".repeat(GOAL_TEXT_MAX + 1))).toBe("tooLong");
  });
});

describe("suggestion payloads", () => {
  it("reads a goal proposal", () => {
    expect(goalProposalOf(suggestion({ payload: { text: "Plan" } }))).toEqual({ text: "Plan" });
    expect(goalProposalOf(suggestion({ kind: "drift" }))).toBeNull();
    expect(goalProposalOf(suggestion({ payload: { text: 3 } }))).toBeNull();
  });

  it("reads a drift hint", () => {
    const drift = suggestion({ kind: "drift", payload: { anchorMessageId: "m", kind: "aside", purpose: "p", reason: "why", goal: "g" } });
    expect(driftOf(drift)).toEqual({ anchorMessageId: "m", kind: "aside", purpose: "p", reason: "why", goal: "g" });
    expect(driftOf(suggestion({ kind: "drift", payload: { anchorMessageId: "m", kind: "weird" } }))).toMatchObject({ kind: "investigate", purpose: "", reason: "" });
    expect(driftOf(suggestion({ kind: "drift", payload: {} }))).toBeNull();
    expect(driftOf(suggestion({ feature: "relations", kind: "drift", payload: { anchorMessageId: "m" } }))).toBeNull();
  });

  it("keeps one open drift hint per reply, the newest", () => {
    const older = suggestion({ id: "a", kind: "drift", payload: { anchorMessageId: "m1" }, createdAt: "2026-01-01T00:00:00Z" });
    const newer = suggestion({ id: "b", kind: "drift", payload: { anchorMessageId: "m1" }, createdAt: "2026-01-02T00:00:00Z" });
    const done = suggestion({ id: "c", kind: "drift", payload: { anchorMessageId: "m2" }, status: "dismissed" });
    const map = driftByMessage([older, newer, done, suggestion({ id: "g" })]);
    expect([...map.keys()]).toEqual(["m1"]);
    expect(map.get("m1")?.id).toBe("b");
  });

  it("reads a relation suggestion", () => {
    const payload = { fromLineId: "a", toLineId: "b", fromTitle: "A", toTitle: "B", label: "L" };
    expect(relationSuggestionOf(suggestion({ feature: "relations", kind: "relation", payload }))).toEqual({ ...payload, relationKind: "related" });
    expect(relationSuggestionOf(suggestion({ feature: "relations", kind: "relation", payload: { ...payload, relationKind: "contradicts" } }))?.relationKind).toBe("contradicts");
    expect(relationSuggestionOf(suggestion({ feature: "relations", kind: "relation", payload: { fromLineId: "a" } }))).toBeNull();
  });
});

describe("relations on the map", () => {
  it("draws the ones with both ends on the tree's nodes (the main line as the root key) and lists the rest", () => {
    const nodes = new Set(["__main__", "b1", "b2"]);
    const inside = link({ id: "in", fromLineId: "root", toLineId: "b2" });
    const cross = link({ id: "out", fromLineId: "b1", toLineId: "other" });
    const result = relationsOnMap([inside, cross], "root", nodes);
    expect(result.drawn).toEqual([{ relation: inside, from: "__main__", to: "b2" }]);
    expect(result.elsewhere.map((item) => item.id)).toEqual(["out"]);
  });

  it("matches two ends in either direction", () => {
    expect(sameRelationEnds(link({ fromLineId: "a", toLineId: "b" }), { lineId: "b" }, { lineId: "a" })).toBe(true);
    expect(sameRelationEnds(link({ fromLineId: "a", fromMessageId: "m", toLineId: "b" }), { lineId: "a" }, { lineId: "b" })).toBe(false);
  });
});

describe("idle days", () => {
  it("counts whole days since the last activity", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(idleDays("2026-10-14T11:00:00Z", now)).toBe(3);
    expect(idleDays("2026-10-17T11:00:00Z", now)).toBe(0);
    expect(idleDays("", now)).toBe(0);
  });
});
