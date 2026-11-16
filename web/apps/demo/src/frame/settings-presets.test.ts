import { FEATURE_NAMES, normalizeCapabilities } from "@tangent/client";
import { mockCapabilities } from "@tangent/client/testing";
import { describe, expect, it } from "vitest";
import { MOCK_FEATURE_SETS, readParams } from "./params";
import { FEATURE_GROUPS, FEATURE_GROUP_OF, FEATURE_PRESETS, PRESET_ORDER, featureGroups, featureSetSearch, matchingPreset, presetEnv } from "./settings-model";

/** What the mock reports for a set, as `TANGENT_FEATURES` would say it (the derived inbox left out). */
function mockList(set: (typeof PRESET_ORDER)[number]): string {
  return mockCapabilities(set)
    .filter((feature) => feature.enabled && feature.name !== "suggestions")
    .map((feature) => (feature.mode ? `${feature.name}:${feature.mode}` : feature.name))
    .join(",");
}
const sorted = (list: string) => list.split(",").sort();

describe("feature groups (F9 B.4: four headings)", () => {
  it("gives every feature the client knows one of the four headings", () => {
    for (const name of FEATURE_NAMES) expect(FEATURE_GROUPS, name).toContain(FEATURE_GROUP_OF[name]);
    expect(Object.keys(FEATURE_GROUP_OF).sort()).toEqual([...FEATURE_NAMES].sort());
  });

  it("puts the core under the first heading, keeps table order inside each, and leaves out a heading with nothing on", () => {
    const { groups } = featureGroups(normalizeCapabilities({ features: mockCapabilities("learning") }));
    expect(groups.map((entry) => entry.group)).toEqual(["navigation", "discussion", "learning", "background"]);
    expect(groups[0]!.rows.slice(0, 3).every((row) => row.kind === "core")).toBe(true);
    expect(groups[2]!.rows.map((row) => (row.kind === "core" ? "core" : row.name))).toEqual(["notes", "summary", "card_draft", "memo", "glossary", "fold"]);
    // Folding proposes, so the inbox is on: the only row of the last heading.
    expect(groups[3]!.rows).toEqual([{ kind: "toggle", name: "suggestions" }]);
    const core = featureGroups(normalizeCapabilities({ features: mockCapabilities("core") }));
    expect(core.groups.map((entry) => entry.group)).toEqual(["navigation"]);
    const all = featureGroups(normalizeCapabilities({ features: mockCapabilities("all") }));
    expect(all.groups.map((entry) => entry.group)).toEqual([...FEATURE_GROUPS]);
    expect(all.groups.flatMap((entry) => entry.rows).filter((row) => row.kind !== "core")).toHaveLength(FEATURE_NAMES.length);
  });

  it("shows only the core heading while capabilities are unknown", () => {
    expect(featureGroups(undefined).groups.map((entry) => entry.group)).toEqual(["navigation"]);
  });
});

describe("feature presets (F9 B.4)", () => {
  it.each(PRESET_ORDER)("the mock's %s preset reports exactly the server line's features and modes", (preset) => {
    expect(sorted(mockList(preset))).toEqual(sorted(FEATURE_PRESETS[preset]));
  });

  it("says the line a server restarts with", () => {
    expect(presetEnv("learning")).toBe("TANGENT_FEATURES=notes,chapters,aside,summary:auto,card_draft,search,leaf:suggest,memo,glossary,fold:suggest");
  });

  it("knows the preset a server runs from its capabilities, and none for anything else", () => {
    for (const preset of PRESET_ORDER) expect(matchingPreset(normalizeCapabilities({ features: mockCapabilities(preset) }))).toBe(preset);
    expect(matchingPreset(normalizeCapabilities({ features: mockCapabilities("all") }))).toBeNull();
    expect(matchingPreset(normalizeCapabilities({ features: mockCapabilities("core") }))).toBeNull();
    // The same features with another mode is not the preset.
    const changed = mockCapabilities("learning").map((feature) => (feature.name === "summary" ? { ...feature, mode: "suggest" as const } : feature));
    expect(matchingPreset(normalizeCapabilities({ features: changed }))).toBeNull();
    expect(matchingPreset(undefined)).toBeNull();
  });

  it("reads and writes the presets as ?features= values, keeping the old ones", () => {
    expect(MOCK_FEATURE_SETS).toEqual(["all", "c1", "core", "standard", "research", "learning"]);
    expect(readParams("?features=research").features).toBe("research");
    expect(readParams("?features=core").features).toBe("core");
    expect(readParams("?features=bogus").features).toBe("all");
    expect(featureSetSearch("?line=nas", "learning")).toBe("?line=nas&features=learning");
  });
});
