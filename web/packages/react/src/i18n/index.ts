import { en } from "./en";
import type { HostMessages, Locale, MessageKey, Messages, Translate, TranslateParams } from "./types";

export type { HostMessages, Locale, MessageKey, Messages, Translate, TranslateParams } from "./types";

export const DEFAULT_LOCALE: Locale = "en";

/** Every locale with a bundled dictionary. */
export const LOCALES: readonly Locale[] = ["en", "zh-TW", "ja"];

/**
 * Dictionaries other than English load on demand (F5: only the locale in use
 * is downloaded, so zh-TW and ja are chunks of their own). English is the fallback and
 * always present.
 */
const LOADERS: Readonly<Record<Exclude<Locale, "en">, () => Promise<Messages>>> = {
  "zh-TW": () => import("./zh-TW").then((module) => module.zhTW),
  ja: () => import("./ja").then((module) => module.ja),
};

let loaded: Readonly<Partial<Record<Locale, Messages>>> = { en: en as Messages };
/** English that loads with the lazy parts that show it (F8: the main bundle's budget); `addEnglish` registers it. */
let laterEnglish: Readonly<Record<string, string>> = {};

/** Registers English a lazy part brought (e.g. `enSettings`); translators already made read it at once. */
export function addEnglish(messages: Readonly<Record<string, string>>): void {
  laterEnglish = { ...laterEnglish, ...messages };
}

export { enSettings } from "./en.settings";
const pending = new Map<Locale, Promise<void>>();
const listeners = new Set<() => void>();

/** Interpolates `{name}` slots; unknown slots are left untouched. */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match));
}

/** The bundled locale for a BCP 47 tag: exact match, then Chinese → zh-TW, Japanese → ja, else English. */
export function resolveLocale(locale: string): Locale {
  // includes, not `in`: "toString" or "constructor" must not count as a locale.
  if ((LOCALES as readonly string[]).includes(locale)) return locale as Locale;
  const lower = locale.toLowerCase();
  if (lower.startsWith("zh")) return "zh-TW";
  if (lower.startsWith("ja")) return "ja";
  return DEFAULT_LOCALE;
}

/** The locale's dictionary once it is loaded (English always is), else undefined. */
export function localeMessages(locale: string): Messages | undefined {
  return loaded[resolveLocale(locale)];
}

/**
 * Makes a dictionary available at once: for a host that bundles it itself
 * (no extra request) and for tests. Providers re-render with it.
 */
export function registerLocale(locale: Locale, messages: Messages): void {
  if (loaded[locale] === messages) return;
  loaded = { ...loaded, [locale]: messages };
  for (const listener of listeners) listener();
}

/**
 * Downloads the locale's dictionary (once). A host awaits it before its
 * first render to avoid a moment of English; without that, a provider shows
 * English until it arrives. Resolves at once for English and unknown tags.
 */
export function loadLocale(locale: string): Promise<void> {
  const resolved = resolveLocale(locale);
  if (loaded[resolved] || resolved === "en") return Promise.resolve();
  const inFlight = pending.get(resolved);
  if (inFlight) return inFlight;
  const load = LOADERS[resolved]()
    .then((messages) => registerLocale(resolved, messages))
    .finally(() => pending.delete(resolved));
  pending.set(resolved, load);
  return load;
}

/** Calls `listener` whenever a dictionary arrives; returns the unsubscribe. */
export function subscribeLocales(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The record's own string value for `key`; inherited properties never count. */
function own(record: object, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value: unknown = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** A translator: the host's overrides first, then the locale's dictionary (English until it loads), then English, then the key. */
export function createTranslator(locale: string, overrides: HostMessages = {}): Translate {
  const dictionary = localeMessages(locale) ?? en;
  return (key: MessageKey, params?: TranslateParams) => interpolate(own(overrides, key) ?? own(dictionary, key) ?? own(en, key) ?? own(laterEnglish, key) ?? key, params);
}

/**
 * The host's text for its own error codes: `messages["error.<code>"]`
 * (DESIGN §12). Undefined when the host has none, so the server's text shows.
 */
export function createHostErrorText(overrides: HostMessages = {}): (code: string) => string | undefined {
  return (code: string) => own(overrides, `error.${code}`);
}
