import { describe, expect, it } from "vitest";
import { emptyCard } from "./branch-card";
import { CARD_PREFILL_CONCLUSION_MAX, cardHasAdvancedContent, prefillCard, prefillConclusion } from "./card-prefill";
import { message } from "./test-helpers";
import type { Message } from "./types";

const reply = (id: string, seq: number, content: string, over: Partial<Message> = {}): Message => ({ ...message(id, "assistant", { content, seq }), ...over });
const ask = (id: string, seq: number, content: string): Message => message(id, "user", { content, seq });

describe("prefillConclusion", () => {
  it("takes the last finished AI reply of the branch, by seq", () => {
    const messages = [reply("a2", 4, "later answer"), ask("u1", 1, "q"), reply("a1", 2, "first answer"), reply("a3", 6, "still running", { status: "pending" }), reply("a4", 7, "broke", { status: "error" })];
    expect(prefillConclusion(messages)).toBe("later answer");
  });

  it("prefers the latest pinned finished AI reply", () => {
    const messages = [reply("a1", 2, "pinned old", { pinned: true }), reply("a2", 4, "pinned newer", { pinned: true }), reply("a3", 6, "last reply"), { ...ask("u1", 8, "pinned question"), pinned: true }];
    expect(prefillConclusion(messages)).toBe("pinned newer");
  });

  it("skips system messages, cards and replies with nothing left after cleaning", () => {
    const messages = [reply("a1", 2, "  the answer \n"), reply("c1", 3, "a card", { role: "system", kind: "branch_card" }), reply("a2", 4, "[BRANCH-CARD][/BRANCH-CARD]   ")];
    expect(prefillConclusion(messages)).toBe("the answer");
  });

  it("is empty when the branch has no finished AI reply", () => {
    expect(prefillConclusion([])).toBe("");
    expect(prefillConclusion([ask("u1", 1, "only a question"), reply("a1", 2, "", { status: "pending" })])).toBe("");
  });

  it("cuts a long reply at the limit by characters, never inside a surrogate pair", () => {
    const long = "字".repeat(CARD_PREFILL_CONCLUSION_MAX - 1) + "😀😀😀";
    const text = prefillConclusion([reply("a1", 2, long)]);
    expect(Array.from(text)).toHaveLength(CARD_PREFILL_CONCLUSION_MAX);
    expect(text.endsWith("😀")).toBe(true);
    expect(CARD_PREFILL_CONCLUSION_MAX).toBeLessThanOrEqual(2000);
  });
});

describe("prefillCard", () => {
  it("fills the question from the purpose and the conclusion from the branch, nothing else", () => {
    const card = prefillCard("  Which disks?  ", [ask("u1", 1, "q"), reply("a1", 2, "Two 8TB disks.")]);
    expect(card).toEqual({ ...emptyCard(), question: "Which disks?", conclusion: "Two 8TB disks." });
    expect(cardHasAdvancedContent(card)).toBe(false);
  });
});

describe("cardHasAdvancedContent", () => {
  it("is true once any field besides question and conclusion has content", () => {
    expect(cardHasAdvancedContent({ ...emptyCard(), impact: "  " })).toBe(false);
    expect(cardHasAdvancedContent({ ...emptyCard(), impact: "costs less" })).toBe(true);
    expect(cardHasAdvancedContent({ ...emptyCard(), openItems: [""] })).toBe(true);
    expect(cardHasAdvancedContent({ ...emptyCard(), evidence: [{ messageId: "a1", note: "" }] })).toBe(true);
    expect(cardHasAdvancedContent({ ...emptyCard(), excerpts: [{ messageId: "a1", text: "x" }] })).toBe(true);
    expect(cardHasAdvancedContent({ ...emptyCard(), needsDecision: [{ branchClaim: "a", mainLineClaim: "" }] })).toBe(true);
  });
});
