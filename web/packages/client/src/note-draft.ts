/**
 * `noteDraft` and its default cap on their own (F20b), re-exported by `aside-note.ts` so every
 * import path stays the same. The conversation's 存成紀要 needs `noteDraft` on first render
 * (through `note-from-text.ts`); the rest of `aside-note.ts` (sections, the aside's answer,
 * validation) is only used by dialogs and side panels, and now loads with them.
 */

/** Default cap on one note (domain.DefaultLimits().Notes.MaxRunes); see `NotesView.limits.maxRunes`. */
export const NOTE_TEXT_MAX = 400;

/** A starting point for the note: the answer on one line, cut to `max` characters. */
export function noteDraft(answer: string, max = NOTE_TEXT_MAX): string {
  const chars = Array.from(answer.replace(/\s+/g, " ").trim());
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}
