import { describe, expect, it } from "vitest";
import { mergeReplyToast } from "./reply-toast";
import { LIST_WIDTH, SIDE_WIDTH, clampListWidth, clampSideWidth, listWidthForKey, listWidthMax, sideWidthMax, widthForKey } from "./side-resizer";

describe("S2 conversation list width", () => {
  it("keeps the conversation at least 480 px wide: min(560, window − 480)", () => {
    expect(listWidthMax(1440)).toBe(560);
    expect(listWidthMax(800)).toBe(320);
    expect(listWidthMax(600)).toBe(LIST_WIDTH.min);
    expect(clampListWidth(600, 560)).toBe(560);
    expect(clampListWidth(150, 560)).toBe(200);
  });

  it("moves 16 px per arrow (64 with Shift); → widens, Home / End reach the bounds, Enter resets to 264", () => {
    expect(listWidthForKey("ArrowRight", false, 264, 560)).toBe(280);
    expect(listWidthForKey("ArrowLeft", true, 360, 560)).toBe(296);
    expect(listWidthForKey("ArrowLeft", true, 220, 560)).toBe(200);
    expect(listWidthForKey("Home", false, 400, 560)).toBe(200);
    expect(listWidthForKey("End", false, 400, 500)).toBe(500);
    expect(listWidthForKey("Enter", false, 500, 560)).toBe(264);
    expect(listWidthForKey("x", false, 500, 560)).toBeNull();
  });
});

describe("S3 side panel width (decision #9)", () => {
  it("keeps the conversation at least 480 px wide: min(600, window − list − 480)", () => {
    expect(sideWidthMax(1440, 264)).toBe(600);
    expect(sideWidthMax(1280, 264)).toBe(536);
    expect(sideWidthMax(1100, 56)).toBe(564);
    // Never under the minimum, however narrow.
    expect(sideWidthMax(900, 264)).toBe(SIDE_WIDTH.min);
    expect(clampSideWidth(700, 536)).toBe(536);
    expect(clampSideWidth(100, 536)).toBe(280);
  });

  it("moves 16 px per arrow (64 with Shift); ← widens, Home / End reach the bounds, Enter resets to 360", () => {
    expect(widthForKey("ArrowLeft", false, 360, 600)).toBe(376);
    expect(widthForKey("ArrowRight", true, 360, 600)).toBe(296);
    expect(widthForKey("ArrowRight", true, 300, 600)).toBe(280);
    expect(widthForKey("Home", false, 400, 600)).toBe(280);
    expect(widthForKey("End", false, 400, 536)).toBe(536);
    expect(widthForKey("Enter", false, 500, 600)).toBe(360);
    expect(widthForKey("a", false, 500, 600)).toBeNull();
  });
});

describe("S4 background reply toast (decision #4)", () => {
  it("merges lines answering while it shows; 前往查看 goes to the newest; a failure stands alone", () => {
    const one = mergeReplyToast(null, { lineId: "a", title: "A", failed: false, aside: true });
    expect(one).toMatchObject({ lineId: "a", count: 1 });
    const two = mergeReplyToast(one, { lineId: "b", title: "B", failed: false, aside: false });
    expect(two).toMatchObject({ lineId: "b", title: "B", count: 2 });
    expect(two.n).toBeGreaterThan(one.n);
    // Distinct lines: the same line again, or one already counted, adds nothing.
    expect(mergeReplyToast(two, { lineId: "b", title: "B", failed: false, aside: false }).count).toBe(2);
    expect(mergeReplyToast(two, { lineId: "a", title: "A", failed: false, aside: true })).toMatchObject({ lineId: "a", count: 2 });
    expect(mergeReplyToast(two, { lineId: "c", title: "C", failed: true, aside: false })).toMatchObject({ count: 1, failed: true });
  });
});
