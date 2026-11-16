/**
 * Moving the settings in and out of this browser (G2, Settings →
 * Maintenance): one JSON file with the preferences (prefs.ts) and the model
 * preferences (model-prefs.ts), reading such a file back, putting both back
 * to their defaults, and forgetting what else the browser remembers. Pure
 * functions over the two stores; loaded with the Settings page.
 */
import { EMPTY_MODEL_PREFS, MODEL_PREFS_KEY, MODEL_PREFS_VERSION, parseModelPrefs, type ModelPrefs, type ModelPrefsStore } from "./model-prefs";
import { PREFS_KEY, PREFS_VERSION, parsePrefs, type DemoPrefs, type PrefsStore } from "./prefs";

/** What marks a file as ours. */
export const SETTINGS_FILE_KIND = "tangent-settings";
/** The file's own format version (the two stores carry theirs inside). */
export const SETTINGS_FILE_VERSION = 1;

export interface SettingsFile {
  kind: typeof SETTINGS_FILE_KIND;
  version: number;
  exportedAt: string;
  prefs: DemoPrefs & { version: number };
  modelPrefs: ModelPrefs & { version: number };
}

export interface SettingsStores {
  prefs: PrefsStore;
  models: ModelPrefsStore;
}

/** Everything the Settings page sets, as one object. */
export function exportSettings(stores: SettingsStores, now: Date = new Date()): SettingsFile {
  return {
    kind: SETTINGS_FILE_KIND,
    version: SETTINGS_FILE_VERSION,
    exportedAt: now.toISOString(),
    prefs: { version: PREFS_VERSION, ...stores.prefs.get() },
    modelPrefs: { version: MODEL_PREFS_VERSION, ...stores.models.get() },
  };
}

export function serializeSettings(file: SettingsFile): string {
  return JSON.stringify(file, null, 2);
}

/** "tangent-settings-2026-11-15.json". */
export function settingsFileName(now: Date = new Date()): string {
  return `tangent-settings-${now.toISOString().slice(0, 10)}.json`;
}

export type ImportFailure = "notJson" | "notSettings" | "newer";

export type ImportResult = { ok: true; prefs: DemoPrefs; modelPrefs: ModelPrefs } | { ok: false; reason: ImportFailure; version?: number };

/**
 * Reads an exported file. Not JSON, or not one of ours: refused. A file of a
 * newer format is refused too (its fields may mean something else). Inside
 * an accepted file every value is checked as the stores check their own, so
 * an unknown or damaged value falls back to its default and the rest comes in.
 */
export function parseSettingsFile(text: string): ImportResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "notJson" };
  }
  if (typeof value !== "object" || value === null || (value as Record<string, unknown>).kind !== SETTINGS_FILE_KIND) return { ok: false, reason: "notSettings" };
  const file = value as Record<string, unknown>;
  if (typeof file.version !== "number") return { ok: false, reason: "notSettings" };
  if (file.version > SETTINGS_FILE_VERSION) return { ok: false, reason: "newer", version: file.version };
  return { ok: true, prefs: parsePrefs(file.prefs), modelPrefs: parseModelPrefs(JSON.stringify(file.modelPrefs ?? null)) };
}

/** Replaces both stores with a file's settings; nothing changes when the file is refused. */
export function importSettings(stores: SettingsStores, text: string): ImportResult {
  const result = parseSettingsFile(text);
  if (!result.ok) return result;
  stores.prefs.set(result.prefs);
  stores.models.set(result.modelPrefs);
  return result;
}

/** Restore defaults: every setting, key override and model preference. */
export function resetSettings(stores: SettingsStores): void {
  stores.prefs.reset();
  stores.models.set(EMPTY_MODEL_PREFS);
}

/** The part of `Storage` cleared here, so tests can pass a fake. */
export interface ClearableStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

/** Every key Tangent's pages write starts with one of these. */
const LOCAL_PREFIXES = ["tangent:", "tangent.", "tangent-demo.", "tg."];
/** The settings themselves stay (Restore defaults is their reset). */
const KEPT_KEYS: ReadonlySet<string> = new Set([PREFS_KEY, MODEL_PREFS_KEY]);

/** The keys "Clear local cache" removes from one storage: Tangent's own, without the settings. */
export function localCacheKeys(storage: ClearableStorage | null): string[] {
  if (!storage) return [];
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && !KEPT_KEYS.has(key) && LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

/** Removes them; answers how many went. */
export function clearLocalCache(storage: ClearableStorage | null): number {
  const keys = localCacheKeys(storage);
  let removed = 0;
  for (const key of keys) {
    try {
      storage?.removeItem(key);
      removed += 1;
    } catch {
      // Left where it is.
    }
  }
  return removed;
}
