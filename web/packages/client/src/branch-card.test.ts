import { describe, expect, it } from "vitest";
import {
  buildMergeBody,
  cardReducer,
  cardUsage,
  checkExcerptSelection,
  emptyCard,
  validateCard,
  CARD_DECISIONS_MAX,
  CARD_EVIDENCE_MAX,
  CARD_FIELD_MAX,
} from "./branch-card";
import { cleanCardText } from "./card-text";
import { message } from "./test-helpers";
import type { MessageRole } from "./types";

const msg = (id: string, content: string, role: MessageRole = "assistant") => message(id, role, { content });

describe("cardReducer", () => {
  it("adds, edits and removes list items without mutating the old card", () => {
    const start = emptyCard();
    const added = cardReducer(start, { type: "addOpenItem" });
    const edited = cardReducer(added, { type: "setOpenItem", index: 0, value: "who owns it?" });
    const removed = cardReducer(edited, { type: "removeOpenItem", index: 0 });
    expect(start.openItems).toEqual([]);
    expect(edited.openItems).toEqual(["who owns it?"]);
    expect(removed.openItems).toEqual([]);
  });

  it("caps evidence and decisions at the server limits", () => {
    let card = emptyCard();
    for (let i = 0; i < CARD_EVIDENCE_MAX + 3; i += 1) card = cardReducer(card, { type: "addEvidence" });
    for (let i = 0; i < CARD_DECISIONS_MAX + 3; i += 1) card = cardReducer(card, { type: "addDecision" });
    expect(card.evidence).toHaveLength(CARD_EVIDENCE_MAX);
    expect(card.needsDecision).toHaveLength(CARD_DECISIONS_MAX);
  });

  it("sums every text for the total usage", () => {
    let card = cardReducer(emptyCard(), { type: "setText", field: "question", value: "abc" });
    card = cardReducer(card, { type: "addDecision" });
    card = cardReducer(card, { type: "setDecision", index: 0, patch: { branchClaim: "xy", mainLineClaim: "z" } });
    expect(cardUsage(card)).toBe(6);
  });
});

describe("validateCard", () => {
  it("points at empty required fields, long fields and the total", () => {
    const long = "x".repeat(CARD_FIELD_MAX + 1);
    let card = cardReducer(emptyCard(), { type: "setText", field: "impact", value: long });
    card = cardReducer(card, { type: "addOpenItem" });
    card = cardReducer(card, { type: "addDecision" });
    const fields = validateCard(card).map((item) => `${item.field}:${item.code}`);
    expect(fields).toEqual(
      expect.arrayContaining(["question:required", "conclusion:required", "impact:tooLong", "openItems[0]:required", "needsDecision[0]:claim"]),
    );
    const big = { ...emptyCard(), question: "q", conclusion: "c", openItems: Array.from({ length: 7 }, () => "y".repeat(1900)) };
    expect(validateCard(big).some((item) => item.code === "total" && item.field === "card")).toBe(true);
  });
});

describe("buildMergeBody", () => {
  const card = {
    ...emptyCard(),
    question: " q ",
    conclusion: "c",
    evidence: [{ messageId: "m1", note: "" }, { messageId: "", note: "dropped" }],
    openItems: ["", "left"],
    needsDecision: [{ branchClaim: "a", mainLineClaim: "", mainLineMessageId: "" }, { branchClaim: "", mainLineClaim: "" }],
    excerpts: [{ messageId: "m1", text: "line one\n  line two" }],
  };

  it("sends the tip seen at open and leaves out empty fields", () => {
    const body = buildMergeBody(card, "tip-at-open");
    expect(body).toEqual({
      card: {
        question: "q",
        conclusion: "c",
        evidence: [{ messageId: "m1", note: "" }],
        openItems: ["left"],
        needsDecision: [{ branchClaim: "a", mainLineClaim: "" }],
        excerpts: [{ messageId: "m1", text: "line one\n  line two" }],
      },
      parentTipMessageId: "tip-at-open",
    });
    expect("confirmParentMoved" in body).toBe(false);
    expect("impact" in body.card).toBe(false);
  });

  it("adds confirmParentMoved only when confirmed and carries note changes", () => {
    expect(buildMergeBody(card, "t", true).confirmParentMoved).toBe(true);
    const withNotes = buildMergeBody(card, "t", false, [{ op: "add", section: "fact", text: "x" }]);
    expect(withNotes.noteChanges).toEqual([{ op: "add", section: "fact", text: "x" }]);
    expect("noteChanges" in buildMergeBody(card, "t", false, [])).toBe(false);
  });
});

describe("checkExcerptSelection", () => {
  const messages = [msg("a", "first line\nsecond line"), msg("b", "windows\r\nline"), msg("s", "sys", "system")];

  it("accepts a multi-line verbatim selection and keeps its newlines", () => {
    const result = checkExcerptSelection(emptyCard(), messages, { messageId: "a", text: "first line\nsecond" });
    expect(result).toEqual({ ok: true, excerpt: { messageId: "a", text: "first line\nsecond" } });
  });

  it("treats CRLF in the message as LF", () => {
    expect(checkExcerptSelection(emptyCard(), messages, { messageId: "b", text: "windows\nline" }).ok).toBe(true);
  });

  it("rejects text that is not in the message, system messages and unknown ids", () => {
    expect(checkExcerptSelection(emptyCard(), messages, { messageId: "a", text: "first  line" })).toEqual({ ok: false, reason: "notVerbatim" });
    expect(checkExcerptSelection(emptyCard(), messages, { messageId: "s", text: "sys" })).toEqual({ ok: false, reason: "unknownMessage" });
    expect(checkExcerptSelection(emptyCard(), messages, { messageId: "zz", text: "x" })).toEqual({ ok: false, reason: "unknownMessage" });
  });

  it("rejects over-long text, a fourth excerpt and duplicates", () => {
    const longMessage = [msg("l", "y".repeat(1600))];
    expect(checkExcerptSelection(emptyCard(), longMessage, { messageId: "l", text: "y".repeat(1501) })).toEqual({ ok: false, reason: "tooLong" });
    let card = emptyCard();
    for (const text of ["first", "second", "line"]) {
      const checked = checkExcerptSelection(card, messages, { messageId: "a", text });
      if (checked.ok) card = cardReducer(card, { type: "addExcerpt", excerpt: checked.excerpt });
    }
    expect(card.excerpts).toHaveLength(3);
    expect(checkExcerptSelection(card, messages, { messageId: "a", text: "line one" })).toEqual({ ok: false, reason: "limit" });
    const two = cardReducer(emptyCard(), { type: "addExcerpt", excerpt: { messageId: "a", text: "first" } });
    expect(checkExcerptSelection(two, messages, { messageId: "a", text: "first" })).toEqual({ ok: false, reason: "duplicate" });
  });
});

describe("cleanCardText (mirror of domain.CleanCardText)", () => {
  it("strips protocol markers repeatedly, defuses fences, normalises breaks and controls, trims", () => {
    expect(cleanCardText("  plain text  ")).toBe("plain text");
    expect(cleanCardText("[BRANCH-CARD]x[/BRANCH-CARD]")).toBe("x");
    expect(cleanCardText("[BRANCH-[SESSION-SUMMARY]CARD]y")).toBe("y");
    expect(cleanCardText("```sh\nls\n```")).toBe("'''sh\nls\n'''");
    expect(cleanCardText("a\rb\u2028c\u0085d")).toBe("a\nb\nc\nd");
    expect(cleanCardText("a\u202Eb\u2066c")).toBe("abc");
    expect(cleanCardText("a\u0007b\tc")).toBe("a b\tc");
  });
});

describe("checkExcerptSelection: what the server would clean is refused (R2)", () => {
  const card = emptyCard();
  const messages = [msg("m", "Run:\n```sh\nzpool status\n```\n[BRANCH-SUGGEST] x\nbell\u0007here")];

  it("refuses a code fence, a protocol marker or a control character with its own reason", () => {
    expect(checkExcerptSelection(card, messages, { messageId: "m", text: "```sh\nzpool status" })).toEqual({ ok: false, reason: "unclean" });
    expect(checkExcerptSelection(card, messages, { messageId: "m", text: "[BRANCH-SUGGEST] x" })).toEqual({ ok: false, reason: "unclean" });
    expect(checkExcerptSelection(card, messages, { messageId: "m", text: "bell\u0007here" })).toEqual({ ok: false, reason: "unclean" });
  });

  it("still accepts the clean part inside the fence", () => {
    expect(checkExcerptSelection(card, messages, { messageId: "m", text: "zpool status" })).toEqual({ ok: true, excerpt: { messageId: "m", text: "zpool status" } });
  });
});
