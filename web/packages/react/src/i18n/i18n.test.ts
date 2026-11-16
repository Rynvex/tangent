import { CLIENT_MESSAGE_KEYS } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { en as mainEn } from "./en";
import { enSettings } from "./en.settings";
import { createHostErrorText, createTranslator, interpolate, resolveLocale } from "./index";
import { ja } from "./ja";
import { zhTW } from "./zh-TW";

/** All dictionaries (zh-TW and ja are lazy chunks in the app; imported directly here); English with the part the settings bring (F8). */
const en = { ...mainEn, ...enSettings };
const BUNDLED_MESSAGES = { en, "zh-TW": zhTW, ja } as const;

describe("bundled dictionaries", () => {
  it("cover every key the client logic produces, in all three languages", () => {
    for (const key of CLIENT_MESSAGE_KEYS) {
      expect(BUNDLED_MESSAGES.en[key], key).toBeTruthy();
      expect(BUNDLED_MESSAGES["zh-TW"][key], key).toBeTruthy();
      expect(BUNDLED_MESSAGES.ja[key], key).toBeTruthy();
    }
  });

  it("have the same keys and the same {slots} in all three languages", () => {
    expect(Object.keys(BUNDLED_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(BUNDLED_MESSAGES.en).sort());
    expect(Object.keys(BUNDLED_MESSAGES.ja).sort()).toEqual(Object.keys(BUNDLED_MESSAGES.en).sort());
    const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(BUNDLED_MESSAGES.en)) {
      expect(slots(BUNDLED_MESSAGES["zh-TW"][key as keyof typeof BUNDLED_MESSAGES.en]), key).toEqual(slots(text));
      expect(slots(BUNDLED_MESSAGES.ja[key as keyof typeof BUNDLED_MESSAGES.en]), key).toEqual(slots(text));
    }
  });
});

describe("terms (UI_DESIGN_BRIEF §3, DESIGN §12 F0)", () => {
  it("calls notes 紀要 in zh-TW, never 筆記", () => {
    for (const [key, text] of Object.entries(BUNDLED_MESSAGES["zh-TW"])) expect(text, key).not.toContain("筆記");
    expect(BUNDLED_MESSAGES["zh-TW"]["sideTabs.notes"]).toBe("紀要");
  });
});

describe("interpolate", () => {
  it("fills known slots and leaves unknown ones", () => {
    expect(interpolate("{a} of {b} {c}", { a: 1, b: "x" })).toBe("1 of x {c}");
    expect(interpolate("plain")).toBe("plain");
  });
});

describe("createTranslator", () => {
  it("translates in the chosen locale", () => {
    const t = createTranslator("zh-TW");
    expect(t("branch.errorDepthHard", { limit: 6 })).toBe("支線最多 6 層，不能再往下開。");
    const tJa = createTranslator("ja");
    expect(tJa("breadcrumb.main")).toBe("メインライン");
  });

  it("prefers host overrides, then the locale, then English, then the key", () => {
    const t = createTranslator("zh-TW", { "branch.errorUnknown": "自訂" });
    expect(t("branch.errorUnknown")).toBe("自訂");
    const unknownLocale = createTranslator("fr");
    expect(unknownLocale("branch.errorUnknown")).toBe(BUNDLED_MESSAGES.en["branch.errorUnknown"]);
    const loose = createTranslator("en") as (key: string) => string;
    expect(loose("no.such.key")).toBe("no.such.key");
  });

  it("never treats prototype keys as a locale or a message (review M3)", () => {
    expect(resolveLocale("toString")).toBe("en");
    expect(resolveLocale("constructor")).toBe("en");
    const loose = createTranslator("en") as (key: string) => string;
    expect(loose("toString")).toBe("toString");
    expect(interpolate("{toString} {a}", { a: 1 })).toBe("{toString} 1");
  });

  it("reads host error texts from error.<code> entries only (DESIGN §12)", () => {
    const hostText = createHostErrorText({ "error.daemon_offline": "離線", "branch.errorUnknown": "x" });
    expect(hostText("daemon_offline")).toBe("離線");
    expect(hostText("other")).toBeUndefined();
    expect(createHostErrorText()("constructor")).toBeUndefined();
  });

  it("resolves locales by exact match, then by language", () => {
    expect(resolveLocale("zh-TW")).toBe("zh-TW");
    expect(resolveLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(resolveLocale("ja")).toBe("ja");
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("fr")).toBe("en");
  });
});

describe("lazy message bundles (F4: the P1 wording loads with its parts)", () => {
  it("the P1 bundle has the same keys and slots in all languages and none of the main dictionary's", async () => {
    const { P1_MESSAGES } = await import("./p1-messages");
    expect(Object.keys(P1_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(P1_MESSAGES.en).sort());
    expect(Object.keys(P1_MESSAGES.ja).sort()).toEqual(Object.keys(P1_MESSAGES.en).sort());
    const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(P1_MESSAGES.en)) {
      expect(slots(P1_MESSAGES["zh-TW"][key as keyof typeof P1_MESSAGES.en]), key).toEqual(slots(text));
      expect(slots(P1_MESSAGES.ja[key as keyof typeof P1_MESSAGES.en]), key).toEqual(slots(text));
      expect(Object.hasOwn(BUNDLED_MESSAGES.en, key), key).toBe(false);
    }
    for (const text of Object.values(P1_MESSAGES["zh-TW"])) expect(text).not.toContain("筆記");
  });

  it("looks a key up in the host's wording, the bundle, its English, then the main dictionary", async () => {
    const { createBundleTranslator } = await import("./bundle");
    const bundle = { en: { "x.one": "One {n}", "x.two": "Two" }, "zh-TW": { "x.one": "一 {n}", "x.two": "" } } as const;
    const t = createBundleTranslator(bundle as never, "zh-TW", { "x.two": "自訂" } as never, createTranslator("zh-TW"));
    expect(t("x.one" as never, { n: 1 })).toBe("一 1");
    expect(t("x.two" as never)).toBe("自訂");
    expect(t("breadcrumb.main")).toBe("主線");
  });
});

describe("the P2 bundle (F5: loads with its parts)", () => {
  it("has the same keys and slots in all languages and none of the main dictionary's or the P1 bundle's", async () => {
    const { P2_MESSAGES } = await import("./p2-messages");
    const { P1_MESSAGES } = await import("./p1-messages");
    expect(Object.keys(P2_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(P2_MESSAGES.en).sort());
    expect(Object.keys(P2_MESSAGES.ja).sort()).toEqual(Object.keys(P2_MESSAGES.en).sort());
    const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(P2_MESSAGES.en)) {
      expect(slots(P2_MESSAGES["zh-TW"][key as keyof typeof P2_MESSAGES.en]), key).toEqual(slots(text));
      expect(slots(P2_MESSAGES.ja[key as keyof typeof P2_MESSAGES.en]), key).toEqual(slots(text));
      expect(Object.hasOwn(BUNDLED_MESSAGES.en, key), key).toBe(false);
      expect(Object.hasOwn(P1_MESSAGES.en, key), key).toBe(false);
    }
    for (const text of Object.values(P2_MESSAGES["zh-TW"])) expect(text).not.toContain("筆記");
  });
});

describe("the export bundle (F8 S9: loads with the export dialog)", () => {
  it("has the same keys and slots in all languages and none of the main dictionary's", async () => {
    const { EXPORT_MESSAGES } = await import("./export-messages");
    expect(Object.keys(EXPORT_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(EXPORT_MESSAGES.en).sort());
    expect(Object.keys(EXPORT_MESSAGES.ja).sort()).toEqual(Object.keys(EXPORT_MESSAGES.en).sort());
    const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(EXPORT_MESSAGES.en)) {
      expect(slots(EXPORT_MESSAGES["zh-TW"][key as keyof typeof EXPORT_MESSAGES.en]), key).toEqual(slots(text));
      expect(slots(EXPORT_MESSAGES.ja[key as keyof typeof EXPORT_MESSAGES.en]), key).toEqual(slots(text));
      expect(Object.hasOwn(BUNDLED_MESSAGES.en, key), key).toBe(false);
    }
    for (const text of Object.values(EXPORT_MESSAGES["zh-TW"])) expect(text).not.toContain("筆記");
  });
});

describe("the glossary bundle (F19: loads with the glossary's parts)", () => {
  it("has the same keys and slots in all languages, none of the main dictionary's, and says 名詞表 (never 詞彙表 or 筆記)", async () => {
    const { GLOSSARY_MESSAGES } = await import("./glossary-messages");
    expect(Object.keys(GLOSSARY_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(GLOSSARY_MESSAGES.en).sort());
    expect(Object.keys(GLOSSARY_MESSAGES.ja).sort()).toEqual(Object.keys(GLOSSARY_MESSAGES.en).sort());
    const slots = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, text] of Object.entries(GLOSSARY_MESSAGES.en)) {
      expect(text, key).toBeTruthy();
      expect(slots(GLOSSARY_MESSAGES["zh-TW"][key as keyof typeof GLOSSARY_MESSAGES.en]), key).toEqual(slots(text));
      expect(slots(GLOSSARY_MESSAGES.ja[key as keyof typeof GLOSSARY_MESSAGES.en]), key).toEqual(slots(text));
      expect(Object.hasOwn(BUNDLED_MESSAGES.en, key), key).toBe(false);
    }
    for (const text of Object.values(GLOSSARY_MESSAGES["zh-TW"])) {
      expect(text).not.toContain("筆記");
      expect(text).not.toContain("詞彙表");
    }
    expect(GLOSSARY_MESSAGES["zh-TW"]["glossary.name"]).toBe("名詞表");
    // The always-loaded strings say the same.
    expect(BUNDLED_MESSAGES["zh-TW"]["selection.term"]).toBe("存進名詞表");
    expect(BUNDLED_MESSAGES["zh-TW"]["sideTabs.glossary"]).toBe("名詞表");
  });
});
