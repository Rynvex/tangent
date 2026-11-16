import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { DEFAULT_COMPARISON_LIMITS, normalizeComparison, normalizeComparisonList, normalizeConvergeStarted, normalizeDecideResult } from "./comparison-routes";
import { cellOf, convergeProblem, divergeGroups, optionLabel } from "./diverge";
import { parseEvent } from "./events";

const matrix = {
  criteria: ["Safety", "Speed"],
  options: [
    { lineId: "a", label: "A" },
    { lineId: "b", label: "B" },
  ],
  scores: [
    [{ score: 5, why: "safe" }, { score: 4, why: "ok" }],
    [{ score: 0, why: "" }, { score: 9, why: "too high" }],
  ],
  recommendation: { lineId: "a", reason: "A is safest" },
};

describe("B10 phase B shapes: comparisons", () => {
  it("reads a comparison with its defaults; the matrix only once ready", () => {
    expect(normalizeComparison({ id: "c", status: "weird" })).toEqual({
      id: "c",
      rootLineId: "",
      parentLineId: "",
      lineIds: [],
      criteria: [],
      status: "drafting",
      matrix: null,
      decidedLineId: "",
      createdBy: "",
      decidedBy: "",
      createdAt: "",
      updatedAt: "",
      decidedAt: null,
    });
    const ready = normalizeComparison({ id: "c", status: "ready", matrix });
    expect(ready.matrix?.scores[1]).toEqual([
      { score: 0, why: "" },
      { score: 0, why: "too high" },
    ]);
    expect(ready.matrix?.recommendation).toEqual({ lineId: "a", reason: "A is safest" });
  });

  it("fills the list's limits; converge has its job; decide has the chosen branch, its decision and the discarded ones", () => {
    expect(normalizeComparisonList({}).limits).toEqual(DEFAULT_COMPARISON_LIMITS);
    expect(normalizeConvergeStarted({ comparison: { id: "c" }, job: { jobId: "j", kind: "converge", lineId: "p" } }).job.kind).toBe("converge");
    const decided = normalizeDecideResult({ comparison: { id: "c", status: "decided" }, chosen: { lineId: "a", origin: "diverge" }, decision: { kind: "decision", line: "A" }, discarded: [{ lineId: "b", status: "discarded" }] });
    expect([decided.chosen.origin, decided.decision.kind, decided.discarded.map((branch) => branch.lineId)]).toEqual(["diverge", "decision", ["b"]]);
  });

  it("parses comparison.changed", () => {
    const event = parseEvent("comparison.changed", JSON.stringify({ type: "comparison.changed", tenant: "", lineId: "p", rootLineId: "r", data: { rootLineId: "r", comparison: { id: "c", status: "ready" } } }));
    expect(event).toMatchObject({ type: "comparison.changed", data: { rootLineId: "r", comparison: { id: "c", status: "ready" } } });
  });
});

describe("diverge and converge on screen (D3)", () => {
  const branch = (lineId: string, over: Record<string, unknown> = {}) => normalizeBranchView({ lineId, parentLineId: "p", anchorMessageId: "m1", origin: "diverge", kind: "alternative", status: "open", ...over });

  it("groups a line's diverged branches by the message they came from", () => {
    const groups = divergeGroups([branch("a"), branch("b"), branch("c", { anchorMessageId: "m2" }), branch("d", { origin: "button" }), branch("e", { parentLineId: "q" })], "p");
    expect([...groups.entries()].map(([anchor, items]) => [anchor, items.map((item) => item.lineId)])).toEqual([
      ["m1", ["a", "b"]],
      ["m2", ["c"]],
    ]);
  });

  it("says why a set of branches cannot be compared", () => {
    expect(convergeProblem([branch("a")])).toBe("tooFew");
    expect(convergeProblem([branch("a"), branch("b", { status: "merged" })])).toBe("ended");
    expect(convergeProblem(["a", "b", "c", "d", "e", "f"].map((id) => branch(id)))).toBe("tooMany");
    expect(convergeProblem([branch("a"), branch("b")])).toBeNull();
  });

  it("reads a cell (a missing score is 0) and names an option", () => {
    const ready = normalizeComparison({ id: "c", status: "ready", matrix }).matrix!;
    expect(cellOf(ready, 0, 1)).toEqual({ score: 4, why: "ok" });
    expect(cellOf(ready, 5, 5)).toEqual({ score: 0, why: "" });
    expect(optionLabel(ready, "b")).toBe("B");
    expect(optionLabel(ready, "zz")).toBe("");
  });
});
