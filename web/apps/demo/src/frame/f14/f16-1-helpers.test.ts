/** F16.1's small helpers: the Shift range of the multi-select and the drag's edge scroll speed. */
import { describe, expect, it } from "vitest";
import { edgeSpeed } from "./use-drag-autoscroll";
import { rangeOf } from "./use-session-selection";

describe("rangeOf", () => {
  const shown = ["a", "b", "c", "d", "e"];

  it("takes every shown key between the last toggled and this one, either way", () => {
    expect(rangeOf(shown, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeOf(shown, "e", "c")).toEqual(["c", "d", "e"]);
  });

  it("takes just this one without a last toggled one that is shown", () => {
    expect(rangeOf(shown, null, "c")).toEqual(["c"]);
    expect(rangeOf(shown, "x", "c")).toEqual(["c"]);
  });
});

describe("edgeSpeed", () => {
  it("scrolls up near the top and down near the bottom, faster closer to the edge", () => {
    expect(edgeSpeed(100, 100, 600)).toBeLessThan(edgeSpeed(130, 100, 600));
    expect(edgeSpeed(130, 100, 600)).toBeLessThan(0);
    expect(edgeSpeed(590, 100, 600)).toBeGreaterThan(edgeSpeed(560, 100, 600));
    expect(edgeSpeed(560, 100, 600)).toBeGreaterThan(0);
  });

  it("stays still away from the edges, outside the box and in a box too short for two edges", () => {
    expect(edgeSpeed(350, 100, 600)).toBe(0);
    expect(edgeSpeed(50, 100, 600)).toBe(0);
    expect(edgeSpeed(110, 100, 180)).toBe(0);
  });
});
