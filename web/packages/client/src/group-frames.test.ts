import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { BRANCH_MAP_METRICS, buildBranchMapLayout } from "./branch-map-layout";
import { normalizeGroup } from "./group-routes";
import { GROUP_BOX, GROUP_ROOM, groupFrames } from "./group-frames";

const branch = (lineId: string, parentLineId = "root") =>
  normalizeBranchView({ lineId, parentLineId, rootLineId: "root", purpose: lineId, kind: "investigate", status: "merged", conclusionLine: "done" });
const group = (id: string, memberLineIds: string[], over: Record<string, unknown> = {}) => normalizeGroup({ id, title: id, memberLineIds, status: "active", summaryStatus: "ready", summary: "s", ...over });

const branches = [branch("a"), branch("b"), branch("c"), branch("d"), branch("a1", "a")];
const layout = (collapsed: ReadonlySet<string> = new Set()) => buildBranchMapLayout(branches, { collapsed, direction: "horizontal", currentId: null, metrics: BRANCH_MAP_METRICS });

describe("where a group's frame, bracket and summary go on the map (C2)", () => {
  it("frames the visible members; the summary sits right of the tree, level with the frame", () => {
    const map = layout();
    const [frame] = groupFrames(map, [group("g", ["b", "c"])]).frames;
    const b = map.byKey.get("b")!;
    const c = map.byKey.get("c")!;
    expect(frame).toMatchObject({ groupId: "g", members: ["b", "c"], hidden: 0 });
    expect(frame!.x).toBeLessThan(b.x);
    expect(frame!.y).toBeLessThan(b.y);
    expect(frame!.x + frame!.width).toBeGreaterThan(b.x + b.width);
    expect(frame!.y + frame!.height).toBeGreaterThan(c.y + c.height);
    expect(frame!.box.x).toBeGreaterThanOrEqual(map.width);
    expect(frame!.box.y + frame!.box.height / 2).toBeCloseTo(frame!.y + frame!.height / 2, 0);
    expect(frame!.bracket).toContain("M");
  });

  it("stacks summaries that would overlap, and grows the map to fit them", () => {
    const map = layout();
    const { frames, height, room } = groupFrames(map, [group("g1", ["b", "c"]), group("g2", ["c", "d"])]);
    expect(frames[1]!.box.y).toBeGreaterThanOrEqual(frames[0]!.box.y + GROUP_BOX.height);
    expect(height).toBeGreaterThanOrEqual(frames[1]!.box.y + GROUP_BOX.height);
    expect(room).toBe(GROUP_ROOM);
  });

  it("counts members folded away and skips a group with none shown, and dissolved groups", () => {
    const map = layout(new Set(["a"]));
    const { frames } = groupFrames(map, [group("g", ["a1", "b"]), group("gone", ["a1", "a1x"]), group("old", ["b", "c"], { status: "dissolved" })]);
    expect(frames.map((frame) => [frame.groupId, frame.hidden])).toEqual([["g", 1]]);
  });

  it("puts the summaries after a given offset (the relation layer's room)", () => {
    const map = layout();
    expect(groupFrames(map, [group("g", ["b", "c"])], { offsetX: 100 }).frames[0]!.box.x).toBeGreaterThanOrEqual(map.width + 100);
    expect(groupFrames(map, []).room).toBe(0);
  });
});
