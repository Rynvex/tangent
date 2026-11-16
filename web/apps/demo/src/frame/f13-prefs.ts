/**
 * Small per-browser conveniences of F13 (never state that must persist): the
 * menu's 「新」 marks until each new item is used once, and which folders of
 * the list are collapsed. Storage can be missing or throw (private windows);
 * then nothing is remembered.
 */
import { useSyncExternalStore } from "react";

const SEEN_KEY = "tangent:f13-menu-seen";
const COLLAPSED_KEY = "tangent:folders-collapsed";

function read(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, values: readonly string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Not remembered: the page works the same without it.
  }
}

/** A list of strings in storage that components can follow. */
function createStore(key: string) {
  let values = typeof window === "undefined" ? [] : read(key);
  const listeners = new Set<() => void>();
  return {
    get: () => values,
    has: (value: string) => values.includes(value),
    set(value: string, on: boolean) {
      if (values.includes(value) === on) return;
      values = on ? [...values, value] : values.filter((item) => item !== value);
      write(key, values);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type StringSetStore = ReturnType<typeof createStore>;

export const menuSeen = createStore(SEEN_KEY);
export const collapsedFolders = createStore(COLLAPSED_KEY);

export function useStringSet(store: StringSetStore): readonly string[] {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
