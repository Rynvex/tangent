import { NOTE_TEXT_MAX } from "./note-draft";
import { sortBySeq } from "./text";
import type { Message, NoteSection } from "./types";

export { NOTE_TEXT_MAX, noteDraft } from "./note-draft";

/** The four sections, in the order the prompt lists them. */
export const NOTE_SECTIONS: readonly NoteSection[] = ["decided", "fact", "to_confirm", "todo"];

/** The reply of a finished aside: its last completed assistant message (by seq). */
export function asideAnswer(messages: readonly Message[] | undefined): Message | null {
  const answers = sortBySeq(messages ?? []).filter(
    (message) => message.role === "assistant" && message.status === "done" && message.content.trim() !== "",
  );
  return answers[answers.length - 1] ?? null;
}

export type NoteTextProblem = "empty" | "tooLong" | null;

export function validateNote(text: string, max = NOTE_TEXT_MAX): NoteTextProblem {
  const length = Array.from(text.trim()).length;
  if (length === 0) return "empty";
  return length > max ? "tooLong" : null;
}
