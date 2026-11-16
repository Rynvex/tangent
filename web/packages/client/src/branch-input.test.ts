// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  withSuggestion,
  BRANCH_EXCERPT_MAX,
  BRANCH_PURPOSE_MAX,
  buildCreateInput,
  countLaterMessages,
  prefillPurpose,
  prepareExcerpt,
  hasSelectedText,
  resolveMessageSelection,
  validatePurpose,
  type SelectionLike,
} from "./branch-input";
import { message } from "./test-helpers";

describe("branch purpose", () => {
  it("requires text and caps at 200 characters", () => {
    expect(validatePurpose("   ")).toBe("required");
    expect(validatePurpose("a".repeat(BRANCH_PURPOSE_MAX))).toBeNull();
    expect(validatePurpose("a".repeat(BRANCH_PURPOSE_MAX + 1))).toBe("tooLong");
    expect(validatePurpose("字".repeat(BRANCH_PURPOSE_MAX))).toBeNull();
  });

  it("prefills the first characters of a selection on one line", () => {
    expect(prefillPurpose("line one\n\nline   two")).toBe("line one line two");
    expect(Array.from(prefillPurpose("x".repeat(100))).length).toBe(40);
  });
});

describe("branch excerpt", () => {
  it("truncates a long selection and says so", () => {
    const long = prepareExcerpt("y".repeat(BRANCH_EXCERPT_MAX + 10));
    expect(Array.from(long.text).length).toBe(BRANCH_EXCERPT_MAX);
    expect(long.truncated).toBe(true);
    expect(prepareExcerpt("  short ")).toEqual({ text: "short", truncated: false });
  });
});

describe("buildCreateInput", () => {
  const form = { purpose: " check it ", kind: "investigate" as const, anchorMessageId: "m1", excerpt: "", provider: "p1", mainProvider: "p1", model: "" };

  it("omits an unchanged provider, an empty model and an empty excerpt", () => {
    expect(buildCreateInput(form)).toEqual({ purpose: "check it", kind: "investigate", anchorMessageId: "m1" });
  });

  it("sends a changed provider, a model and the excerpt", () => {
    expect(buildCreateInput({ ...form, provider: "p2", model: " haiku ", excerpt: "quote" })).toEqual({
      purpose: "check it",
      kind: "investigate",
      anchorMessageId: "m1",
      excerpt: "quote",
      provider: "p2",
      model: "haiku",
    });
  });

  it("asks for the later developments only when ticked", () => {
    expect(buildCreateInput({ ...form, includeLater: true }).includeLater).toBe(true);
    expect("includeLater" in buildCreateInput({ ...form, includeLater: false })).toBe(false);
  });
});

describe("resolveMessageSelection", () => {
  function thread(): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = '<div data-message-id="m1"><p data-n="a">first message</p></div><div data-message-id="m2"><p data-n="b">second</p></div>';
    return root;
  }
  const selection = (anchor: Node | null, focus: Node | null, text: string, collapsed = false): SelectionLike => ({
    isCollapsed: collapsed,
    anchorNode: anchor,
    focusNode: focus,
    toString: () => text,
  });

  it("returns the message and text for a selection inside one message", () => {
    const root = thread();
    const a = root.querySelector("[data-n=a]")!.firstChild;
    expect(resolveMessageSelection(selection(a, a, " first "), root)).toEqual({ messageId: "m1", text: "first", forkable: true });
  });

  it("ignores a selection that spans messages, is collapsed, or sits outside the thread", () => {
    const root = thread();
    const a = root.querySelector("[data-n=a]")!.firstChild;
    const b = root.querySelector("[data-n=b]")!.firstChild;
    expect(resolveMessageSelection(selection(a, b, "x"), root)).toBeNull();
    expect(resolveMessageSelection(selection(a, a, "", true), root)).toBeNull();
    expect(resolveMessageSelection(selection(a, a, "x"), document.createElement("div"))).toBeNull();
    expect(resolveMessageSelection(null, root)).toBeNull();
  });
});

describe("countLaterMessages", () => {
  it("counts finished user and assistant messages after the anchor", () => {
    const messages = [
      message("a", "user", { seq: 1 }),
      message("b", "assistant", { seq: 2 }),
      message("c", "user", { seq: 3 }),
      message("d", "system", { seq: 4 }),
      message("e", "assistant", { seq: 5, status: "error" }),
    ];
    expect(countLaterMessages(messages, "b")).toBe(1);
    expect(countLaterMessages(messages, "e")).toBe(0);
    expect(countLaterMessages(messages, "missing")).toBe(0);
  });

  it("orders by seq, not by the order received", () => {
    const messages = [message("c", "user", { seq: 3 }), message("a", "user", { seq: 1 }), message("b", "assistant", { seq: 2 })];
    expect(countLaterMessages(messages, "a")).toBe(2);
  });
});

describe("limits as parameters (review M7)", () => {
  it("validates and cuts with a host's own limits", () => {
    expect(validatePurpose("abcd", 3)).toBe("tooLong");
    expect(validatePurpose("abc", 3)).toBeNull();
    expect(prepareExcerpt("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
  });
});

describe("withSuggestion", () => {
  const input = { purpose: "Rail passes", kind: "investigate" as const, anchorMessageId: "a1" };
  const suggestion = { messageId: "a1", purpose: "Rail passes", kind: "investigate" as const };

  it("names the suggestion only when the user accepted it unchanged", () => {
    expect(withSuggestion(input, suggestion)).toEqual({ ...input, suggestionMessageId: "a1" });
    expect(withSuggestion({ ...input, purpose: "Rail passes for Kansai" }, suggestion)).toEqual({ ...input, purpose: "Rail passes for Kansai" });
    expect(withSuggestion({ ...input, kind: "aside" }, suggestion)).toEqual({ ...input, kind: "aside" });
    expect(withSuggestion(input, null)).toEqual(input);
  });
});

describe("resolveMessageSelection: cards and move markers (R2, R5)", () => {
  it("returns a selection inside a conclusion card or a move marker, marked as not forkable", () => {
    document.body.innerHTML = '<ol id="list"><li data-message-id="c1" data-forkable="false"><p id="card">Card text</p></li><li data-message-id="m1" data-forkable="true"><p id="chat">Chat text</p></li></ol>';
    const list = document.getElementById("list");
    const text = (id: string) => document.getElementById(id)!.firstChild!;
    const selection = (node: Node) => ({ isCollapsed: false, anchorNode: node, focusNode: node, toString: () => "text" });
    expect(resolveMessageSelection(selection(text("card")), list)).toEqual({ messageId: "c1", text: "text", forkable: false });
    expect(resolveMessageSelection(selection(text("chat")), list)).toEqual({ messageId: "m1", text: "text", forkable: true });
  });
});

describe("hasSelectedText (R5)", () => {
  const selection = (text: string, collapsed = false): SelectionLike => ({ isCollapsed: collapsed, anchorNode: null, focusNode: null, toString: () => text });

  it("is true for any non-empty selection, wherever it is", () => {
    expect(hasSelectedText(selection(" across two messages "))).toBe(true);
  });

  it("is false for no selection, a caret, or only white space", () => {
    expect(hasSelectedText(null)).toBe(false);
    expect(hasSelectedText(selection("", true))).toBe(false);
    expect(hasSelectedText(selection("  \n "))).toBe(false);
  });
});
