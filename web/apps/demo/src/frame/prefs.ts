/**
 * The demo's own preferences (A13; G2: every setting of the Settings page),
 * kept in this browser as one versioned object under `tangent:prefs`. A host
 * embedding Tangent keeps them its own way and passes them to the providers
 * (TangentProvider, ShortcutsProvider, MarkdownOptionsProvider, …).
 *
 * Every value is checked when read: a field that is missing, of another
 * type or not one of its choices falls back to its default, the rest is
 * kept. Version 1 was `tangent-demo.prefs` (theme and cost threshold) plus
 * `tg.readingFont`; it is read once, when there is no version-2 value yet.
 * The model preferences stay in `model-prefs.ts` (G1).
 */
import { canonicalKeys, type TangentTheme } from "@tangent/react";
import { useSyncExternalStore } from "react";
import type { DemoParams } from "./params";

export const PREFS_KEY = "tangent:prefs";
export const PREFS_VERSION = 2;
/** Version 1's keys (A13, F10 §1). */
export const LEGACY_PREFS_KEY = "tangent-demo.prefs";
export const LEGACY_READING_FONT_KEY = "tg.readingFont";
/** More key overrides than this would only be a mistake. */
export const KEYBINDINGS_MAX = 100;

/** Every single-choice setting and its choices; the first is the default. */
export const PREF_CHOICES = {
  theme: ["system", "light", "dark"],
  language: ["auto", "zh-TW", "en", "ja"],
  // The app has always shown the 24-hour clock; `auto` follows the language's own habit.
  timeFormat: ["24h", "12h", "auto"],
  threadNotifications: ["off", "silent", "sound"],
  chatWidth: ["reading", "wide", "full"],
  readingFont: ["sans", "serif"],
  codeFontSize: ["md", "sm", "lg"],
  costThreshold: [0.05, 0.02, 0.1, "off"],
  sendShortcut: ["enter", "mod_enter"],
  followUp: ["block", "stop_and_send"],
  asideDefault: ["discard", "keep"],
} as const;

/** Every on / off setting and its default. */
export const PREF_FLAGS = {
  inAppNotifications: true,
  activityBadges: true,
  confirmUnpin: false,
  confirmArchive: false,
  confirmDelete: true,
  codeWrap: false,
  renderMath: true,
  streamResponses: true,
  expandCards: false,
} as const;

export type PrefChoiceKey = keyof typeof PREF_CHOICES;
export type PrefFlagKey = keyof typeof PREF_FLAGS;
/** The reader's own keys: a command's binding ("Mod+Shift+B"), or null to turn its keys off. */
export type Keybindings = Readonly<Record<string, string | null>>;

export type DemoPrefs = { [K in PrefChoiceKey]: (typeof PREF_CHOICES)[K][number] } & { [K in PrefFlagKey]: boolean } & { keybindings: Keybindings };

export const THEME_CHOICES = PREF_CHOICES.theme;
export type ThemeChoice = DemoPrefs["theme"];
/** The settings page's amounts (handoff §9-6); `off` never shows the cost. */
export const COST_THRESHOLDS = [0.02, 0.05, 0.1] as const;

const NO_KEYS: Keybindings = Object.freeze({});

function defaults(): DemoPrefs {
  const choices = Object.fromEntries(Object.entries(PREF_CHOICES).map(([key, values]) => [key, values[0]]));
  return Object.freeze({ ...choices, ...PREF_FLAGS, keybindings: NO_KEYS }) as DemoPrefs;
}

export const DEFAULT_PREFS: DemoPrefs = defaults();

/** The part of `Storage` used here, so tests can pass a fake. */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function readKeybindings(value: unknown): Keybindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_KEYS;
  const out: Record<string, string | null> = {};
  for (const [id, keys] of Object.entries(value).slice(0, KEYBINDINGS_MAX)) {
    if (keys === null) out[id] = null;
    else if (typeof keys === "string") {
      try {
        canonicalKeys(keys);
        out[id] = keys;
      } catch {
        // Not a binding: left out, the command keeps its default keys.
      }
    }
  }
  return Object.keys(out).length > 0 ? out : NO_KEYS;
}

/** Any value as preferences: each field that is not one of its choices is the default. */
export function parsePrefs(value: unknown): DemoPrefs {
  if (typeof value !== "object" || value === null) return DEFAULT_PREFS;
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, choices] of Object.entries(PREF_CHOICES)) out[key] = (choices as readonly unknown[]).includes(raw[key]) ? raw[key] : choices[0];
  for (const [key, fallback] of Object.entries(PREF_FLAGS)) out[key] = typeof raw[key] === "boolean" ? raw[key] : fallback;
  return { ...out, keybindings: readKeybindings(raw.keybindings) } as DemoPrefs;
}

export function serializePrefs(prefs: DemoPrefs): string {
  return JSON.stringify({ version: PREFS_VERSION, ...prefs });
}

function parseJson(text: string | null | undefined): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return null;
  }
}

/** Version 1's values (theme, cost threshold, reading font) as far as they are there; null when there is none. */
function readLegacy(storage: PrefsStorage): DemoPrefs | null {
  const old = parseJson(storage.getItem(LEGACY_PREFS_KEY));
  const font = storage.getItem(LEGACY_READING_FONT_KEY);
  if ((typeof old !== "object" || old === null) && font === null) return null;
  return parsePrefs({ ...(typeof old === "object" ? old : {}), readingFont: font });
}

/**
 * The stored preferences; anything missing, unknown or unreadable falls back
 * to the default. Without a version-2 value, version 1's are taken over
 * (`migrated`: the caller writes them back under the new key).
 */
export function readPrefs(storage: PrefsStorage | null): { prefs: DemoPrefs; migrated: boolean } {
  try {
    if (!storage) return { prefs: DEFAULT_PREFS, migrated: false };
    const stored = storage.getItem(PREFS_KEY);
    if (stored !== null) return { prefs: parsePrefs(parseJson(stored)), migrated: false };
    const legacy = readLegacy(storage);
    return legacy ? { prefs: legacy, migrated: true } : { prefs: DEFAULT_PREFS, migrated: false };
  } catch {
    return { prefs: DEFAULT_PREFS, migrated: false };
  }
}

export function loadPrefs(storage: PrefsStorage | null): DemoPrefs {
  return readPrefs(storage).prefs;
}

/** Keeps the preferences; when storage refuses, they last until the page reloads. */
export function savePrefs(storage: PrefsStorage | null, prefs: DemoPrefs): void {
  try {
    storage?.setItem(PREFS_KEY, serializePrefs(prefs));
  } catch {
    // Not kept this time.
  }
}

/** The browser's storage, or null where reading it throws. */
export function browserStorage(): PrefsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface PrefsStore {
  get(): DemoPrefs;
  /** Replaces the preferences (checked as stored). */
  set(next: DemoPrefs): void;
  /** Changes some fields. */
  update(patch: Partial<DemoPrefs>): void;
  /** Back to the defaults. */
  reset(): void;
  subscribe(listener: () => void): () => void;
}

/** A store over `storage()`; when writing fails the change lasts until the page reloads. */
export function createPrefsStore(storage: () => PrefsStorage | null): PrefsStore {
  let current: DemoPrefs | null = null;
  const listeners = new Set<() => void>();
  const read = (): DemoPrefs => {
    const { prefs, migrated } = readPrefs(storage());
    // Version 1's values move under the new key the first time they are read (the old keys stay, unread from now on).
    if (migrated) savePrefs(storage(), prefs);
    return prefs;
  };
  const get = () => (current ??= read());
  const set = (next: DemoPrefs) => {
    current = parsePrefs(next);
    savePrefs(storage(), current);
    for (const listener of listeners) listener();
  };
  return {
    get,
    set,
    update: (patch) => set({ ...get(), ...patch }),
    reset: () => set(DEFAULT_PREFS),
    subscribe(listener) {
      listeners.add(listener);
      // Another tab's change (`null`: it cleared all of storage).
      const onStorage = (event: StorageEvent) => {
        if (event.key !== PREFS_KEY && event.key !== null) return;
        current = null;
        listener();
      };
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
  };
}

/** The page's store. */
export const prefsStore = createPrefsStore(browserStorage);

/** The preferences, re-rendering when they change. */
export function usePrefs(store: PrefsStore = prefsStore): DemoPrefs {
  return useSyncExternalStore(store.subscribe, store.get, () => DEFAULT_PREFS);
}

/** Embedded, the host's theme; a theme named in the URL wins (screenshots); otherwise the stored choice. */
export function themeFor(params: DemoParams, prefs: Pick<DemoPrefs, "theme">): TangentTheme {
  if (params.frame === "embed" || params.themeFromUrl) return params.theme;
  return prefs.theme;
}

/** The provider's threshold in US$: `off` is one no turn reaches. */
export function costThresholdFor(prefs: Pick<DemoPrefs, "costThreshold">): number {
  return prefs.costThreshold === "off" ? Number.POSITIVE_INFINITY : prefs.costThreshold;
}

/** The page's language: `?lang=` wins (screenshots, tests), then the chosen language, then the browser's. */
export function localeFor(prefs: Pick<DemoPrefs, "language">, urlLang: string | null, browserLang: string): string {
  return urlLang ?? (prefs.language === "auto" ? browserLang : prefs.language);
}

/** Whether clocks read "2:52 PM": the choice, or under `auto` what the language itself does. */
export function hour12For(prefs: Pick<DemoPrefs, "timeFormat">, locale: string): boolean {
  if (prefs.timeFormat !== "auto") return prefs.timeFormat === "12h";
  try {
    return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 === true;
  } catch {
    return false;
  }
}

/** ⌘/Ctrl+Enter sends and Enter breaks the line (the `mod_enter` send shortcut). */
const MOD_ENTER_KEYS: Keybindings = { "composer.send": "Mod+Enter", "composer.newline": "Enter" };

/** What ShortcutsProvider's `bindings` gets: the send shortcut's keys, then the reader's own (which win). */
export function bindingOverrides(prefs: Pick<DemoPrefs, "sendShortcut" | "keybindings">): Keybindings {
  return prefs.sendShortcut === "mod_enter" ? { ...MOD_ENTER_KEYS, ...prefs.keybindings } : prefs.keybindings;
}

/** The conversation column's width classes (messages and the message box). */
export const CHAT_WIDTH_CLASSES: Readonly<Record<DemoPrefs["chatWidth"], string>> = { reading: "max-w-tg-reading", wide: "max-w-5xl", full: "max-w-none" };
