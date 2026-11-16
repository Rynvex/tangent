import { describe, expect, it } from "vitest";
import type { Capabilities } from "./capabilities";
import { TangentError } from "./errors";
import { fixture } from "./testing/scenario";
import {
  discardLeafBody,
  hasInbox,
  inboxCount,
  leafLine,
  leafPresentation,
  leafProblems,
  seedFromText,
  seedLimitState,
  seedOrigin,
  suggestionReason,
  validateLeafLine,
} from "./p1";

const caps = (names: string[]): Capabilities => ({ features: names.map((name) => ({ name, enabled: true })) as Capabilities["features"] });

describe("leaf text", () => {
  it("flattens a reason to one line", () => {
    expect(leafLine("  Too   expensive\nfor this trip ")).toBe("Too expensive for this trip");
  });

  it("checks the line: required, at most 200 characters", () => {
    expect(validateLeafLine("   ")).toBe("empty");
    expect(validateLeafLine("字".repeat(200))).toBeNull();
    expect(validateLeafLine("字".repeat(201))).toBe("tooLong");
  });

  it("sends a discard reason as the dead-end leaf, nothing when blank", () => {
    expect(discardLeafBody("")).toBeUndefined();
    expect(discardLeafBody("  \n ")).toBeUndefined();
    expect(discardLeafBody("Too\nexpensive")).toEqual({ leaf: { line: "Too expensive" } });
  });

  it("presents an AI draft, an AI-made confirmed leaf (auto) and the user's own", () => {
    expect(leafPresentation({ status: "draft" })).toBe("draft");
    expect(leafPresentation({ status: "confirmed", aiDrafted: true })).toBe("ai");
    expect(leafPresentation({ status: "confirmed", aiDrafted: false })).toBe("confirmed");
    expect(leafPresentation({ status: "confirmed" })).toBe("confirmed");
  });

  it("reads invalid_leaf problems per field", () => {
    const error = new TangentError(422, "x", "invalid_leaf", { problems: [{ field: "line", message: "is longer than 200 characters" }, { field: "kind", message: "bad" }, { field: "other", message: "?" }] });
    expect(leafProblems(error)).toEqual({ line: "is longer than 200 characters", kind: "bad" });
    expect(leafProblems(new TangentError(409, "x", "archived"))).toEqual({});
  });
});

describe("seeds", () => {
  it("starts a seed from a message: one line, at most 120 characters", () => {
    expect(seedFromText("a\n\nb")).toBe("a b");
    expect(Array.from(seedFromText("字".repeat(300))).length).toBe(120);
  });

  it("knows when the parking lot is nearly or completely full", () => {
    expect(seedLimitState(10, 100)).toBe("ok");
    expect(seedLimitState(90, 100)).toBe("near");
    expect(seedLimitState(100, 100)).toBe("full");
  });

  it("finds where a seed came from among the loaded lines", () => {
    const main = [
      fixture.message({ id: "u1", lineId: "root", seq: 1, role: "user" }),
      fixture.message({ id: "a1", lineId: "root", seq: 2, role: "assistant" }),
    ];
    const branch = [fixture.message({ id: "b1", lineId: "br", seq: 5, role: "user" })];
    const lines = [
      { lineId: "root", messages: main },
      { lineId: "br", messages: branch },
    ];
    expect(seedOrigin({ anchorMessageId: "a1" }, "root", lines)).toEqual({ kind: "main", lineId: "root", messageId: "a1", n: 2 });
    expect(seedOrigin({ anchorMessageId: "b1" }, "root", lines)).toEqual({ kind: "branch", lineId: "br", messageId: "b1", n: 1 });
    expect(seedOrigin({ anchorMessageId: "zz" }, "root", lines)).toEqual({ kind: "unknown", lineId: null, messageId: "zz" });
    expect(seedOrigin({ anchorMessageId: "" }, "root", lines)).toEqual({ kind: "none", lineId: null, messageId: "" });
  });
});

describe("the 待處理 tab", () => {
  it("exists with parking, the suggestion inbox or open loops", () => {
    expect(hasInbox(caps(["notes"]))).toBe(false);
    expect(hasInbox(caps(["parking"]))).toBe(true);
    expect(hasInbox(caps(["suggestions"]))).toBe(true);
    expect(hasInbox(caps(["open_loops"]))).toBe(true);
    expect(hasInbox(null)).toBe(false);
  });

  it("counts the open seeds and suggestions of the features that are on", () => {
    const line = fixture.line({ id: "root", openSeeds: 3, openSuggestions: 2 });
    expect(inboxCount(caps(["parking", "suggestions"]), line)).toBe(5);
    expect(inboxCount(caps(["parking"]), line)).toBe(3);
    expect(inboxCount(caps(["suggestions"]), line)).toBe(2);
    expect(inboxCount(caps(["parking"]), null)).toBe(0);
  });
});

describe("suggestions", () => {
  it("reads the reason a feature put in the payload", () => {
    expect(suggestionReason({ payload: { reason: "the reply asked" } })).toBe("the reply asked");
    expect(suggestionReason({ payload: { reason: 3 } })).toBe("");
    expect(suggestionReason({ payload: {} })).toBe("");
  });
});
