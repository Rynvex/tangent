/**
 * The conversation list's server search (B5 `GET /search`, DESIGN §12 F3):
 * grouping, the highlighted parts of a snippet, and the keyboard cursor. Pure,
 * so the edge cases are tested without a browser.
 */
import type { SearchHighlight, SearchHit, SearchHitKind } from "@tangent/client";
import type { PrefsStorage } from "./prefs";

/** The server refuses shorter queries (400 invalid_input). */
export const SEARCH_MIN_CHARS = 2;

export type SearchPhase = "idle" | "tooShort" | "search";

export function searchPhase(query: string): SearchPhase {
  const length = Array.from(query.trim()).length;
  if (length === 0) return "idle";
  return length < SEARCH_MIN_CHARS ? "tooShort" : "search";
}

export interface HitGroup<T extends SearchHit = SearchHit> {
  kind: SearchHitKind;
  hits: T[];
}

const KIND_ORDER: readonly SearchHitKind[] = ["title", "purpose", "message"];

/** Titles, then branch purposes, then messages; the server's ranking within each. Empty groups left out. */
export function groupHits<T extends SearchHit>(hits: readonly T[]): HitGroup<T>[] {
  return KIND_ORDER.map((kind) => ({ kind, hits: hits.filter((hit) => hit.kind === kind) })).filter((group) => group.hits.length > 0);
}

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/**
 * The snippet cut into plain and matched parts at the server's offsets
 * (UTF-16, end exclusive, as `String.slice` counts). Offsets are clamped,
 * sorted and merged, so bad input never throws or repeats text. The parts
 * are rendered as text, never as HTML.
 */
export function highlightParts(snippet: string, highlights: readonly SearchHighlight[]): SnippetPart[] {
  const ranges = highlights
    .map(({ start, end }) => ({ start: Math.max(0, Math.min(start, snippet.length)), end: Math.max(0, Math.min(end, snippet.length)) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const merged = ranges.reduce<Array<{ start: number; end: number }>>((all, range) => {
    const last = all.at(-1);
    if (last && range.start <= last.end) return [...all.slice(0, -1), { start: last.start, end: Math.max(last.end, range.end) }];
    return [...all, range];
  }, []);
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const range of merged) {
    if (range.start > at) parts.push({ text: snippet.slice(at, range.start), hit: false });
    parts.push({ text: snippet.slice(range.start, range.end), hit: true });
    at = range.end;
  }
  if (at < snippet.length) parts.push({ text: snippet.slice(at), hit: false });
  return parts;
}

/** The active result after ↑ (−1) or ↓ (+1), wrapping; −1 when there is nothing. */
export function nextIndex(current: number, step: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/** Characters kept before the first hit in the list (the server centres its ~120-character snippets on it). */
export const SNIPPET_LEAD = 24;

const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Shortens the text before the first hit to its last `lead` UTF-16 units,
 * with "…", so the hit is in view. A cut that lands on the second half of a
 * surrogate pair (an emoji) keeps the whole character.
 */
export function leadToHit(parts: SnippetPart[], lead = SNIPPET_LEAD): SnippetPart[] {
  const [first, second] = parts;
  if (!first || first.hit || !second || first.text.length <= lead) return parts;
  const cut = first.text.length - lead;
  const start = isLowSurrogate(first.text.charCodeAt(cut)) ? cut - 1 : cut;
  return [{ text: `…${first.text.slice(start)}`, hit: false }, ...parts.slice(1)];
}

/** A hit and whether its conversation is archived (the server searches one or the other per request). */
export type ListedHit = SearchHit & { archived: boolean };

/** The active conversations' hits plus, with 包含封存, the archived ones', ranked together by score (newer first on ties). */
export function mergeHits(active: readonly SearchHit[], archived: readonly SearchHit[] | undefined): ListedHit[] {
  const all = [...active.map((hit) => ({ ...hit, archived: false })), ...(archived ?? []).map((hit) => ({ ...hit, archived: true }))];
  return all.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
}

const INCLUDE_ARCHIVED_KEY = "tangent-demo.searchArchived";

/** 包含封存: off unless this browser turned it on; unreadable storage means off. */
export function loadIncludeArchived(storage: PrefsStorage | null): boolean {
  try {
    return storage?.getItem(INCLUDE_ARCHIVED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveIncludeArchived(storage: PrefsStorage | null, on: boolean): void {
  try {
    storage?.setItem(INCLUDE_ARCHIVED_KEY, on ? "1" : "0");
  } catch {
    // Not kept this time.
  }
}
