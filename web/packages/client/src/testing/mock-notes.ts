/** Simulated notes and chapter milestones. */
import type { ChaptersView, CreateMilestoneInput, CreateNoteInput, MilestoneWriteResult, NotesView, NoteWriteResult, SupersedeNoteInput, UpdateNoteInput } from "../api-types";
import { isFeatureOn } from "../capabilities";
import { TangentError } from "../errors";
import type { Milestone, Note, NoteChange } from "../types";
import type { MockContext } from "./mock-context";
import { chatNumbers } from "../branch-view";
import { findLine, messagesOf, newId, rootOf, type MockState } from "./mock-store";
import { deriveChapters } from "./mock-chapters";
import { fixture } from "./scenario";

export interface MockNotes {
  list(lineId: string): NotesView;
  create(lineId: string, input: CreateNoteInput): NoteWriteResult;
  update(lineId: string, noteId: string, input: UpdateNoteInput): NoteWriteResult;
  supersede(lineId: string, noteId: string, input: SupersedeNoteInput): NoteWriteResult;
  chapters(lineId: string): ChaptersView;
  addMilestone(lineId: string, input: CreateMilestoneInput): MilestoneWriteResult;
  deleteMilestone(lineId: string, milestoneId: string): void;
  /** The `noteChanges` of a merge, applied in one revision; the shape of `MergeBranchResult.notes`. */
  applyChanges(lineId: string, changes: readonly NoteChange[], sourceLineId: string): { rootLineId: string; revision: number; created: Note[]; superseded: Note[] };
}

const SOURCE_KINDS: Readonly<Record<string, string>> = { aside: "順口問", investigate: "查證", alternative: "另一條路" };

/** The server's default (zh-TW) source label of a new note (domain.NoteSourceLabels.Render, B8); "" without a source line. */
export function mockSourceLabel(state: MockState, root: string, source: { sourceLineId: string; sourceMessageId: string; sourceCardMessageId?: string | undefined }): string {
  if (!source.sourceLineId) return "";
  const card = Boolean(source.sourceCardMessageId);
  if (source.sourceLineId === root && !card) {
    const n = source.sourceMessageId ? chatNumbers(messagesOf(state, root)).get(source.sourceMessageId) : undefined;
    return n ? `主線 #${n}` : "主線";
  }
  const branch = state.branches.find((item) => item.lineId === source.sourceLineId);
  if (!branch) return "";
  const title = branch.origin === "previous_main_line" ? "原本的主線" : branch.purpose;
  return card ? `結論卡・${title}` : `${SOURCE_KINDS[branch.kind] ?? branch.kind}・${title}`;
}

export function createMockNotes(ctx: MockContext): MockNotes {
  const rootFor = (lineId: string) => rootOf(findLine(ctx.state(), lineId));
  const notesOf = (root: string) => ctx.state().notesByRoot[root] ?? [];

  /** Stores the root's notes, bumps the revision and publishes `notes.changed`. */
  function save(root: string, notes: readonly Note[]): number {
    const state = ctx.state();
    const revision = (state.notesRevision[root] ?? 0) + 1;
    ctx.commit({ ...state, notesByRoot: { ...state.notesByRoot, [root]: notes }, notesRevision: { ...state.notesRevision, [root]: revision } });
    ctx.bus.publish("notes.changed", { lineId: root, rootLineId: root }, { rootLineId: root, revision });
    return revision;
  }

  function activeNote(root: string, noteId: string): Note {
    const note = notesOf(root).find((item) => item.id === noteId);
    if (!note) throw new TangentError(404, "note not found", "note_not_found");
    if (note.status === "superseded") throw new TangentError(409, "the note was superseded", "note_superseded");
    return note;
  }

  /** The notes routes are not mounted while the feature is off (404 feature_disabled). */
  function requireNotes(): void {
    if (!isFeatureOn(ctx.scenario.capabilities, "notes")) throw new TangentError(404, "the notes feature is off", "feature_disabled", { feature: "notes" });
  }

  /** Like store.resolveNoteSource: a source message names its own line; both must belong to this conversation. */
  function source(root: string, raw: { sourceLineId?: string | undefined; sourceMessageId?: string | undefined }): { sourceLineId: string; sourceMessageId: string } {
    const inTree = (lineId: string) => ctx.state().lines.some((line) => line.id === lineId && rootOf(line) === root);
    const notFound = () => new TangentError(404, "the note's source is not in this conversation", "note_source_not_found");
    if (raw.sourceMessageId) {
      const message = ctx.state().messages.find((item) => item.id === raw.sourceMessageId);
      if (!message || !inTree(message.lineId)) throw notFound();
      return { sourceLineId: message.lineId, sourceMessageId: message.id };
    }
    if (raw.sourceLineId && !inTree(raw.sourceLineId)) throw notFound();
    return { sourceLineId: raw.sourceLineId ?? "", sourceMessageId: "" };
  }

  function newNote(root: string, raw: Record<string, unknown> & { sourceLineId?: string | undefined; sourceMessageId?: string | undefined }): Note {
    const from = source(root, raw);
    const [id, next] = newId(ctx.state(), "note");
    ctx.commit(next);
    const sourceLabel = mockSourceLabel(ctx.state(), root, from);
    return fixture.note({ id, status: "active", createdAt: ctx.now(), updatedAt: ctx.now(), ...raw, ...from, ...(sourceLabel ? { sourceLabel } : {}) });
  }

  function saveChapters(root: string, milestones: readonly Milestone[]): void {
    const state = ctx.state();
    const current = state.chaptersByLine[root] ?? { chapters: [], milestones: [] };
    ctx.commit({ ...state, chaptersByLine: { ...state.chaptersByLine, [root]: { ...current, milestones: [...milestones] } } });
    ctx.bus.publish("chapters.changed", { lineId: root, rootLineId: root }, { rootLineId: root });
  }

  return {
    list(lineId) {
      requireNotes();
      const root = rootFor(lineId);
      const notes = [...notesOf(root)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { rootLineId: root, revision: ctx.state().notesRevision[root] ?? 0, notes, limits: ctx.scenario.noteLimits };
    },

    create(lineId, input) {
      requireNotes();
      const root = rootFor(lineId);
      if (!input.text.trim()) throw new TangentError(422, "the note is empty", "invalid_note", { problems: [{ field: "text", message: "required" }] });
      const note = newNote(root, { ...input });
      return { note, revision: save(root, [...notesOf(root), note]), rootLineId: root };
    },

    update(lineId, noteId, input) {
      requireNotes();
      const root = rootFor(lineId);
      const note: Note = { ...activeNote(root, noteId), ...input, updatedAt: ctx.now() };
      return { note, revision: save(root, notesOf(root).map((item) => (item.id === noteId ? note : item))), rootLineId: root };
    },

    supersede(lineId, noteId, input) {
      requireNotes();
      const root = rootFor(lineId);
      const old = activeNote(root, noteId);
      const note = newNote(root, { section: input.section ?? old.section, text: input.text, sourceLineId: input.sourceLineId, sourceMessageId: input.sourceMessageId });
      const superseded: Note = { ...old, status: "superseded", supersededBy: note.id, updatedAt: ctx.now() };
      const notes = [...notesOf(root).map((item) => (item.id === noteId ? superseded : item)), note];
      return { note, superseded, revision: save(root, notes), rootLineId: root };
    },

    chapters(lineId) {
      const root = rootFor(lineId);
      const view = ctx.state().chaptersByLine[root] ?? { chapters: [], milestones: [] };
      const messages = messagesOf(ctx.state(), lineId);
      const stored = lineId === root ? view.chapters : [];
      const milestones = view.milestones.filter((milestone) => messages.some((message) => message.id === milestone.messageId));
      return { lineId, rootLineId: root, chapters: deriveChapters(messages, stored, milestones, ctx.state().branches.filter((branch) => branch.parentLineId === lineId)), milestones, limits: ctx.scenario.chapterLimits };
    },

    addMilestone(lineId, input) {
      const root = rootFor(lineId);
      if (!messagesOf(ctx.state(), lineId).some((message) => message.id === input.messageId)) throw new TangentError(404, "message not found", "message_not_found");
      const milestones = ctx.state().chaptersByLine[root]?.milestones ?? [];
      if (milestones.some((item) => item.messageId === input.messageId)) throw new TangentError(409, "already a milestone", "milestone_exists");
      const [id, next] = newId(ctx.state(), "milestone");
      ctx.commit(next);
      const milestone: Milestone = { id, messageId: input.messageId, kind: "milestone", title: input.title ?? "", createdBy: "", createdAt: ctx.now() };
      saveChapters(root, [...milestones, milestone]);
      return { milestone, rootLineId: root };
    },

    applyChanges(lineId, changes, sourceLineId) {
      const root = rootFor(lineId);
      let notes = [...notesOf(root)];
      const created: Note[] = [];
      const superseded: Note[] = [];
      for (const change of changes) {
        const old = change.op === "supersede" ? activeNote(root, change.noteId) : null;
        const note = newNote(root, { section: change.section ?? old?.section, text: change.text, sourceLineId: change.sourceLineId ?? sourceLineId, sourceMessageId: change.sourceMessageId });
        created.push(note);
        if (old) {
          const replaced: Note = { ...old, status: "superseded", supersededBy: note.id, updatedAt: ctx.now() };
          superseded.push(replaced);
          notes = notes.map((item) => (item.id === old.id ? replaced : item));
        }
        notes = [...notes, note];
      }
      return { rootLineId: root, revision: save(root, notes), created, superseded };
    },

    deleteMilestone(lineId, milestoneId) {
      const root = rootFor(lineId);
      const milestones = ctx.state().chaptersByLine[root]?.milestones ?? [];
      if (!milestones.some((item) => item.id === milestoneId)) throw new TangentError(404, "milestone not found", "milestone_not_found");
      saveChapters(root, milestones.filter((item) => item.id !== milestoneId));
    },
  };
}
