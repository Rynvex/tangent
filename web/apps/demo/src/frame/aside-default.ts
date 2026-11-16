/**
 * Each conversation's default for its quick questions (F18 §2.2): 用完即丟
 * (cleared 7 days after the answer, as ever) or 保留 (kept from the start).
 * Kept in this browser only (`localStorage`, like the pinned conversations),
 * keyed by the main line; only the conversations set to 保留 are stored.
 * This file is the read the conversation needs on first render; the store
 * the menu writes through is `aside-default-store.ts`.
 */
export const ASIDE_DEFAULT_KEY = "tangent:aside-default:v1";
export type AsideDefault = "discard" | "keep";

/** The part of `Storage` used here, so tests can pass a fake. */
export interface AsideDefaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): AsideDefaultStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Whether the conversation's quick questions are kept from the start; read when one is asked, so it is never stale. */
export function keepsAsides(rootLineId: string | null, storage: AsideDefaultStorage | null = browserStorage()): boolean {
  try {
    const kept: unknown = JSON.parse(storage?.getItem(ASIDE_DEFAULT_KEY) ?? "[]");
    return Array.isArray(kept) && kept.includes(rootLineId);
  } catch {
    return false;
  }
}
