// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { PrefsStorage } from "./prefs";
import { applyReadingFont, loadReadingFont, READING_FONT_KEY, saveReadingFont } from "./reading-font";

function memory(initial: Record<string, string> = {}): PrefsStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

const broken: PrefsStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("reading font (F10 §1)", () => {
  it("defaults to the modern sans, also when nothing, garbage or no storage is there", () => {
    expect(loadReadingFont(memory())).toBe("sans");
    expect(loadReadingFont(memory({ [READING_FONT_KEY]: "comic" }))).toBe("sans");
    expect(loadReadingFont(null)).toBe("sans");
    expect(loadReadingFont(broken)).toBe("sans");
  });

  it("round-trips through tg.readingFont", () => {
    const storage = memory();
    saveReadingFont(storage, "serif");
    expect(storage.data).toEqual({ "tg.readingFont": "serif" });
    expect(loadReadingFont(storage)).toBe("serif");
    saveReadingFont(storage, "sans");
    expect(loadReadingFont(storage)).toBe("sans");
  });

  it("does not throw when storage refuses", () => {
    expect(() => saveReadingFont(broken, "serif")).not.toThrow();
    expect(() => saveReadingFont(null, "serif")).not.toThrow();
  });

  it("sets data-tg-reading-font for serif and removes it for sans", () => {
    const html = document.documentElement;
    applyReadingFont(html, "serif");
    expect(html).toHaveAttribute("data-tg-reading-font", "serif");
    applyReadingFont(html, "sans");
    expect(html).not.toHaveAttribute("data-tg-reading-font");
  });
});
