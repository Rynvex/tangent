import { describe, expect, it } from "vitest";
import { fisheyeLevelOf, fisheyeMessages, normalizeFisheye, normalizePromptBudget, type FisheyeReport } from "./fisheye";
import { normalizeGroup } from "./group-routes";
import { mapFisheyeLevels } from "./p2-map";
import { normalizePreviewResult } from "./result-normalize";

const report = (items: unknown[]): FisheyeReport => normalizeFisheye({ items, tokens: 10, budget: 100 })!;

describe("the shared budget and the fisheye report (B9 phase B)", () => {
  it("fills the budget's defaults and keeps its shares in spending order", () => {
    expect(normalizePromptBudget(undefined)).toEqual({ total: 0, shares: [], history: 0, used: 0 });
    expect(normalizePromptBudget({ total: 40000, shares: [{ owner: "core", tokens: 9 }, { owner: "history", tokens: 30 }, { owner: 3 }], history: 24000, used: 39 })).toEqual({
      total: 40000,
      shares: [
        { owner: "core", tokens: 9 },
        { owner: "history", tokens: 30 },
        { owner: "", tokens: 0 },
      ],
      history: 24000,
      used: 39,
    });
  });

  it("reads a report; an unknown level counts as hidden and a missing report stays absent", () => {
    expect(normalizeFisheye(undefined)).toBeUndefined();
    const read = report([{ kind: "message", id: "m", lineId: "l", level: "summary", score: -5, tokens: 10 }, { kind: "weird", id: "b", level: "nope", score: 2 }]);
    expect(read.items).toEqual([
      { kind: "message", id: "m", lineId: "l", level: "summary", score: -5, tokens: 10 },
      { kind: "message", id: "b", lineId: "", level: "hidden", score: 2, tokens: 0 },
    ]);
    expect(read.tokens).toBe(10);
    expect(read.budget).toBe(100);
  });

  it("puts budget on every preview and the report only when the server sent one", () => {
    const plain = normalizePreviewResult({ blocks: [], budget: { total: 1, shares: [], history: 1, used: 0 } });
    expect(plain.budget.total).toBe(1);
    expect("fisheye" in plain).toBe(false);
    expect(normalizePreviewResult({ fisheye: { items: [] } }).fisheye).toEqual({ items: [], tokens: 0, budget: 0 });
  });
});

describe("reading a report for the interface", () => {
  const items = report([
    { kind: "message", id: "m1", lineId: "root", level: "hidden", score: -9 },
    { kind: "message", id: "m2", lineId: "root", level: "full", score: 95 },
    { kind: "branch", id: "b1", lineId: "b1", level: "leaf_only", score: 3 },
    { kind: "branch", id: "b2", lineId: "b2", level: "hidden", score: -5 },
  ]);

  it("lists the messages in prompt order and finds one's level", () => {
    expect(fisheyeMessages(items).map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(fisheyeLevelOf(items, "m2")).toBe("full");
    expect(fisheyeLevelOf(items, "zz")).toBeNull();
  });

  it("gives each map node a level: the line on screen and its ancestors in full, listed branches as reported, the rest hidden", () => {
    const levels = mapFisheyeLevels(items, { rootLineId: "root", currentLineId: "c", ancestors: ["root", "p"], nodeKeys: ["__main__", "p", "c", "b1", "b2", "b3"] });
    expect(Object.fromEntries(levels)).toEqual({ __main__: "full", p: "full", c: "full", b1: "leaf_only", b2: "hidden", b3: "hidden" });
  });

  it("a group item (C2) stands for its members: each member node takes the group's level", () => {
    const withGroup = report([...items.items, { kind: "group", id: "g1", lineId: "", level: "summary", score: 4 }]);
    const groups = [normalizeGroup({ id: "g1", memberLineIds: ["b2", "b3", "c"], status: "active" })];
    const levels = mapFisheyeLevels(withGroup, { rootLineId: "root", currentLineId: "c", ancestors: ["root"], nodeKeys: ["__main__", "c", "b1", "b2", "b3"], groups });
    expect(Object.fromEntries(levels)).toEqual({ __main__: "full", c: "full", b1: "leaf_only", b2: "summary", b3: "summary" });
  });
});
