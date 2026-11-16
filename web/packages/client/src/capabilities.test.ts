import { describe, expect, it } from "vitest";
import { AI_FEATURES, FEATURE_NAMES, featureMode, isFeatureOn, normalizeCapabilities, canWrite, modelChoices } from "./capabilities";

describe("capabilities ({name, enabled, mode?}, DESIGN §12)", () => {
  it("keeps known features, mode only on enabled AI features", () => {
    const caps = normalizeCapabilities({
      features: [
        { name: "notes", enabled: true, mode: "auto" },
        { name: "summary", enabled: true, mode: "suggest" },
        { name: "card_draft", enabled: false, mode: "auto" },
        { name: "leaf", enabled: true, mode: "loud" },
        { name: "nope", enabled: true },
        null,
      ],
    });
    expect(caps).toEqual({
      features: [
        { name: "notes", enabled: true },
        { name: "summary", enabled: true, mode: "suggest" },
        { name: "card_draft", enabled: false },
        { name: "leaf", enabled: true, mode: "manual" },
      ],
    });
    expect(normalizeCapabilities(null)).toEqual({ features: [] });
    expect(normalizeCapabilities({ features: null })).toEqual({ features: [] });
  });

  it("keeps a disabled AI feature's reported mode off (B10 phase C: memory is listed off with `mode: off`)", () => {
    expect(normalizeCapabilities({ features: [{ name: "memory", enabled: false, mode: "off" }, { name: "goal", enabled: false, mode: "suggest" }] }).features).toEqual([
      { name: "memory", enabled: false, mode: "off" },
      { name: "goal", enabled: false },
    ]);
  });

  it("treats a missing enabled flag as off", () => {
    expect(normalizeCapabilities({ features: [{ name: "notes" }] }).features).toEqual([{ name: "notes", enabled: false }]);
  });

  it("answers on/off and the mode", () => {
    const caps = normalizeCapabilities({
      features: [
        { name: "branch_suggest", enabled: true, mode: "manual" },
        { name: "card_draft", enabled: true, mode: "manual" },
        { name: "chapters", enabled: true },
        { name: "summary", enabled: false },
      ],
    });
    expect(featureMode(caps, "branch_suggest")).toBe("manual");
    // card_draft has no mode (DESIGN §12, B3 phase 2): on means on.
    expect(featureMode(caps, "card_draft")).toBe("auto");
    expect(featureMode(caps, "chapters")).toBe("auto");
    expect(featureMode(caps, "summary")).toBe("off");
    expect(featureMode(caps, "goal")).toBe("off");
    expect(isFeatureOn(caps, "chapters")).toBe(true);
    expect(isFeatureOn(caps, "summary")).toBe(false);
    expect(isFeatureOn(undefined, "card_draft")).toBe(false);
  });

  it("lists the twenty modules of EXTENSIONS.md, B5's search and B8's suggestion inbox, eleven of them with a mode", () => {
    expect(FEATURE_NAMES).toHaveLength(23);
    expect(FEATURE_NAMES).toContain("memo");
    expect(AI_FEATURES.has("memo")).toBe(false);
    expect(FEATURE_NAMES).toContain("search");
    expect(FEATURE_NAMES).toContain("suggestions");
    expect(AI_FEATURES.has("suggestions" as never)).toBe(false);
    expect(AI_FEATURES.size).toBe(11);
    expect(AI_FEATURES.has("card_draft")).toBe(false);
    for (const name of AI_FEATURES) expect(FEATURE_NAMES).toContain(name);
  });
});

describe("permissions (B4.1)", () => {
  it("keeps canWrite when the server sends it and reports null when it does not", () => {
    expect(normalizeCapabilities({ features: [], permissions: { canWrite: false } })).toStrictEqual({ features: [], permissions: { canWrite: false } });
    expect(canWrite(normalizeCapabilities({ features: [], permissions: { canWrite: true } }))).toBe(true);
    expect(canWrite(normalizeCapabilities({ features: [] }))).toBeNull();
    expect("permissions" in normalizeCapabilities({ features: [] })).toBe(false);
  });
});

describe("models (B5)", () => {
  it("keeps the allowed provider / model list when the server sends it, and nothing otherwise", () => {
    const caps = normalizeCapabilities({ features: [], models: [{ provider: "anthropic", models: ["claude-haiku-4-5", 3, ""] }, { provider: "", models: ["x"] }, "junk"] });
    expect(caps.models).toStrictEqual([{ provider: "anthropic", models: ["claude-haiku-4-5"] }]);
    expect("models" in normalizeCapabilities({ features: [] })).toBe(false);
  });

  it("flattens them into options", () => {
    const caps = normalizeCapabilities({ features: [], models: [{ provider: "fake", models: ["fake-1", "fake-2"] }] });
    expect(modelChoices(caps)).toStrictEqual([
      { provider: "fake", model: "fake-1" },
      { provider: "fake", model: "fake-2" },
    ]);
    expect(modelChoices(normalizeCapabilities({ features: [] }))).toBeNull();
  });
});
