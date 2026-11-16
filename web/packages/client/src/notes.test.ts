import { describe, expect, it } from "vitest";
import type { Note } from "./types";
import { activeCount, buildNoteChanges, groupNotes, NOTE_CHANGES_MAX, proposalsFromDraft, replacementOf, type NoteProposal } from "./notes";

const note = (id: string, over: Partial<Note> = {}): Note => ({
  id, section: "fact", text: id, status: "active", sourceLineId: "", sourceMessageId: "", sourceCardMessageId: "",
  supersededBy: "", createdBy: "u", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});

const row = (over: Partial<NoteProposal>): NoteProposal => ({ key: "k", op: "add", included: true, section: "decided", text: "x", noteId: "", ...over });

describe("groupNotes", () => {
  it("splits into the four sections in server order and sets replaced lines aside", () => {
    const grouped = groupNotes([note("a", { section: "decided" }), note("b", { section: "todo", status: "done" }), note("c", { status: "superseded", supersededBy: "d" }), note("d")]);
    expect(grouped.bySection.decided.map((n) => n.id)).toEqual(["a"]);
    expect(grouped.bySection.todo.map((n) => n.id)).toEqual(["b"]);
    expect(grouped.bySection.fact.map((n) => n.id)).toEqual(["d"]);
    expect(grouped.superseded.map((n) => n.id)).toEqual(["c"]);
  });

  it("counts only active lines and finds the replacement", () => {
    const list = [note("a"), note("b", { status: "done" }), note("c", { status: "superseded", supersededBy: "a" })];
    expect(activeCount(list)).toBe(1);
    expect(replacementOf(list[2] as Note, list)?.id).toBe("a");
    expect(replacementOf(list[0] as Note, list)).toBeUndefined();
  });
});

describe("buildNoteChanges", () => {
  it("sends only ticked rows with text, trimmed", () => {
    const changes = buildNoteChanges([row({ text: " keep " }), row({ included: false }), row({ text: "  " })]);
    expect(changes).toEqual([{ op: "add", section: "decided", text: "keep" }]);
  });

  it("a replacement carries the replaced id and is dropped without one", () => {
    const changes = buildNoteChanges([row({ op: "supersede", noteId: "n1", section: "fact", text: "new" }), row({ op: "supersede", noteId: "" })]);
    expect(changes).toEqual([{ op: "supersede", noteId: "n1", section: "fact", text: "new" }]);
  });
});

describe("review fixes", () => {
  it("keeps a note with an unknown section in the other bucket (review LOW)", () => {
    const grouped = groupNotes([note("a", { section: "risk" as never }), note("b")]);
    expect(grouped.other.map((n) => n.id)).toEqual(["a"]);
    expect(grouped.bySection.fact.map((n) => n.id)).toEqual(["b"]);
  });

  it("caps the changes at the server's maxChangesPerMerge (review M7)", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ key: `k${i}`, text: `t${i}` }));
    expect(buildNoteChanges(rows)).toHaveLength(NOTE_CHANGES_MAX);
    expect(buildNoteChanges(rows, 3).map((c) => c.text)).toEqual(["t0", "t1", "t2"]);
  });
});

describe("proposalsFromDraft (B5: the draft's note proposals)", () => {
  it("turns the AI's changes into ticked rows marked as the AI's", () => {
    const rows = proposalsFromDraft([
      { op: "add", section: "decided", text: "Use ZFS", sourceLineId: "b1" },
      { op: "supersede", noteId: "n2", text: "Budget 35k" },
    ]);
    expect(rows).toEqual([
      { key: "ai-0", op: "add", included: true, section: "decided", text: "Use ZFS", noteId: "", ai: true },
      { key: "ai-1", op: "supersede", included: true, section: "decided", text: "Budget 35k", noteId: "n2", ai: true },
    ]);
  });

  it("keeps a replacement's section when the draft names one", () => {
    expect(proposalsFromDraft([{ op: "supersede", noteId: "n2", section: "fact", text: "x" }])[0]?.section).toBe("fact");
  });
});
