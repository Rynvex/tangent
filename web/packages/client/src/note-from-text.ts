/**
 * A note's starting text from a message (F20a): the conversation's 存成紀要
 * needs it on first render, the notes page's logic (`notes-page.ts`, which
 * re-exports it) loads with the notes tab.
 */
import { noteDraft } from "./note-draft";

/** A note taken from a message or a selection starts as at most this many characters (the prototype's cut); it can be edited after. */
export const NOTE_FROM_MESSAGE_CHARS = 120;

/** A note's starting text from a message or a selection: one line, at most `max` characters. */
export function noteFromText(text: string, max = NOTE_FROM_MESSAGE_CHARS): string {
  return noteDraft(text, max);
}
