import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { normalizeGroup } from "./group-routes";
import { activeGroupOf, groupSuggestionOf, selectionAction, suggestedAction } from "./groups";
import type { Suggestion } from "./types";

const branch = (lineId: string, over: Record<string, unknown> = {}) =>
  normalizeBranchView({ lineId, parentLineId: "root", rootLineId: "root", purpose: lineId, kind: "investigate", status: "open", ...over });
const ended = (lineId: string, over: Record<string, unknown> = {}) => branch(lineId, { status: "merged", conclusionLine: "done", ...over });

describe("what a selection of branches can become (C2)", () => {
  const groups = [normalizeGroup({ id: "g", memberLineIds: ["in-group"], status: "active" })];

  it("a group: 2–12 ended branches, each with an ending, none already in an active group", () => {
    expect(selectionAction([ended("a"), ended("b", { status: "discarded", conclusionLine: "", leaf: { kind: "dead_end", line: "no" } })], groups)).toEqual({ action: "group" });
    expect(selectionAction([ended("a")], groups)).toEqual({ action: null, reason: "tooFew" });
    expect(selectionAction([ended("a"), ended("b", { conclusionLine: "" })], groups)).toEqual({ action: null, reason: "noEnding" });
    expect(selectionAction([ended("a"), ended("in-group")], groups)).toEqual({ action: null, reason: "inGroup" });
    // R8: a branch promoted to the main line is no member.
    expect(selectionAction([ended("a"), ended("p", { status: "promoted" })], groups)).toEqual({ action: null, reason: "promoted" });
  });

  it("a combine: 2–12 open siblings that are not asides", () => {
    expect(selectionAction([branch("a"), branch("b")], [])).toEqual({ action: "combine" });
    expect(selectionAction([branch("a"), branch("b", { parentLineId: "x" })], [])).toEqual({ action: null, reason: "notSiblings" });
    expect(selectionAction([branch("a"), branch("b", { kind: "aside" })], [])).toEqual({ action: null, reason: "aside" });
  });

  it("a mix of open and ended branches is neither", () => {
    expect(selectionAction([branch("a"), ended("b")], [])).toEqual({ action: null, reason: "mixed" });
    expect(selectionAction(Array.from({ length: 13 }, (_, i) => ended(`b${i}`)), [])).toEqual({ action: null, reason: "tooMany" });
  });

  it("finds the active group a branch is in", () => {
    expect(activeGroupOf("in-group", groups)?.id).toBe("g");
    expect(activeGroupOf("in-group", [{ ...groups[0]!, status: "dissolved" }])).toBeNull();
  });
});

describe("a group suggestion", () => {
  const suggestion = (payload: Record<string, unknown>): Suggestion => ({ id: "s", rootLineId: "r", lineId: "r", feature: "group", kind: "group", targetKey: "", payload: payload as never, status: "open", createdAt: "", decidedAt: null });

  it("reads its members and conflicts; the default action follows the server's rule", () => {
    const proposal = groupSuggestionOf(
      suggestion({
        title: "T",
        members: [{ lineId: "a", purpose: "A", ended: true, leaf: "x" }, { lineId: "b", purpose: "B", ended: true, leaf: "y" }],
        conflicts: [{ id: "c1", branch: { lineId: "a", claim: "yes" }, other: { lineId: "b", claim: "no" } }],
      }),
    )!;
    expect(proposal.members.map((member) => member.lineId)).toEqual(["a", "b"]);
    expect(proposal.conflicts[0]).toMatchObject({ id: "c1", branch: { claim: "yes" } });
    expect(suggestedAction(proposal)).toBe("group");
    expect(suggestedAction({ ...proposal, members: proposal.members.map((member) => ({ ...member, ended: false })) })).toBe("combine");
    expect(groupSuggestionOf({ ...suggestion({}), feature: "goal" })).toBeNull();
  });
});
