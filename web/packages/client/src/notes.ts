import { NOTE_SECTIONS } from "./aside-note";
import type { Note, NoteChange, NoteSection } from "./types";

/** Default cap on the proposals of one merge (domain.DefaultLimits().Notes.MaxChangesPerMerge). */
export const NOTE_CHANGES_MAX = 10;

export interface GroupedNotes {
  /** Active and done lines per section, newest first (the order the server sends). */
  bySection: Record<NoteSection, Note[]>;
  /** Replaced lines, newest first; shown collapsed. */
  superseded: Note[];
  /** Lines whose section this client does not know (a newer server); never dropped. */
  other: Note[];
}

export function groupNotes(notes: readonly Note[]): GroupedNotes {
  const bySection: Record<NoteSection, Note[]> = { decided: [], fact: [], to_confirm: [], todo: [] };
  const superseded: Note[] = [];
  const other: Note[] = [];
  // The arrays are local to this call; filling them is not visible outside.
  for (const note of notes) {
    if (note.status === "superseded") superseded.push(note);
    else if (NOTE_SECTIONS.includes(note.section)) bySection[note.section].push(note);
    else other.push(note);
  }
  return { bySection, superseded, other };
}

export function activeCount(notes: readonly Note[]): number {
  return notes.filter((note) => note.status === "active").length;
}

/** The line that replaced `note`, when it is still in the list. */
export function replacementOf(note: Note, notes: readonly Note[]): Note | undefined {
  return note.supersededBy ? notes.find((item) => item.id === note.supersededBy) : undefined;
}

/** One row of the "update the notes too" proposal in the return dialog. */
export interface NoteProposal {
  key: string;
  op: "add" | "supersede";
  included: boolean;
  section: NoteSection;
  text: string;
  /** The replaced note, for `supersede`. */
  noteId: string;
  /** Proposed by the card draft (B5), not typed by the user. */
  ai?: boolean;
}

/**
 * The card draft's proposed note changes (B5) as review rows, ticked and
 * marked as the AI's; a replacement without a section takes the replaced
 * note's (from `notes`), else 已決定.
 */
export function proposalsFromDraft(changes: readonly NoteChange[], notes: readonly Note[] = []): NoteProposal[] {
  return changes.map((change, index) => {
    const replaced = change.op === "supersede" ? notes.find((note) => note.id === change.noteId) : undefined;
    return {
      key: `ai-${index}`,
      op: change.op,
      included: true,
      section: change.section ?? replaced?.section ?? "decided",
      text: change.text,
      noteId: change.op === "supersede" ? change.noteId : "",
      ai: true,
    };
  });
}

function toChange(row: NoteProposal): NoteChange[] {
  const text = row.text.trim();
  if (!row.included || text === "") return [];
  if (row.op === "add") return [{ op: "add", section: row.section, text }];
  return row.noteId !== "" ? [{ op: "supersede", noteId: row.noteId, section: row.section, text }] : [];
}

/**
 * Only the ticked rows with text go into the request, at most `max` of them
 * (the server's `maxChangesPerMerge`); a replacement always names the note it
 * replaces.
 */
export function buildNoteChanges(rows: readonly NoteProposal[], max = NOTE_CHANGES_MAX): NoteChange[] {
  return rows.flatMap(toChange).slice(0, max);
}
