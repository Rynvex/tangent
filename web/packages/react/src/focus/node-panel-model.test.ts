import { normalizeBranchView, type Message } from "@tangent/client";
import { fixture } from "@tangent/client/testing";
import { describe, expect, it } from "vitest";
import { continuePlace, forkPlace, lastForkableId, PANEL_PURPOSE_MAX, prependToDraft, purposeFromNote } from "./node-panel-model";

const branch = (id: string, parent: string, extra: Record<string, unknown> = {}) =>
  normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", anchorMessageId: `${parent}-m2`, purpose: id, status: "open", createdAt: "2026-01-01T00:00:00Z", ...extra });

describe("prependToDraft (帶進這一輪, §8.3)", () => {
  it("fills an empty draft with the note alone", () => {
    expect(prependToDraft("  ", "關於「A」的筆記：x")).toBe("關於「A」的筆記：x");
  });

  it("puts the note first and leaves a blank line before what was typed", () => {
    expect(prependToDraft("我想問", "關於「A」的筆記：x")).toBe("關於「A」的筆記：x\n\n我想問");
  });
});

describe("purposeFromNote", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(purposeFromNote("\n  第一行  \n第二行")).toBe("第一行");
  });

  it("cuts to the purpose limit by characters", () => {
    expect(Array.from(purposeFromNote("字".repeat(PANEL_PURPOSE_MAX + 20)))).toHaveLength(PANEL_PURPOSE_MAX);
  });
});

describe("forkPlace", () => {
  const numbers = new Map([["root-m2", 2], ["a-m2", 5]]);
  it("names the main line's message number for a top-level branch", () => {
    expect(forkPlace(branch("a", "root"), [], numbers)).toEqual({ kind: "main", n: 2 });
  });

  it("names the parent branch and its number for a nested branch", () => {
    const parent = branch("a", "root", { purpose: "父支線" });
    expect(forkPlace(branch("b", "a"), [parent], numbers)).toEqual({ kind: "parent", title: "父支線", n: 5 });
  });

  it("leaves the number out while the parent's messages load", () => {
    expect(forkPlace(branch("a", "root"), [], new Map())).toEqual({ kind: "main", n: null });
  });
});

describe("continuePlace (從這裡繼續談)", () => {
  it("forks from the open node's last message", () => {
    expect(continuePlace(branch("a", "root"), "a", "a-m9")).toEqual({ lineId: "a", anchorMessageId: "a-m9", fromParent: false });
  });

  it("forks an ended node's note where the node forked, on its parent", () => {
    expect(continuePlace(branch("a", "root", { status: "merged" }), "a", "a-m9")).toEqual({ lineId: "root", anchorMessageId: "root-m2", fromParent: true });
  });

  it("forks from the main line's last message", () => {
    expect(continuePlace(null, "root", "root-m40")).toEqual({ lineId: "root", anchorMessageId: "root-m40", fromParent: false });
  });

  it("has nowhere to fork on a line with no finished message", () => {
    expect(continuePlace(branch("a", "root"), "a", null)).toBeNull();
  });
});

describe("lastForkableId", () => {
  it("skips a pending reply and the system's messages", () => {
    const messages: Message[] = [
      fixture.message({ id: "m1", lineId: "a", seq: 1, role: "user", content: "q" }),
      fixture.message({ id: "m2", lineId: "a", seq: 2, role: "assistant", content: "a" }),
      fixture.message({ id: "m3", lineId: "a", seq: 3, role: "system", content: "notice" }),
      fixture.message({ id: "m4", lineId: "a", seq: 4, role: "assistant", content: "", status: "pending" }),
    ];
    expect(lastForkableId(messages)).toBe("m2");
  });
});
