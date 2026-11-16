import { describe, expect, it } from "vitest";

/** Every component source of the package (tests excluded). */
const sources = import.meta.glob<string>(["./**/*.tsx", "!./**/*.test.tsx"], { query: "?raw", import: "default", eager: true });

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTILITY = "bg|text|border|ring|outline|fill|stroke|shadow|from|via|to|decoration|divide|placeholder|caret|accent";
const TAILWIND_PALETTE = new RegExp(`\\b(?:${UTILITY})-(?:black|white|(?:${PALETTE})-\\d{2,3})\\b`);
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/;

describe("package components use only --tg-* tokens (handoff components.md)", () => {
  it("finds the component sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it.each(Object.entries(sources))("%s has no palette classes or raw colours", (_path, source) => {
    expect(source).not.toMatch(TAILWIND_PALETTE);
    expect(source).not.toMatch(RAW_COLOR);
  });
});
