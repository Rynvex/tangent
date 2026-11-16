/**
 * Conversations pinned to the top of the list (F8 S5, decision #6). Kept in
 * this browser only (`localStorage`), so the menu says 只在這台裝置. A
 * module store with subscribe, so the list and every menu update together;
 * storage that is blocked or holds garbage reads as nothing pinned.
 */
import { useSyncExternalStore } from "react";

export const PINNED_ROOTS_KEY = "tangent:pinned-roots:v1";
/** More would only be a mistake; the oldest pins drop first. */
export const PINNED_ROOTS_MAX = 50;

/** The part of `Storage` used here, so tests can pass a fake. */
export interface PinnedStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The ids in the stored value, deduplicated, in pin order; anything unreadable is an empty list. */
export function parsePinned(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === "string" && id !== ""))].slice(-PINNED_ROOTS_MAX);
  } catch {
    return [];
  }
}

/** `ids` with `lineId` pinned (moved to the end, newest pin last) or unpinned. */
export function togglePinned(ids: readonly string[], lineId: string, pinned: boolean): string[] {
  const rest = ids.filter((id) => id !== lineId);
  return (pinned ? [...rest, lineId] : rest).slice(-PINNED_ROOTS_MAX);
}

export interface PinnedStore {
  get(): readonly string[];
  set(lineId: string, pinned: boolean): void;
  subscribe(listener: () => void): () => void;
}

const EMPTY: readonly string[] = Object.freeze([]);

/** A store over `storage()`; when writing fails the pin lasts until the page reloads. */
export function createPinnedStore(storage: () => PinnedStorage | null): PinnedStore {
  let current: readonly string[] | null = null;
  const listeners = new Set<() => void>();
  const read = (): readonly string[] => {
    try {
      const ids = parsePinned(storage()?.getItem(PINNED_ROOTS_KEY) ?? null);
      return ids.length > 0 ? ids : EMPTY;
    } catch {
      return EMPTY;
    }
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    get: () => (current ??= read()),
    set(lineId, pinned) {
      const next = togglePinned(current ?? read(), lineId, pinned);
      current = next;
      try {
        storage()?.setItem(PINNED_ROOTS_KEY, JSON.stringify(next));
      } catch {
        // Not kept this time; the pin still shows on this page.
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      // Another tab's change.
      const onStorage = (event: StorageEvent) => {
        // `null`: the other tab cleared all of storage.
        if (event.key !== PINNED_ROOTS_KEY && event.key !== null) return;
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

function browserStorage(): PinnedStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The page's store. */
export const pinnedRoots = createPinnedStore(browserStorage);

/** The pinned ids, re-rendering when they change. */
export function usePinnedRoots(store: PinnedStore = pinnedRoots): readonly string[] {
  return useSyncExternalStore(store.subscribe, store.get, () => EMPTY);
}
