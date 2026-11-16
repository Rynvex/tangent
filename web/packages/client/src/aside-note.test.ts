import { describe, expect, it } from "vitest";
import { NOTE_TEXT_MAX, asideAnswer, noteDraft, validateNote } from "./aside-note";
import { message } from "./test-helpers";

describe("aside note", () => {
  it("answers with the last finished assistant message by seq", () => {
    const list = [
      message("3", "assistant", { seq: 3, content: "the answer" }),
      message("1", "user", { seq: 1, content: "q" }),
      message("2", "assistant", { seq: 2, status: "error", content: "x" }),
    ];
    expect(asideAnswer(list)?.id).toBe("3");
    expect(asideAnswer([message("1", "user", { content: "q" })])).toBeNull();
    expect(asideAnswer(undefined)).toBeNull();
  });
  it("drafts one line cut to the limit", () => {
    expect(noteDraft("a\n\nb")).toBe("a b");
    expect(Array.from(noteDraft("字".repeat(NOTE_TEXT_MAX + 50))).length).toBe(NOTE_TEXT_MAX);
  });
  it("validates length", () => {
    expect(validateNote("  ")).toBe("empty");
    expect(validateNote("字".repeat(NOTE_TEXT_MAX + 1))).toBe("tooLong");
    expect(validateNote("ok")).toBeNull();
  });
});

describe("note length as a parameter (review M7)", () => {
  it("uses the server's maxRunes", () => {
    expect(noteDraft("abcdef", 3)).toBe("abc");
    expect(validateNote("abcd", 3)).toBe("tooLong");
    expect(validateNote("abc", 3)).toBeNull();
  });
});
