import { describe, expect, it } from "vitest";
import { estimateTokens } from "../branch-pack-estimate";
import { notesLeftOut } from "../notes-page";
import type { Note } from "../types";
import { buildMockNotesBlock } from "./mock-notes-block";

const note = (id: string, section: Note["section"], createdAt: string, over: Partial<Note> = {}): Note => ({
  id, section, text: `note ${id} `.repeat(20).trim(), status: "active", sourceLineId: "", sourceMessageId: "", sourceCardMessageId: "",
  supersededBy: "", createdBy: "u", createdAt, updatedAt: createdAt, ...over,
});

describe("buildMockNotesBlock (domain.BuildNotesBlock)", () => {
  const notes = [
    note("d1", "decided", "2026-01-01T00:00:01Z"),
    note("f1", "fact", "2026-01-01T00:00:02Z"),
    note("c1", "to_confirm", "2026-01-01T00:00:03Z"),
    note("c2", "to_confirm", "2026-01-01T00:00:04Z"),
    note("t1", "todo", "2026-01-01T00:00:05Z"),
    note("x", "todo", "2026-01-01T00:00:06Z", { status: "done" }),
  ];

  it("lists active notes newest first under the four headings", () => {
    const block = buildMockNotesBlock(notes, 10_000);
    expect(block).toContain("### Decided\n- note d1");
    expect(block.indexOf("note c2")).toBeLessThan(block.indexOf("note c1"));
    expect(block).not.toContain("note x");
    expect(block).not.toContain("left out");
  });

  it("over budget drops the oldest 'to confirm' first, then 'to do', then facts, never decided", () => {
    const tight = buildMockNotesBlock(notes, estimateTokens(buildMockNotesBlock(notes, 10_000)) - 1);
    expect([...notesLeftOut(notes, tight)]).toEqual(["c1"]);
    expect(tight).toContain("(1 older note(s) left out");
    const tiny = buildMockNotesBlock(notes, 1);
    expect([...notesLeftOut(notes, tiny)].sort()).toEqual(["c1", "c2", "f1", "t1"]);
    expect(tiny).toContain("- note d1");
  });

  it("is empty when nothing is active", () => {
    expect(buildMockNotesBlock([note("x", "todo", "2026-01-01T00:00:00Z", { status: "done" })], 100)).toBe("");
  });
});
