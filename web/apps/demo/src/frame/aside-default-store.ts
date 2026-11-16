/**
 * The store behind 「順口問預設」 in a conversation's menu (F18 §2.2): the
 * main lines whose quick questions are kept from the start, in this browser
 * only. A module store with subscribe (like the pinned conversations), so
 * every menu shows the same; storage that is blocked or holds garbage reads
 * as 用完即丟 everywhere.
 */
import { useSyncExternalStore } from "react";
import { ASIDE_DEFAULT_KEY, type AsideDefault, type AsideDefaultStorage } from "./aside-default";

/** More would only be a mistake; the oldest go first. */
export const ASIDE_DEFAULT_MAX = 200;

/** The main lines set to 保留 in the stored value, in the order they were set; anything unreadable is none. */
export function parseAsideKeepers(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === "string" && id !== ""))].slice(-ASIDE_DEFAULT_MAX);
  } catch {
    return [];
  }
}


/** `ids` with `rootLineId` set to keep (newest last) or back to the default. */
export function withAsideDefault(ids: readonly string[], rootLineId: string, value: AsideDefault): string[] {
  const rest = ids.filter((id) => id !== rootLineId);
  return (value === "keep" ? [...rest, rootLineId] : rest).slice(-ASIDE_DEFAULT_MAX);
}

export interface AsideDefaultStore {
  /** The main lines set to 保留. */
  get(): readonly string[];
  set(rootLineId: string, value: AsideDefault): void;
  subscribe(listener: () => void): () => void;
}

const EMPTY: readonly string[] = Object.freeze([]);

/** A store over `storage()`; when writing fails the choice lasts until the page reloads. */
export function createAsideDefaultStore(storage: () => AsideDefaultStorage | null): AsideDefaultStore {
  let current: readonly string[] | null = null;
  const listeners = new Set<() => void>();
  const read = (): readonly string[] => {
    try {
      const ids = parseAsideKeepers(storage()?.getItem(ASIDE_DEFAULT_KEY) ?? null);
      return ids.length > 0 ? ids : EMPTY;
    } catch {
      return EMPTY;
    }
  };
  return {
    get: () => (current ??= read()),
    set(rootLineId, value) {
      const next = withAsideDefault(current ?? read(), rootLineId, value);
      current = next;
      try {
        storage()?.setItem(ASIDE_DEFAULT_KEY, JSON.stringify(next));
      } catch {
        // Not kept this time; the choice still shows on this page.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      // Another tab's change (`null`: it cleared all of storage).
      const onStorage = (event: StorageEvent) => {
        if (event.key !== ASIDE_DEFAULT_KEY && event.key !== null) return;
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

function browserStorage(): AsideDefaultStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The page's store. */
export const asideDefaults = createAsideDefaultStore(browserStorage);

/** The conversation's default, re-rendering when it changes. */
export function useAsideDefault(rootLineId: string, store: AsideDefaultStore = asideDefaults): AsideDefault {
  const ids = useSyncExternalStore(store.subscribe, store.get, () => EMPTY);
  return ids.includes(rootLineId) ? "keep" : "discard";
}
