import { describe, expect, it } from "vitest";
import { stillPinned } from "./hooks";

describe("following the bottom of the conversation", () => {
  const at = (top: number, lastTop: number, height = 1000, client = 500) => ({ top, lastTop, height, client });

  it("stays pinned at the bottom, and when the page itself moves down (content laid out, scrolled to the end)", () => {
    expect(stillPinned(true, at(500, 480))).toBe(true);
    // Rows that take their real height after the scroll leave it far from the bottom: not the reader's doing.
    expect(stillPinned(true, at(300, 200, 1200))).toBe(true);
  });

  it("lets go when the reader scrolls up, and pins again at the bottom", () => {
    expect(stillPinned(true, at(300, 500))).toBe(false);
    expect(stillPinned(false, at(320, 300))).toBe(false);
    expect(stillPinned(false, at(470, 300))).toBe(true);
  });
});
