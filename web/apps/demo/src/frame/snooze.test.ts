import { describe, expect, it } from "vitest";
import type { PrefsStorage } from "./prefs";
import { isSnoozed, loadSnoozes, reviewKey, saveSnoozes, SNOOZE_MS, snooze, unsnooze } from "./snooze";

function memory(initial: Record<string, string> = {}): PrefsStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

describe("review snoozes (C5 暫存: this browser only, DESIGN §12 B9)", () => {
  const now = 1_000_000;

  it("snoozes an item for a day, then it comes back", () => {
    const key = reviewKey("seeds", "s1");
    const snoozed = snooze({}, key, now);
    expect(isSnoozed(snoozed, key, now + SNOOZE_MS - 1)).toBe(true);
    expect(isSnoozed(snoozed, key, now + SNOOZE_MS)).toBe(false);
    expect(isSnoozed(unsnooze(snoozed, key), key, now)).toBe(false);
  });

  it("round-trips through storage, drops expired entries and junk, and never throws", () => {
    const storage = memory();
    saveSnoozes(storage, { "seeds:a": now + 10, "seeds:b": now - 1 });
    expect(loadSnoozes(storage, now)).toEqual({ "seeds:a": now + 10 });
    expect(loadSnoozes(memory({ "tangent-demo.review-snoozes": "{bad" }), now)).toEqual({});
    expect(loadSnoozes(memory({ "tangent-demo.review-snoozes": JSON.stringify({ x: "soon", y: 5 }) }), 0)).toEqual({ y: 5 });
    expect(loadSnoozes(null, now)).toEqual({});
    const refusing: PrefsStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSnoozes(refusing, now)).toEqual({});
    expect(() => saveSnoozes(refusing, {})).not.toThrow();
  });
});
