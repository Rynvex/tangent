import { describe, expect, it } from "vitest";
import type { Note } from "./types";
import { isNewNote, NOTE_FROM_MESSAGE_CHARS, noteFromText, noteSectionGroups, notesLeftOut, noteSource, replacementSection } from "./notes-page";

const note = (id: string, over: Partial<Note> = {}): Note => ({
  id, section: "fact", text: id, status: "active", sourceLineId: "", sourceMessageId: "", sourceCardMessageId: "",
  supersededBy: "", createdBy: "u", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
});

describe("noteSectionGroups", () => {
  it("lists the four sections in prompt order, active before done, replaced ones apart", () => {
    const groups = noteSectionGroups([
      note("a", { section: "todo", status: "done" }),
      note("b", { section: "todo" }),
      note("c", { section: "todo", status: "superseded", supersededBy: "b" }),
      note("d", { section: "decided" }),
    ]);
    expect(groups.map((group) => group.section)).toEqual(["decided", "fact", "to_confirm", "todo"]);
    const todo = groups[3];
    expect(todo?.items.map((item) => item.id)).toEqual(["b", "a"]);
    expect(todo?.superseded.map((item) => item.id)).toEqual(["c"]);
    expect(todo?.activeCount).toBe(1);
    expect(groups[1]?.items).toEqual([]);
  });

  it("leaves out notes of a section this client does not know", () => {
    const groups = noteSectionGroups([note("x", { section: "later" as Note["section"] })]);
    expect(groups.flatMap((group) => group.items)).toEqual([]);
  });
});

describe("isNewNote", () => {
  it("is new when created after the last visit; nothing is new on the first visit", () => {
    const created = note("a", { createdAt: "2026-01-02T10:00:00Z" });
    expect(isNewNote(created, "2026-01-02T09:00:00Z")).toBe(true);
    expect(isNewNote(created, "2026-01-02T10:00:00Z")).toBe(false);
    expect(isNewNote(created, null)).toBe(false);
  });

  it("compares instants, not strings (offsets and fractions)", () => {
    expect(isNewNote(note("a", { createdAt: "2026-01-02T10:00:00.5+08:00" }), "2026-01-02T01:59:59Z")).toBe(true);
    expect(isNewNote(note("a", { createdAt: "not a time" }), "2026-01-02T01:59:59Z")).toBe(false);
  });

  it("never marks a replaced note", () => {
    expect(isNewNote(note("a", { status: "superseded", createdAt: "2026-01-03T00:00:00Z" }), "2026-01-01T00:00:00Z")).toBe(false);
  });
});

describe("notesLeftOut", () => {
  const block = "## Conversation notes\n\nintro\n\n### Decided\n- Use ZFS\n\n### Confirmed facts\n- 2.1TB today\n\n(1 older note(s) left out to save space; they are on the notes page.)\n\n(End of the conversation notes.)\n\n";

  it("names the active notes the prompt's notes block does not carry", () => {
    const notes = [note("a", { text: "Use ZFS", section: "decided" }), note("b", { text: "2.1TB today" }), note("c", { text: "ECC?", section: "to_confirm" }), note("d", { text: "old", status: "done" })];
    expect([...notesLeftOut(notes, block)]).toEqual(["c"]);
  });

  it("knows nothing until there is a block", () => {
    expect(notesLeftOut([note("a")], undefined).size).toBe(0);
    expect(notesLeftOut([note("a")], null).size).toBe(0);
  });

  it("matches whole lines only", () => {
    expect([...notesLeftOut([note("a", { text: "Use" })], block)]).toEqual(["a"]);
  });
});

describe("noteFromText", () => {
  it("keeps one line, cut to the given length", () => {
    expect(noteFromText("  a\n\nb  c ", 10)).toBe("a b c");
    expect(Array.from(noteFromText("字".repeat(500))).length).toBe(NOTE_FROM_MESSAGE_CHARS);
  });
});

describe("noteSource", () => {
  it("prefers the conclusion card, then the message, then the line", () => {
    expect(noteSource(note("a", { sourceLineId: "b1", sourceCardMessageId: "c1", sourceMessageId: "m1" }))).toEqual({ kind: "card", lineId: "b1", messageId: "c1" });
    expect(noteSource(note("a", { sourceLineId: "l1", sourceMessageId: "m1" }))).toEqual({ kind: "message", lineId: "l1", messageId: "m1" });
    expect(noteSource(note("a", { sourceLineId: "l1" }))).toEqual({ kind: "line", lineId: "l1" });
    expect(noteSource(note("a"))).toBeNull();
  });
});

describe("replacementSection (R5)", () => {
  it("turns a to-confirm note into a confirmed fact and keeps every other section", () => {
    expect(replacementSection("to_confirm")).toBe("fact");
    expect(replacementSection("decided")).toBe("decided");
    expect(replacementSection("fact")).toBe("fact");
    expect(replacementSection("todo")).toBe("todo");
  });
});
