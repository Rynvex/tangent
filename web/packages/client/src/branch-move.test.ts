import { describe, expect, it } from "vitest";
import { BRANCH_MOVE_MAX, buildMoveInput, planMove, previewLine } from "./branch-move";
import { message } from "./test-helpers";
import type { MessageKind, MessageRole, MessageStatus } from "./types";

let nextSeq = 0;
function msg(id: string, role: MessageRole, over: { status?: MessageStatus; kind?: MessageKind; content?: string } = {}) {
  nextSeq += 1;
  return message(id, role, { ...over, seq: nextSeq });
}

const base = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant")];

describe("planMove", () => {
  it("takes the tail from the chosen user message", () => {
    const plan = planMove(base, "u2");
    expect(plan.problem).toBeNull();
    expect(plan.messages.map((m) => m.id)).toEqual(["u2", "a2"]);
  });

  it("orders by seq whatever order the messages arrive in", () => {
    const plan = planMove([...base].reverse(), "u2");
    expect(plan.messages.map((m) => m.id)).toEqual(["u2", "a2"]);
    expect(plan.problem).toBeNull();
  });

  it("refuses a start that is not a user message", () => {
    expect(planMove(base, "a1").problem).toBe("mustStartWithUser");
  });

  it("refuses when nothing would be left to fork from", () => {
    expect(planMove(base, "u1").problem).toBe("noAnchor");
  });

  it("refuses more than the cap", () => {
    const many = [msg("first", "assistant"), ...Array.from({ length: BRANCH_MOVE_MAX + 1 }, (_, i) => msg(`m${i}`, i % 2 === 0 ? "user" : "assistant"))];
    expect(planMove(many, "m0").problem).toBe("tooMany");
  });

  it.each(["branch_card", "branch_marker"] as const)("refuses a range that contains a %s", (kind) => {
    const list = [...base, msg("x", "system", { kind })];
    expect(planMove(list, "u2").problem).toBe("protectedMessage");
  });

  it("refuses a range with an unfinished message at the end", () => {
    const list = [...base, msg("a3", "assistant", { status: "pending" })];
    expect(planMove(list, "u2").problem).toBe("notDone");
  });

  it("reports an unknown message", () => {
    expect(planMove(base, "nope").problem).toBe("notFound");
  });
});

describe("move request", () => {
  it("sends count and kind, and the provider only when it differs", () => {
    const body = buildMoveInput({ purpose: " why ", count: 2, kind: "investigate", provider: "b", mainProvider: "a", model: " " });
    expect(body).toEqual({ purpose: "why", count: 2, kind: "investigate", provider: "b" });
    expect(buildMoveInput({ purpose: "p", count: 1, kind: "alternative", provider: "a", mainProvider: "a", model: "m" })).toEqual({
      purpose: "p",
      count: 1,
      kind: "alternative",
      model: "m",
    });
  });

  it("previews a message on one line, cut short", () => {
    expect(previewLine(msg("x", "user", { content: "a\n\nb" }))).toBe("a b");
    expect(Array.from(previewLine(msg("x", "user", { content: "z".repeat(200) }))).length).toBe(81);
  });
});

describe("move cap as a parameter (review M7)", () => {
  it("uses the host's MoveMaxMessages", () => {
    const list = [msg("k", "user"), msg("s1", "user"), msg("s2", "assistant"), msg("s3", "user")];
    expect(planMove(list, "s1", 2).problem).toBe("tooMany");
    expect(planMove(list, "s1", 3).problem).toBeNull();
  });
});
