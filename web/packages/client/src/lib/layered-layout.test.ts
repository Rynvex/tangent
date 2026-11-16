import { describe, expect, it } from "vitest";
import { edgePath, placeSlots, type LayoutMetrics } from "./layered-layout";

const metrics: LayoutMetrics = { cardWidth: 100, cardHeight: 40, columnStep: 150, rowStep: 60, padding: 10 };

describe("placeSlots", () => {
  it("puts depth on x and row on y when horizontal", () => {
    const { nodes, width, height } = placeSlots([{ key: "a", depth: 0, row: 0 }, { key: "b", depth: 1, row: 1.5 }], "horizontal", metrics);
    expect(nodes[1]).toMatchObject({ key: "b", x: 160, y: 100, width: 100, height: 40 });
    expect(width).toBe(10 * 2 + 2 * 150);
    expect(height).toBe(10 * 2 + 2.5 * 60);
  });

  it("swaps the axes when vertical", () => {
    const { nodes, width, height } = placeSlots([{ key: "a", depth: 2, row: 1 }], "vertical", metrics);
    expect(nodes[0]).toMatchObject({ x: 70, y: 310 });
    expect(width).toBe(10 * 2 + 2 * 60);
    expect(height).toBe(10 * 2 + 3 * 150);
  });

  it("sizes an empty layout to the padding plus one step", () => {
    expect(placeSlots([], "horizontal", metrics)).toEqual({ nodes: [], width: 170, height: 80 });
  });
});

describe("edgePath", () => {
  const from = { key: "a", depth: 0, row: 0, x: 0, y: 0, width: 100, height: 40 };
  const to = { key: "b", depth: 1, row: 0, x: 150, y: 60, width: 100, height: 40 };

  it("runs from the right edge to the left edge when horizontal", () => {
    expect(edgePath(from, to, "horizontal")).toBe("M 100 20 C 125 20, 125 80, 150 80");
  });

  it("runs from the bottom edge to the top edge when vertical", () => {
    expect(edgePath(from, to, "vertical")).toBe("M 50 40 C 50 65, 200 35, 200 60");
  });
});
