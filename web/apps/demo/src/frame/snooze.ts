/**
 * 暫存 in the review (C5): an item is hidden for a day. Kept in this browser
 * only (DESIGN §12 B9: the server stores no snoozes), like the notes' 「新」.
 */
import type { PrefsStorage } from "./prefs";

/** How long 暫存 hides an item. */
export const SNOOZE_MS = 86_400_000;

/** Item key → epoch ms until which it stays hidden. */
export type Snoozes = Readonly<Record<string, number>>;

const KEY = "tangent-demo.review-snoozes";

/** One item of one review group (ids are unique within a kind only). */
export const reviewKey = (group: string, id: string): string => `${group}:${id}`;

export function isSnoozed(snoozes: Snoozes, key: string, now: number): boolean {
  return (snoozes[key] ?? 0) > now;
}

export function snooze(snoozes: Snoozes, key: string, now: number): Snoozes {
  return { ...snoozes, [key]: now + SNOOZE_MS };
}

export function unsnooze(snoozes: Snoozes, key: string): Snoozes {
  const { [key]: _gone, ...rest } = snoozes;
  return rest;
}

/** The stored snoozes still running; anything unreadable counts as none. */
export function loadSnoozes(storage: PrefsStorage | null, now: number): Snoozes {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    if (typeof raw !== "object" || raw === null) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > now));
  } catch {
    return {};
  }
}

/** Keeps them; when storage refuses, they last until the page reloads. */
export function saveSnoozes(storage: PrefsStorage | null, snoozes: Snoozes): void {
  try {
    storage?.setItem(KEY, JSON.stringify(snoozes));
  } catch {
    // Not kept this time.
  }
}
