import { describe, expect, it } from "vitest";
import { layoutFor } from "./layout";

describe("layoutFor (handoff width rules)", () => {
  it.each([
    [1440, "column", "column", true],
    [1280, "column", "column", true],
    [1279, "rail", "column", true],
    [1100, "rail", "column", true],
    [1099, "rail", "overlay", false],
    [1024, "rail", "overlay", false],
    [1023, "drawer", "overlay", false],
    [768, "drawer", "overlay", false],
    [767, "drawer", "sheet", false],
    [375, "drawer", "sheet", false],
  ] as const)("%i px: list %s, side %s, open %s", (width, list, side, open) => {
    const layout = layoutFor(width, "app");
    expect([layout.list, layout.side, layout.sideOpenByDefault]).toEqual([list, side, open]);
  });

  it("embeds without the list, with the outline over the conversation", () => {
    expect(layoutFor(420, "embed")).toEqual({ list: "none", side: "overlay", sideOpenByDefault: false, narrow: true });
    expect(layoutFor(1440, "embed").list).toBe("none");
  });
});
