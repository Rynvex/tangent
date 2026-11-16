/**
 * The 前提已更新 reasons the user set aside (「知道了」, F8 S12), on this
 * device. Its own small module so the transcript (main bundle) can leave a
 * dismissed reason out of the fork rows without loading the badge.
 */
import { useSyncExternalStore } from "react";

/** Reasons the user set aside (「知道了」), on this device; a new reason shows again. */
const DISMISSED_KEY = "tangent:stale-dismissed:v1";
/** Kept small: only the newest ids matter. */
const DISMISSED_MAX = 500;

const listeners = new Set<() => void>();
let cached: { raw: string | null; set: ReadonlySet<string> } = { raw: null, set: new Set() };

function readDismissed(): ReadonlySet<string> {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return cached.set;
  }
  if (raw === cached.raw) return cached.set;
  let ids: string[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    ids = [];
  }
  cached = { raw, set: new Set(ids) };
  return cached.set;
}

export function dismissStale(ids: readonly string[]): void {
  const next = [...new Set([...readDismissed(), ...ids])].slice(-DISMISSED_MAX);
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: remembered until the page reloads.
    cached = { raw: cached.raw, set: new Set(next) };
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useDismissedStale(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, readDismissed, () => cached.set);
}
