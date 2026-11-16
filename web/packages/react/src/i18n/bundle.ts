/**
 * Message bundles that load with a lazy part of the UI instead of the main
 * dictionary (F4: keeps the main bundle small). A bundle has the same two
 * locales; its translator looks a key up in the host's overrides, the
 * bundle's locale, the bundle's English, and otherwise hands it to the
 * provider's translator.
 */
import { useMemo } from "react";
import { useUiLocale, useUiT } from "../provider";
import { interpolate } from "./index";
import type { HostMessages, Locale, MessageKey, TranslateParams } from "./types";

export type MessageBundle<K extends string> = Readonly<Record<Locale, Readonly<Record<K, string>>>>;

/** Translates a bundle key or any bundled key. */
export type BundleTranslate<K extends string> = (key: MessageKey | K, params?: TranslateParams) => string;

function own(record: object, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value: unknown = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function createBundleTranslator<K extends string>(
  bundle: MessageBundle<K>,
  locale: Locale,
  overrides: HostMessages,
  fallback: (key: MessageKey, params?: TranslateParams) => string,
): BundleTranslate<K> {
  return (key, params) => {
    if (!Object.hasOwn(bundle.en, key)) return fallback(key as MessageKey, params);
    return interpolate(own(overrides, key) ?? own(bundle[locale], key) ?? own(bundle.en, key) ?? key, params);
  };
}

/** The translator for a lazy part: its bundle first, then the provider's dictionary. */
export function useBundleT<K extends string>(bundle: MessageBundle<K>): BundleTranslate<K> {
  const fallback = useUiT();
  const { locale, messages } = useUiLocale();
  return useMemo(() => createBundleTranslator(bundle, locale, messages, fallback), [bundle, locale, messages, fallback]);
}
