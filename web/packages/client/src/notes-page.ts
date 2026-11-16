/**
 * The notes page (A9): sections, the "new" mark, what the prompt leaves out,
 * and where a note came from. Pure, so the React side only renders.
 */
import { NOTE_SECTIONS } from "./aside-note";
import type { Note, NoteSection } from "./types";

export { NOTE_FROM_MESSAGE_CHARS, noteFromText } from "./note-from-text";

export interface NoteSectionGroup {
  section: NoteSection;
  /** Active notes first, then done ones; each in the server's order (newest first). */
  items: Note[];
  /** Replaced notes of this section; shown collapsed, struck through. */
  superseded: Note[];
  activeCount: number;
}

/** The four sections in the order the prompt lists them; notes of a section this client does not know are left out. */
export function noteSectionGroups(notes: readonly Note[]): NoteSectionGroup[] {
  return NOTE_SECTIONS.map((section) => {
    const own = notes.filter((item) => item.section === section);
    const active = own.filter((item) => item.status === "active");
    const done = own.filter((item) => item.status === "done");
    return { section, items: [...active, ...done], superseded: own.filter((item) => item.status === "superseded"), activeCount: active.length };
  });
}

/**
 * The section a replacement starts in (DESIGN §12 R5): something to confirm,
 * once confirmed, becomes a confirmed fact; every other note stays put.
 */
export function replacementSection(section: NoteSection): NoteSection {
  return section === "to_confirm" ? "fact" : section;
}

const instant = (value: string): number => Date.parse(value);

/**
 * "新": written after the viewer last looked at the notes page (DESIGN §12,
 * handoff backend.md 5). The time of the last visit is kept by the client;
 * on the first visit (none recorded) nothing is marked.
 */
export function isNewNote(note: Note, seenAt: string | null): boolean {
  if (seenAt === null || note.status === "superseded") return false;
  const created = instant(note.createdAt);
  const seen = instant(seenAt);
  return Number.isFinite(created) && Number.isFinite(seen) && created > seen;
}

/**
 * The active notes the prompt's notes block (the `notes` block of `POST
 * /preview`) does not carry: over its token budget the server leaves out the
 * oldest "to confirm", then "to do", then facts (domain.BuildNotesBlock).
 * Each carried note is one "- text" line, and stored texts are already in
 * that form. Nothing is known (an empty set) until there is a block.
 */
export function notesLeftOut(notes: readonly Note[], block: string | null | undefined): Set<string> {
  if (!block) return new Set();
  const lines = new Set(block.split("\n"));
  return new Set(notes.filter((note) => note.status === "active" && !lines.has(`- ${note.text}`)).map((note) => note.id));
}

/** Where a note came from: a conclusion card (its branch), a message, or only a line. */
export type NoteSource =
  | { kind: "card"; lineId: string; messageId: string }
  | { kind: "message"; lineId: string; messageId: string }
  | { kind: "line"; lineId: string };

export function noteSource(note: Note): NoteSource | null {
  if (note.sourceCardMessageId && note.sourceLineId) return { kind: "card", lineId: note.sourceLineId, messageId: note.sourceCardMessageId };
  if (note.sourceMessageId && note.sourceLineId) return { kind: "message", lineId: note.sourceLineId, messageId: note.sourceMessageId };
  if (note.sourceLineId) return { kind: "line", lineId: note.sourceLineId };
  return null;
}
