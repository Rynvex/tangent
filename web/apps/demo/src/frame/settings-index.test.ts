import { createBundleTranslator } from "@tangent/react";
import { describe, expect, it } from "vitest";
import { PREF_CHOICES, PREF_FLAGS } from "./prefs";
import { SETTINGS_CATEGORIES, SETTINGS_ENTRIES, SETTINGS_NAV, categoryTitleKey, entriesOf, entryById, groupsOf, isSettingsCategory, searchSettings } from "./settings-index";
import { SETTINGS_MESSAGES, type SettingsMessageKey } from "./settings-messages";

const translator = (locale: "en" | "zh-TW" | "ja") => {
  const t = createBundleTranslator(SETTINGS_MESSAGES, locale, {}, (key) => key);
  return (key: SettingsMessageKey) => t(key);
};
const en = translator("en");
const zh = translator("zh-TW");
const ja = translator("ja");
const ids = (query: string, t = en) => searchSettings(query, t).map((entry) => entry.id);

describe("the Settings page's map (G2)", () => {
  it("has the nine categories in three groups, each once, after T3 Code's order", () => {
    expect(SETTINGS_NAV.map((group) => group.categories)).toEqual([["general", "appearance", "chat", "keybindings"], ["providers", "threads"], ["maintenance", "archive", "about"]]);
    expect(SETTINGS_NAV.flatMap((group) => group.categories).sort()).toEqual([...SETTINGS_CATEGORIES].sort());
    expect(isSettingsCategory("chat")).toBe(true);
    expect(isSettingsCategory("git")).toBe(false);
    // None of T3 Code's categories that are not Tangent's.
    for (const foreign of ["git", "worktrees", "diffs", "browser", "simulators", "devices", "ssh", "secrets"]) expect(isSettingsCategory(foreign)).toBe(false);
  });

  it("gives every preference exactly one row, so no stored setting is without a control", () => {
    const controlled = SETTINGS_ENTRIES.flatMap((entry) => (entry.control.kind === "custom" ? [] : [entry.control.pref]));
    expect([...controlled].sort()).toEqual([...Object.keys(PREF_CHOICES), ...Object.keys(PREF_FLAGS)].sort());
    expect(new Set(SETTINGS_ENTRIES.map((entry) => entry.id)).size).toBe(SETTINGS_ENTRIES.length);
  });

  it("offers every choice of a preference, in the row's own order when it has one", () => {
    for (const entry of SETTINGS_ENTRIES) {
      if (entry.control.kind !== "choice" || !entry.control.order) continue;
      expect([...entry.control.order].map(String).sort()).toEqual([...PREF_CHOICES[entry.control.pref]].map(String).sort());
    }
  });

  it("has every name, description, card and choice label in all languages", () => {
    for (const locale of ["en", "zh-TW", "ja"] as const) {
      const words = SETTINGS_MESSAGES[locale] as Record<string, string>;
      for (const category of SETTINGS_CATEGORIES) expect(words[categoryTitleKey(category)]).toBeTruthy();
      for (const entry of SETTINGS_ENTRIES) {
        expect(words[entry.titleKey], entry.id).toBeTruthy();
        expect(words[entry.group], entry.id).toBeTruthy();
        if (entry.descKey) expect(words[entry.descKey], entry.id).toBeTruthy();
        if (entry.control.kind !== "choice" || entry.control.pref === "theme" || entry.control.pref === "readingFont") continue;
        for (const choice of PREF_CHOICES[entry.control.pref]) {
          if (typeof choice === "string") expect(words[`g2.${entry.control.pref}.${choice}`], `${locale}:${entry.id}.${choice}`).toBeTruthy();
        }
      }
    }
    expect(Object.keys(SETTINGS_MESSAGES["zh-TW"]).sort()).toEqual(Object.keys(SETTINGS_MESSAGES.en).sort());
    expect(Object.keys(SETTINGS_MESSAGES.ja).sort()).toEqual(Object.keys(SETTINGS_MESSAGES.en).sort());
  });

  it("files rows under their cards in order", () => {
    expect(groupsOf("general").map((group) => [group.group, group.entries.map((entry) => entry.id)])).toEqual([
      ["g2.group.notifications", ["threadNotifications", "inAppNotifications"]],
      ["g2.group.sidebar", ["activityBadges"]],
      ["g2.group.confirmations", ["confirmUnpin", "confirmArchive", "confirmDelete"]],
      ["g2.group.formatting", ["timeFormat", "language"]],
    ]);
    expect(entriesOf("chat").map((entry) => entry.id)).toEqual(["sendShortcut", "streamResponses", "followUp", "asideDefault", "expandCards"]);
    expect(entryById("codeWrap")?.category).toBe("appearance");
  });
});

describe("searching the settings", () => {
  it("finds a setting by its name, its description, its card, its category or a keyword", () => {
    expect(ids("word wrap")).toEqual(["codeWrap"]);
    expect(ids("dollar")).toEqual(["renderMath"]);
    expect(ids("confirmations")).toEqual(["confirmUnpin", "confirmArchive", "confirmDelete"]);
    expect(ids("hotkey")).toEqual(["keybindings"]);
    expect(ids("latex")).toEqual(["renderMath"]);
    expect(ids("keybindings")).toContain("keybindings");
  });

  it("needs every word, ignores case, and answers nothing for an empty query", () => {
    expect(ids("CODE font")).toEqual(["codeFontSize"]);
    expect(ids("code banana")).toEqual([]);
    expect(ids("   ")).toEqual([]);
    expect(ids("")).toEqual([]);
  });

  it("searches in the language on screen, and by the other languages' keywords too", () => {
    expect(ids("換行", zh)).toEqual(["codeWrap", "sendShortcut"]);
    expect(ids("封存", zh)).toEqual(["confirmArchive", "archive"]);
    expect(ids("時間格式", zh)).toEqual(["timeFormat"]);
    expect(ids("表示言語", ja)).toEqual(["language"]);
    expect(ids("アーカイブ", ja)).toEqual(["confirmArchive", "archive"]);
    // Typed in Chinese or Japanese while the page is in English: the keywords carry it.
    expect(ids("置頂")).toEqual(["confirmUnpin"]);
    expect(ids("日本語")).toEqual(["language"]);
  });
});
