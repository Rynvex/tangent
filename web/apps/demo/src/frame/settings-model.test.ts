import { normalizeCapabilities } from "@tangent/client";
import { mockCapabilities } from "@tangent/client/testing";
import { describe, expect, it } from "vitest";
import { featureRows, featureSetSearch } from "./settings-model";

describe("featureRows (A13 功能清單)", () => {
  it("lists the core first, then each enabled feature in table order with its mode; off features are not listed", () => {
    const capabilities = normalizeCapabilities({
      features: [
        { name: "notes", enabled: true },
        { name: "summary", enabled: true, mode: "auto" },
        { name: "branch_suggest", enabled: true, mode: "suggest" },
        { name: "chapters", enabled: false },
      ],
    });
    const { rows, othersOff } = featureRows(capabilities);
    expect(rows.map((row) => (row.kind === "core" ? row.kind : `${row.kind}:${row.name}`))).toEqual(["core", "core", "core", "toggle:notes", "mode:summary", "mode:branch_suggest"]);
    expect(rows[4]).toEqual({ kind: "mode", name: "summary", mode: "auto" });
    expect(othersOff).toBe(true);
  });

  it("lists every enabled feature of the full set and says nothing is off", () => {
    const capabilities = normalizeCapabilities({ features: mockCapabilities("all") });
    expect(featureRows(capabilities).rows.find((row) => row.kind === "mode" && row.name === "memory")).toEqual({ kind: "mode", name: "memory", mode: "suggest" });
    expect(featureRows(capabilities).othersOff).toBe(false);
  });

  it("shows only the core while capabilities are unknown", () => {
    expect(featureRows(undefined)).toEqual({ rows: expect.any(Array), othersOff: false });
    expect(featureRows(undefined).rows.every((row) => row.kind === "core")).toBe(true);
  });
});

describe("featureSetSearch", () => {
  it("keeps the other URL parameters and swaps the feature set", () => {
    expect(featureSetSearch("?frame=app&features=all&line=nas", "core")).toBe("?frame=app&features=core&line=nas");
    expect(featureSetSearch("", "c1")).toBe("?features=c1");
  });
});

describe("feature names", () => {
  it("every feature the client knows has a name in all languages", async () => {
    const { FEATURE_NAMES } = await import("@tangent/client");
    const { enSettings, loadLocale, localeMessages } = await import("@tangent/react");
    await Promise.all([loadLocale("zh-TW"), loadLocale("ja")]);
    // F8: the English names load with the settings dialog (enSettings), not with the main dictionary.
    const en: Readonly<Record<string, string>> = { ...localeMessages("en")!, ...enSettings };
    const zh = localeMessages("zh-TW")!;
    const ja = localeMessages("ja")!;
    for (const name of FEATURE_NAMES) {
      expect(en[`feature.${name}`], name).toBeTruthy();
      expect(zh[`feature.${name}` as keyof typeof zh], name).toBeTruthy();
      expect(ja[`feature.${name}` as keyof typeof ja], name).toBeTruthy();
    }
  });
});
