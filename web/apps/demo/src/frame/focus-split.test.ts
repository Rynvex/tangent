import { describe, expect, it } from "vitest";
import { CHAT_MIN_PX, chatWidth, defaultChatShare, limitOf, MAP_MIN_PX, nextRegion, panelPlacement, shareForKey, SPLIT_STEP } from "./focus-split";

describe("the split (FOCUS_MODE.md §4.2)", () => {
  it("starts at 50:50 on wide windows and 45:55 below 1440", () => {
    expect(defaultChatShare(1440)).toBe(0.5);
    expect(defaultChatShare(1280)).toBe(0.45);
    expect(defaultChatShare(1024)).toBe(0.45);
  });

  it("gives a 1280 window at least 640 px of map by default (the panel floats)", () => {
    const chat = chatWidth(1280, defaultChatShare(1280));
    expect(1280 - chat).toBeGreaterThanOrEqual(640);
    expect(panelPlacement(1280 - chat)).toBe("float");
  });

  it("keeps the chat ≥ 420 px and the map ≥ 360 px", () => {
    expect(chatWidth(1440, 0.1)).toBe(CHAT_MIN_PX);
    expect(chatWidth(1440, 0.95)).toBe(1440 - MAP_MIN_PX);
    expect(limitOf(1440, CHAT_MIN_PX)).toBe("chat");
    expect(limitOf(1440, 1440 - MAP_MIN_PX)).toBe("map");
    expect(limitOf(1440, 700)).toBeNull();
  });

  it("moves 5 % per arrow and jumps to either minimum with Home and End", () => {
    expect(shareForKey("ArrowLeft", 0.5, 1440)).toBeCloseTo(0.5 - SPLIT_STEP);
    expect(shareForKey("ArrowRight", 0.5, 1440)).toBeCloseTo(0.5 + SPLIT_STEP);
    expect(shareForKey("Home", 0.5, 1440)).toBeCloseTo(CHAT_MIN_PX / 1440);
    expect(shareForKey("End", 0.5, 1440)).toBeCloseTo((1440 - MAP_MIN_PX) / 1440);
    expect(shareForKey("ArrowLeft", CHAT_MIN_PX / 1440, 1440)).toBeCloseTo(CHAT_MIN_PX / 1440);
    expect(shareForKey("a", 0.5, 1440)).toBeNull();
  });

  it("puts the panel at the bottom when the map is narrower than 640 px", () => {
    expect(panelPlacement(639)).toBe("bottom");
    expect(panelPlacement(640)).toBe("float");
  });
});

describe("F6 between regions (§10)", () => {
  it("walks chat → map → panel and wraps; ⇧F6 walks back", () => {
    expect(nextRegion(3, 0, false)).toBe(1);
    expect(nextRegion(3, 2, false)).toBe(0);
    expect(nextRegion(3, 0, true)).toBe(2);
  });

  it("starts at the first (or, backwards, the last) region from outside them", () => {
    expect(nextRegion(3, -1, false)).toBe(0);
    expect(nextRegion(2, -1, true)).toBe(1);
    expect(nextRegion(0, -1, false)).toBe(-1);
  });
});
