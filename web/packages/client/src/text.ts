/** Length in characters (code points), the unit the server counts (runes). */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** The first `max` characters of `text`. */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** A copy of `messages` ordered by seq (DESIGN: ordering within a line is always by seq). */
export function sortBySeq<T extends { seq: number }>(messages: readonly T[]): T[] {
  return [...messages].sort((a, b) => a.seq - b.seq);
}
