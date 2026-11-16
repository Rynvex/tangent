import { describe, expect, it } from "vitest";
import { AI_FEATURES, featureMode, FEATURE_NAMES } from "../capabilities";
import { MOCK_FEATURE_PRESETS, mockCapabilities, type MockFeaturePreset } from "./scenario-nas";

const PRESETS = Object.keys(MOCK_FEATURE_PRESETS) as MockFeaturePreset[];
// The library's requirements (feature_*.go `requires`; parking needs notes too).
const REQUIRES: Record<string, string> = { rebalance: "leaf", group: "leaf", diverge: "leaf", fisheye: "leaf", memory: "notes", parking: "notes" };

describe("the settings' feature presets in the mock (F9 B.4)", () => {
  it.each(PRESETS)("%s names real features once, a mode only on AI features, and keeps every requirement", (preset) => {
    const entries = MOCK_FEATURE_PRESETS[preset].map((entry) => entry.split(":"));
    const names = entries.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const [name, mode] of entries) {
      expect(FEATURE_NAMES as readonly string[], name).toContain(name);
      expect(name, "the inbox is derived, never configured").not.toBe("suggestions");
      if (mode !== undefined) expect(AI_FEATURES.has(name as never), name).toBe(true);
      if (REQUIRES[name!]) expect(names, name).toContain(REQUIRES[name!]);
    }
  });

  it("reports each preset's features with their modes, every other one off, and the inbox only with a feature that proposes", () => {
    const standard = { features: mockCapabilities("standard") };
    expect(featureMode(standard, "summary")).toBe("suggest");
    expect(featureMode(standard, "ibis")).toBe("off");
    expect(featureMode(standard, "suggestions")).not.toBe("off");
    const research = { features: mockCapabilities("research") };
    expect(featureMode(research, "diverge")).toBe("manual");
    expect(featureMode(research, "memory")).toBe("off");
    const learning = { features: mockCapabilities("learning") };
    expect(featureMode(learning, "summary")).toBe("auto");
    expect(featureMode(learning, "branch_suggest")).toBe("off");
    expect(mockCapabilities("learning").map((feature) => feature.name)).toEqual([...FEATURE_NAMES]);
  });

  it("keeps the older sets as they were", () => {
    expect(mockCapabilities("all").every((feature) => feature.enabled)).toBe(true);
    expect(mockCapabilities("core").some((feature) => feature.enabled)).toBe(false);
    expect(mockCapabilities("c1").filter((feature) => feature.enabled).map((feature) => feature.name)).toEqual(["notes", "chapters", "aside", "summary", "card_draft"]);
  });
});
