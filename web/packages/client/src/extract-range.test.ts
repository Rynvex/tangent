import { describe, expect, it } from "vitest";
import { normalizeBranchView } from "./branch-normalize";
import { defaultExtractEnd, extractAnchor, extractEndChoices, extractStart, protectedAnchors } from "./extract-range";
import { normalizeMessage } from "./line-normalize";
import type { Message } from "./types";

const msg = (id: string, seq: number, role: string, extra: Record<string, unknown> = {}): Message => normalizeMessage({ id, seq, lineId: "L", role, kind: "chat", status: "done", content: id, ...extra });

/** q1 a1 q2 a2 q3 a3 card q4 a4 */
const line = [
  msg("q1", 1, "user"),
  msg("a1", 2, "assistant"),
  msg("q2", 3, "user"),
  msg("a2", 4, "assistant"),
  msg("q3", 5, "user"),
  msg("a3", 6, "assistant"),
  msg("card", 7, "system", { kind: "branch_card" }),
  msg("q4", 8, "user"),
  msg("a4", 9, "assistant"),
];

describe("extractStart", () => {
  it("starts at a user message with something before it", () => {
    expect(extractStart(line, "q2")).toEqual({ startId: "q2", aligned: false, problem: null });
  });

  it("moves a reply's start up to its turn's question", () => {
    expect(extractStart(line, "a2")).toEqual({ startId: "q2", aligned: true, problem: null });
  });

  it("refuses the first turn (nothing to hang the branch on), from its question or its reply", () => {
    expect(extractStart(line, "q1").problem).toBe("noAnchor");
    expect(extractStart(line, "a1")).toEqual({ startId: "q1", aligned: true, problem: "noAnchor" });
  });

  it("refuses cards, failed replies and a start a merged branch hangs on", () => {
    expect(extractStart(line, "card").problem).toBe("notExtractable");
    expect(extractStart([...line, msg("bad", 10, "assistant", { status: "error" })], "bad").problem).toBe("notExtractable");
    const merged = normalizeBranchView({ lineId: "B", parentLineId: "L", anchorMessageId: "q2", status: "merged", cardMessageId: "card" });
    expect(extractStart(line, "q2", [merged]).problem).toBe("protected");
  });

  it("allows a card before the start as the anchor", () => {
    expect(extractStart(line, "q4")).toEqual({ startId: "q4", aligned: false, problem: null });
    expect(extractAnchor(line, "q4")?.id).toBe("card");
    expect(extractAnchor(line, "q2")?.id).toBe("a1");
    expect(extractAnchor(line, "q1")).toBeNull();
  });
});

describe("extractEndChoices", () => {
  it("runs to the next card", () => {
    expect(extractEndChoices(line, "q2").map((message) => message.id)).toEqual(["q2", "a2", "q3", "a3"]);
    expect(defaultExtractEnd(extractEndChoices(line, "q2"))?.id).toBe("a3");
  });

  it("stops before a chapter cut, a marker, a failed or pending reply and a protected anchor", () => {
    expect(extractEndChoices(line, "q2", [], new Set(["q3"])).map((message) => message.id)).toEqual(["q2", "a2"]);
    const withMarker = [...line.slice(0, 4), msg("mark", 5, "system", { kind: "branch_marker" }), ...line.slice(4)];
    expect(extractEndChoices(withMarker, "q2").map((message) => message.id)).toEqual(["q2", "a2"]);
    const pending = [...line.slice(0, 4), msg("p", 5, "assistant", { status: "pending" })];
    expect(extractEndChoices(pending, "q2").map((message) => message.id)).toEqual(["q2", "a2"]);
    const merged = normalizeBranchView({ lineId: "B", parentLineId: "L", anchorMessageId: "a2", status: "merged", cardMessageId: "card" });
    expect(protectedAnchors(line, [merged])).toEqual(new Set(["a2"]));
    expect(extractEndChoices(line, "q2", [merged]).map((message) => message.id)).toEqual(["q2"]);
    expect(defaultExtractEnd(extractEndChoices(line, "q2", [merged]))?.id).toBe("q2");
  });

  it("caps the range at the server's 40 messages", () => {
    const long = Array.from({ length: 60 }, (_, index) => msg(`m${index}`, index + 1, index % 2 === 0 ? "user" : "assistant"));
    expect(extractEndChoices(long, "m2")).toHaveLength(40);
    expect(extractEndChoices(long, "nope")).toEqual([]);
  });
});

describe("firstSentence", () => {
  it("stops at the first full stop or line break and cuts long text", async () => {
    const { firstSentence } = await import("./extract-range");
    expect(firstSentence("改用 host.docker.internal 就能解決。另外放行網段。")).toBe("改用 host.docker.internal 就能解決。");
    expect(firstSentence("Use v1.2 here. Then more.")).toBe("Use v1.2 here.");
    expect(firstSentence("line one\nline two")).toBe("line one");
    expect(firstSentence("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
