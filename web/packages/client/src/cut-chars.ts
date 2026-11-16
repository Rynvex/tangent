/**
 * `cutChars` on its own (F20a): the memo flow in the main bundle needs it, the
 * rest of F8's re-ask logic (`f8-turns.ts`, which re-exports it) loads with its dialogs.
 */

/** At most `max` characters, the last one an ellipsis when cut (`domain.CutRunes`). */
export function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max || max < 1) return text;
  return `${chars.slice(0, max - 1).join("").trim()}…`;
}
