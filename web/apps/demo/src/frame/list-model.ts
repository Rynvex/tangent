/**
 * The conversation list's grouping, time labels and search (A1), pure so the
 * calendar edges are tested without a browser. Days are counted in the
 * viewer's time zone (or the one given, for tests).
 */
import type { LineView } from "@tangent/client";

export type LineGroupKey = "today" | "yesterday" | "week" | "earlier";

export interface LineGroup {
  key: LineGroupKey;
  lines: LineView[];
}

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

/** Midnight-based day number of an instant in a time zone. */
function dayNumber(at: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(at);
  return Math.floor(Date.parse(`${parts}T00:00:00Z`) / DAY_MS);
}

/** How many calendar days ago `iso` was (0 = today); null for an invalid time. */
export function daysAgo(iso: string, now: Date, timeZone?: string): number | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return dayNumber(now, timeZone) - dayNumber(at, timeZone);
}

export function groupKey(iso: string, now: Date, timeZone?: string): LineGroupKey {
  const days = daysAgo(iso, now, timeZone);
  if (days === null || days >= WEEK_DAYS) return "earlier";
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : "week";
}

/** Lines by last activity, newest first, in today / yesterday / this week / earlier; empty groups left out. */
export function groupLines(lines: readonly LineView[], now: Date, timeZone?: string): LineGroup[] {
  const order: LineGroupKey[] = ["today", "yesterday", "week", "earlier"];
  const sorted = [...lines].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return order
    .map((key) => ({ key, lines: sorted.filter((line) => groupKey(line.lastActivityAt, now, timeZone) === key) }))
    .filter((group) => group.lines.length > 0);
}

/** Today: "20:42" ("8:42 PM" with `hour12`, G2's time format); this week: the weekday ("週二"); older: the date ("10/2"). */
export function timeLabel(iso: string, now: Date, locale: string, timeZone?: string, hour12 = false): string {
  const days = daysAgo(iso, now, timeZone);
  if (days === null) return "";
  const at = new Date(iso);
  if (days <= 0) return new Intl.DateTimeFormat(locale, { hour: hour12 ? "numeric" : "2-digit", minute: "2-digit", hour12, timeZone }).format(at);
  if (days < WEEK_DAYS) return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone }).format(at);
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", timeZone }).format(at);
}

/** Case-insensitive match on the title and the summary topic; every word must appear. */
export function matchesSearch(line: LineView, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${line.title} ${line.summary.topic}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** "Waiting for you" (DESIGN §12): unread replies anywhere in the tree, or a card draft ready to review. */
export function isWaiting(line: LineView): boolean {
  return line.unread + line.branchUnread > 0 || line.awaitingReview > 0;
}

/**
 * The pinned conversations (S5, newest pin first) and the rest; a pinned id
 * that is not in `lines` (archived, deleted, another tenant) is skipped.
 */
export function splitPinned(lines: readonly LineView[], pinnedIds: readonly string[]): { pinned: LineView[]; rest: LineView[] } {
  const byId = new Map(lines.map((line) => [line.id, line]));
  const pinned = [...pinnedIds].reverse().flatMap((id) => byId.get(id) ?? []);
  const ids = new Set(pinned.map((line) => line.id));
  return { pinned, rest: lines.filter((line) => !ids.has(line.id)) };
}
