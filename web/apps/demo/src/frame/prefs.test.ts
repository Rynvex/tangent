import { describe, expect, it, vi } from "vitest";
import {
  bindingOverrides,
  CHAT_WIDTH_CLASSES,
  COST_THRESHOLDS,
  costThresholdFor,
  createPrefsStore,
  DEFAULT_PREFS,
  hour12For,
  LEGACY_PREFS_KEY,
  LEGACY_READING_FONT_KEY,
  loadPrefs,
  localeFor,
  parsePrefs,
  PREF_CHOICES,
  PREF_FLAGS,
  PREFS_KEY,
  PREFS_VERSION,
  readPrefs,
  savePrefs,
  serializePrefs,
  themeFor,
  type DemoPrefs,
  type PrefsStorage,
} from "./prefs";
import { readParams } from "./params";

function memory(initial: Record<string, string> = {}): PrefsStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

const stored = (prefs: object) => ({ [PREFS_KEY]: JSON.stringify({ version: PREFS_VERSION, ...prefs }) });

describe("demo preferences v2 (G2: one versioned object, every field checked)", () => {
  it("defaults: the first choice of every setting, the flags as declared, no key overrides", () => {
    expect(DEFAULT_PREFS).toEqual({
      theme: "system",
      language: "auto",
      timeFormat: "24h",
      threadNotifications: "off",
      chatWidth: "reading",
      readingFont: "sans",
      codeFontSize: "md",
      costThreshold: 0.05,
      sendShortcut: "enter",
      followUp: "block",
      asideDefault: "discard",
      inAppNotifications: true,
      activityBadges: true,
      confirmUnpin: false,
      confirmArchive: false,
      confirmDelete: true,
      codeWrap: false,
      renderMath: true,
      streamResponses: true,
      expandCards: false,
      keybindings: {},
    });
    expect(COST_THRESHOLDS).toEqual([0.02, 0.05, 0.1]);
    expect(loadPrefs(memory())).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it("is stored under tangent:prefs with its version, and round-trips", () => {
    const storage = memory();
    const prefs: DemoPrefs = { ...DEFAULT_PREFS, theme: "dark", costThreshold: "off", codeWrap: true, sendShortcut: "mod_enter", keybindings: { "branch.open": "Mod+Shift+B", "sidebar.toggle": null } };
    savePrefs(storage, prefs);
    expect(JSON.parse(storage.data[PREFS_KEY]!)).toMatchObject({ version: 2, theme: "dark", costThreshold: "off" });
    expect(serializePrefs(prefs)).toBe(storage.data[PREFS_KEY]);
    expect(loadPrefs(storage)).toEqual(prefs);
  });

  it("a bad value falls back to its default; the valid fields next to it are kept", () => {
    const prefs = loadPrefs(memory(stored({ theme: "neon", costThreshold: 7, chatWidth: "wide", codeWrap: "yes", renderMath: false, language: 3, expandCards: true })));
    expect(prefs).toEqual({ ...DEFAULT_PREFS, chatWidth: "wide", renderMath: false, expandCards: true });
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("dark")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs([])).toEqual(DEFAULT_PREFS);
  });

  it("falls back to the defaults for JSON that does not parse, without looking at version 1", () => {
    const storage = memory({ [PREFS_KEY]: "{not json", [LEGACY_PREFS_KEY]: '{"theme":"dark"}' });
    expect(readPrefs(storage)).toEqual({ prefs: DEFAULT_PREFS, migrated: false });
  });

  it("keeps only key overrides that are bindings (or null, keys off), at most 100", () => {
    const prefs = parsePrefs({ keybindings: { "branch.open": "Mod+Shift+B", "notes.add": null, "nav.back": "Hyper+X", "focus.toggle": 7, "search.inTree": "" } });
    expect(prefs.keybindings).toEqual({ "branch.open": "Mod+Shift+B", "notes.add": null });
    expect(parsePrefs({ keybindings: ["Mod+B"] }).keybindings).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`cmd.${index}`, "Mod+B"]));
    expect(Object.keys(parsePrefs({ keybindings: many }).keybindings)).toHaveLength(100);
  });

  it("every choice list and flag is part of the schema (a new setting must be declared there)", () => {
    for (const [key, choices] of Object.entries(PREF_CHOICES)) expect(choices).toContain(DEFAULT_PREFS[key as keyof DemoPrefs]);
    for (const [key, value] of Object.entries(PREF_FLAGS)) expect(DEFAULT_PREFS[key as keyof DemoPrefs]).toBe(value);
  });

  it("survives storage that throws (private windows, blocked site data)", () => {
    const broken: PrefsStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs(broken, DEFAULT_PREFS)).not.toThrow();
    const store = createPrefsStore(() => broken);
    store.update({ theme: "dark" });
    // Not kept, but in effect on this page.
    expect(store.get().theme).toBe("dark");
  });
});

describe("migration from version 1 (tangent-demo.prefs and tg.readingFont)", () => {
  it("takes over the theme, the cost threshold and the reading font, and writes them under the new key once", () => {
    const storage = memory({ [LEGACY_PREFS_KEY]: '{"theme":"dark","costThreshold":0.1}', [LEGACY_READING_FONT_KEY]: "serif" });
    expect(readPrefs(storage)).toEqual({ prefs: { ...DEFAULT_PREFS, theme: "dark", costThreshold: 0.1, readingFont: "serif" }, migrated: true });
    const store = createPrefsStore(() => storage);
    expect(store.get()).toEqual({ ...DEFAULT_PREFS, theme: "dark", costThreshold: 0.1, readingFont: "serif" });
    expect(JSON.parse(storage.data[PREFS_KEY]!)).toMatchObject({ version: 2, theme: "dark", costThreshold: 0.1, readingFont: "serif" });
    // The old keys stay where they are (an older build still reads them); they are not read again.
    expect(storage.data[LEGACY_PREFS_KEY]).toBe('{"theme":"dark","costThreshold":0.1}');
    storage.data[LEGACY_PREFS_KEY] = '{"theme":"light"}';
    expect(readPrefs(storage)).toMatchObject({ prefs: { theme: "dark" }, migrated: false });
  });

  it("migrates the reading font alone, drops version 1 garbage, and does nothing without version 1", () => {
    expect(loadPrefs(memory({ [LEGACY_READING_FONT_KEY]: "serif" }))).toEqual({ ...DEFAULT_PREFS, readingFont: "serif" });
    expect(loadPrefs(memory({ [LEGACY_PREFS_KEY]: '{"theme":"neon","costThreshold":7}' }))).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(memory({ [LEGACY_PREFS_KEY]: "not json" }))).toEqual(DEFAULT_PREFS);
    const storage = memory();
    createPrefsStore(() => storage).get();
    expect(storage.data).toEqual({});
  });
});

describe("the preferences store", () => {
  it("updates, notifies, persists and resets", () => {
    const storage = memory();
    const store = createPrefsStore(() => storage);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.update({ chatWidth: "full", confirmDelete: false });
    expect(store.get()).toEqual({ ...DEFAULT_PREFS, chatWidth: "full", confirmDelete: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createPrefsStore(() => storage).get().chatWidth).toBe("full");
    store.reset();
    expect(store.get()).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(storage)).toEqual(DEFAULT_PREFS);
    unsubscribe();
    store.update({ theme: "dark" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("checks what it is given like what it reads", () => {
    const store = createPrefsStore(() => memory());
    store.set({ ...DEFAULT_PREFS, theme: "neon" as DemoPrefs["theme"], keybindings: { "branch.open": "Nope+" } });
    expect(store.get()).toEqual(DEFAULT_PREFS);
  });
});

describe("what the preferences mean to the page", () => {
  it("uses the stored theme unless the URL names one; embedded, the host's theme", () => {
    const prefs = { theme: "dark" } as const;
    expect(themeFor(readParams(""), prefs)).toBe("dark");
    expect(themeFor(readParams("?theme=light"), prefs)).toBe("light");
    expect(themeFor(readParams("?frame=embed"), prefs)).toBe("host");
  });

  it("turns the cost threshold `off` into one no turn reaches", () => {
    expect(costThresholdFor({ costThreshold: 0.02 })).toBe(0.02);
    expect(costThresholdFor({ costThreshold: "off" })).toBe(Number.POSITIVE_INFINITY);
  });

  it("picks the language: ?lang= first, then the choice, then the browser's", () => {
    expect(localeFor({ language: "auto" }, null, "zh-TW")).toBe("zh-TW");
    expect(localeFor({ language: "ja" }, null, "en-US")).toBe("ja");
    expect(localeFor({ language: "en" }, null, "zh-TW")).toBe("en");
    expect(localeFor({ language: "en" }, "zh-TW", "en-US")).toBe("zh-TW");
  });

  it("reads the clock: 24-hour by default, 12-hour when chosen, the language's own under auto", () => {
    expect(hour12For({ timeFormat: "24h" }, "en-US")).toBe(false);
    expect(hour12For({ timeFormat: "12h" }, "de-DE")).toBe(true);
    expect(hour12For({ timeFormat: "auto" }, "en-US")).toBe(true);
    expect(hour12For({ timeFormat: "auto" }, "de-DE")).toBe(false);
  });

  it("gives ShortcutsProvider the send shortcut's keys, under the reader's own", () => {
    expect(bindingOverrides({ sendShortcut: "enter", keybindings: {} })).toEqual({});
    expect(bindingOverrides({ sendShortcut: "mod_enter", keybindings: {} })).toEqual({ "composer.send": "Mod+Enter", "composer.newline": "Enter" });
    expect(bindingOverrides({ sendShortcut: "mod_enter", keybindings: { "composer.send": "Alt+Enter", "branch.open": "Mod+Shift+B" } })).toEqual({ "composer.send": "Alt+Enter", "composer.newline": "Enter", "branch.open": "Mod+Shift+B" });
  });

  it("has a width class for every chat width", () => {
    expect(CHAT_WIDTH_CLASSES).toEqual({ reading: "max-w-tg-reading", wide: "max-w-5xl", full: "max-w-none" });
  });
});
