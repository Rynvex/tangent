import { describe, expect, it } from "vitest";
import { createModelPrefsStore, EMPTY_MODEL_PREFS, MODEL_PREFS_KEY, withDefaultEffort, withDefaultModel, withFavorite, withHidden } from "./model-prefs";
import { createPrefsStore, DEFAULT_PREFS, PREFS_KEY, type PrefsStorage } from "./prefs";
import { clearLocalCache, exportSettings, importSettings, localCacheKeys, parseSettingsFile, resetSettings, serializeSettings, settingsFileName, type ClearableStorage, type SettingsStores } from "./prefs-transfer";

function memory(initial: Record<string, string> = {}): PrefsStorage & ClearableStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => void (data[key] = value),
    get length() {
      return Object.keys(data).length;
    },
    key: (index) => Object.keys(data)[index] ?? null,
    removeItem: (key) => void delete data[key],
  };
}

function stores(): SettingsStores & { storage: ReturnType<typeof memory> } {
  const storage = memory();
  return { storage, prefs: createPrefsStore(() => storage), models: createModelPrefsStore(() => storage) };
}

const OPUS = { provider: "claude-cli", model: "claude-opus-5-5" };
const HAIKU = { provider: "claude-cli", model: "claude-haiku-5-5" };

function changed(): ReturnType<typeof stores> {
  const all = stores();
  all.prefs.update({ theme: "dark", chatWidth: "wide", codeWrap: true, sendShortcut: "mod_enter", keybindings: { "branch.open": "Mod+Shift+B" } });
  all.models.set(withHidden(withFavorite(withDefaultEffort(withDefaultModel(EMPTY_MODEL_PREFS, OPUS), "high"), OPUS, true), HAIKU, true));
  return all;
}

describe("exporting and importing the settings (G2, Maintenance)", () => {
  it("exports both stores with their versions, and the file imports into a fresh browser unchanged", () => {
    const from = changed();
    const file = exportSettings(from, new Date("2026-11-15T08:00:00Z"));
    expect(file).toMatchObject({ kind: "tangent-settings", version: 1, exportedAt: "2026-11-15T08:00:00.000Z", prefs: { version: 2, theme: "dark" }, modelPrefs: { version: 1, defaultEffort: "high" } });
    expect(settingsFileName(new Date("2026-11-15T08:00:00Z"))).toBe("tangent-settings-2026-11-15.json");

    const to = stores();
    const result = importSettings(to, serializeSettings(file));
    expect(result.ok).toBe(true);
    expect(to.prefs.get()).toEqual(from.prefs.get());
    expect(to.models.get()).toEqual(from.models.get());
    // Written through, so a reload keeps them.
    expect(JSON.parse(to.storage.data[PREFS_KEY]!)).toMatchObject({ version: 2, chatWidth: "wide" });
    expect(JSON.parse(to.storage.data[MODEL_PREFS_KEY]!)).toMatchObject({ version: 1, defaultModel: OPUS });
  });

  it("refuses what is not JSON, not ours or from a newer format, and changes nothing", () => {
    const to = changed();
    const before = { prefs: to.prefs.get(), models: to.models.get() };
    expect(importSettings(to, "{nope")).toEqual({ ok: false, reason: "notJson" });
    expect(importSettings(to, '{"theme":"dark"}')).toEqual({ ok: false, reason: "notSettings" });
    expect(importSettings(to, "[]")).toEqual({ ok: false, reason: "notSettings" });
    expect(importSettings(to, '{"kind":"tangent-settings"}')).toEqual({ ok: false, reason: "notSettings" });
    expect(importSettings(to, '{"kind":"tangent-settings","version":9,"prefs":{}}')).toEqual({ ok: false, reason: "newer", version: 9 });
    expect(to.prefs.get()).toEqual(before.prefs);
    expect(to.models.get()).toEqual(before.models);
  });

  it("imports the valid values of a damaged file; the rest falls back to defaults", () => {
    const result = parseSettingsFile(JSON.stringify({ kind: "tangent-settings", version: 1, prefs: { theme: "light", chatWidth: "huge", keybindings: { "branch.open": "Hyper+B" } }, modelPrefs: "nope" }));
    expect(result).toEqual({ ok: true, prefs: { ...DEFAULT_PREFS, theme: "light" }, modelPrefs: EMPTY_MODEL_PREFS });
  });

  it("restores the defaults of both stores", () => {
    const all = changed();
    resetSettings(all);
    expect(all.prefs.get()).toEqual(DEFAULT_PREFS);
    expect(all.models.get()).toEqual({ favorites: [], hidden: [] });
    expect(JSON.parse(all.storage.data[PREFS_KEY]!)).toMatchObject({ theme: "system", keybindings: {} });
  });
});

describe("clearing the local cache", () => {
  it("removes Tangent's own keys but the settings, and nothing of anyone else's", () => {
    const storage = memory({
      [PREFS_KEY]: "{}",
      [MODEL_PREFS_KEY]: "{}",
      "tangent:pinned-roots:v1": "[]",
      "tangent:side-width:v1": "420",
      "tangent.notesSeen::nas": "2026",
      "tangent-demo.focus": "{}",
      "tg.readingFont": "serif",
      "other-app": "keep",
    });
    expect(localCacheKeys(storage).sort()).toEqual(["tangent-demo.focus", "tangent.notesSeen::nas", "tangent:pinned-roots:v1", "tangent:side-width:v1", "tg.readingFont"]);
    expect(clearLocalCache(storage)).toBe(5);
    expect(Object.keys(storage.data).sort()).toEqual(["other-app", MODEL_PREFS_KEY, PREFS_KEY].sort());
    expect(clearLocalCache(storage)).toBe(0);
    expect(localCacheKeys(null)).toEqual([]);
  });
});
