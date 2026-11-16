import type { HostErrorText, TangentClient } from "@tangent/client";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { createLiveStore, type LiveStore } from "./data/live-store";
import {
  createHostErrorText,
  createTranslator,
  DEFAULT_LOCALE,
  loadLocale,
  localeMessages,
  resolveLocale,
  subscribeLocales,
  type HostMessages,
  type Locale,
  type Messages,
  type Translate,
} from "./i18n";
import { useShallowStable } from "./lib/use-shallow-stable";
import { tangentKeys, type TangentKeys } from "./query-keys";

export interface TangentContextValue {
  client: TangentClient;
  /** The host's tenant, used to scope query keys; "" when the host has one tenant. */
  tenant: string;
  /** The viewer's identity in the query keys; "" when the host did not give one. */
  scopeKey: string;
  /** The bundled locale in use. */
  locale: Locale;
  t: Translate;
  /** The host's wording (also read by lazily loaded message bundles). */
  messages: HostMessages;
  /** The host's text for its own error codes (`messages["error.<code>"]`); pass to describe*Error. */
  hostErrorText: HostErrorText;
  keys: TangentKeys;
  /** Transient live state (streaming text, connection, retries); one per provider. */
  live: LiveStore;
  /** The host says this identity may only read (also learned from a 403 `forbidden`). */
  readOnly: boolean;
  /** US$ per turn above which the composer shows the estimated cost (handoff §9-6). */
  costThreshold: number;
}

/** The prototype's default cost threshold (settings offer 0.02 / 0.05 / 0.10). */
export const DEFAULT_COST_THRESHOLD = 0.05;

const TangentContext = createContext<TangentContextValue | null>(null);
const NO_MESSAGES: HostMessages = {};

export interface TangentProviderProps {
  client: TangentClient;
  tenant?: string | undefined;
  /**
   * The signed-in identity (user id or similar), added to every query key so
   * one viewer never sees another's cached data. When it changes, the host
   * should also call `queryClient.clear()` to drop the previous identity's
   * entries from memory.
   */
  scopeKey?: string | undefined;
  /** BCP 47 tag; Chinese uses zh-TW, Japanese uses ja, anything unknown English. */
  locale?: string | undefined;
  /**
   * The host's own wording merged over the bundled dictionary, plus
   * `error.<code>` entries for its own error codes. An inline object is fine:
   * it is compared shallowly, so a new object with the same entries does not
   * re-render the tree.
   */
  messages?: HostMessages | undefined;
  /**
   * The viewer may only read: writing UI (composer, actions) is hidden and
   * the banner says so. Tangent also turns read-only by itself when the
   * server refuses a write with 403 `forbidden`.
   */
  readOnly?: boolean | undefined;
  /** The user's (or the host's locked) cost threshold in US$; defaults to 0.05. */
  costThreshold?: number | undefined;
  children: ReactNode;
}

/** Makes the client, the i18n helper and the query keys available to Tangent components. */
/**
 * The locale's dictionary, or undefined while it downloads (F5: only the
 * locale in use is loaded); starts the download when needed. A failed
 * download leaves English in place and is not remembered: the next switch
 * to the locale (or a remount) tries again (R9 G5).
 */
function useLocaleDictionary(locale: Locale): Messages | undefined {
  const dictionary = useSyncExternalStore(subscribeLocales, () => localeMessages(locale));
  useEffect(() => {
    if (dictionary) return;
    loadLocale(locale).catch((error: unknown) => console.warn(`tangent: the "${locale}" dictionary did not load; showing English`, error));
  }, [dictionary, locale]);
  return dictionary;
}

export function TangentProvider({ client, tenant = "", scopeKey = "", locale = DEFAULT_LOCALE, messages, readOnly = false, costThreshold = DEFAULT_COST_THRESHOLD, children }: TangentProviderProps) {
  const stableMessages = useShallowStable(messages);
  // One live store per identity (and client): a new viewer starts with no streams and no read-only flag.
  const live = useMemo(() => createLiveStore(), [client, scopeKey]);
  const resolved = resolveLocale(locale);
  // English until the locale's dictionary arrives; the translator is rebuilt when it does.
  const dictionary = useLocaleDictionary(resolved);
  const value = useMemo<TangentContextValue>(
    () => ({
      client,
      tenant,
      scopeKey,
      locale: resolved,
      t: createTranslator(dictionary ? resolved : DEFAULT_LOCALE, stableMessages),
      messages: stableMessages ?? NO_MESSAGES,
      hostErrorText: createHostErrorText(stableMessages),
      keys: tangentKeys({ baseUrl: client.baseUrl, tenant, scopeKey }),
      live,
      readOnly,
      costThreshold,
    }),
    [client, tenant, scopeKey, resolved, dictionary, stableMessages, live, readOnly, costThreshold],
  );
  return <TangentContext.Provider value={value}>{children}</TangentContext.Provider>;
}

export function useTangent(): TangentContextValue {
  const value = useContext(TangentContext);
  if (!value) throw new Error("Tangent hooks must be used inside <TangentProvider>.");
  return value;
}

export function useTangentClient(): TangentClient {
  return useTangent().client;
}

export function useTangentT(): Translate {
  return useTangent().t;
}

export function useTangentKeys(): TangentKeys {
  return useTangent().keys;
}

const ENGLISH = createTranslator(DEFAULT_LOCALE);

/** The cost threshold of the provider, or the default outside one. */
export function useCostThreshold(): number {
  return useContext(TangentContext)?.costThreshold ?? DEFAULT_COST_THRESHOLD;
}

const DEFAULT_UI_LOCALE = { locale: DEFAULT_LOCALE, messages: NO_MESSAGES };

/** The provider's locale and host wording, or English and none outside a provider (lazy message bundles read it). */
export function useUiLocale(): { locale: Locale; messages: HostMessages } {
  const value = useContext(TangentContext);
  return useMemo(() => (value ? { locale: value.locale, messages: value.messages } : DEFAULT_UI_LOCALE), [value]);
}

/**
 * The provider's translator, or English outside a provider. Base components
 * (Button, Dialog, CommandPalette…) use it so they also work in a host page
 * that renders them without a client.
 */
export function useUiT(): Translate {
  return useContext(TangentContext)?.t ?? ENGLISH;
}
