import { normalizeBranchView, type PreviewBlock } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { forkSummary, forksByAnchor, formatUsd, groupPreviewBlocks, isOverThreshold } from "./models";

const zh = createTranslator("zh-TW");
const branch = (lineId: string, over: Record<string, unknown>) => normalizeBranchView({ lineId, parentLineId: "main", anchorMessageId: "m1", ...over });

describe("fork markers", () => {
  it("groups the direct branches of a line by their anchor message", () => {
    const groups = forksByAnchor([branch("b1", {}), branch("b2", { anchorMessageId: "m2" }), branch("b3", {}), branch("x", { parentLineId: "other" })], "main");
    expect([...groups.keys()]).toEqual(["m1", "m2"]);
    expect(groups.get("m1")!.map((b) => b.lineId)).toEqual(["b1", "b3"]);
  });

  it("B9.1: a child moved onto a combined branch forks from a message of the old branch: it is drawn at the line's first message", () => {
    const groups = forksByAnchor([branch("moved", { anchorMessageId: "old-m3" }), branch("b2", { anchorMessageId: "m2" })], "main", ["m1", "m2"]);
    expect(groups.get("m1")!.map((b) => b.lineId)).toEqual(["moved"]);
    expect(groups.has("old-m3")).toBe(false);
  });

  it("summarizes count, status counts in a fixed order and unread replies", () => {
    const summary = forkSummary([branch("a", { status: "merged" }), branch("b", { status: "open", unread: 2 }), branch("c", { status: "open" })], zh);
    expect(summary.count).toBe(3);
    expect(summary.text).toBe("2 條進行中・1 條已帶回・2 則未讀");
    expect(summary.statuses).toEqual(["merged", "open", "open"]);
    expect(summary.unread).toBe(2);
  });
});

describe("send preview", () => {
  const block = (key: string, tokens: number, role?: PreviewBlock["role"]): PreviewBlock => ({ key, tokens, content: key, ...(role ? { role } : {}) });

  it("merges consecutive blocks of the same key and labels them", () => {
    const rows = groupPreviewBlocks([block("rules", 100), block("notes", 20), block("history", 5, "user"), block("history", 7, "assistant"), block("user_message", 3, "user"), block("plan", 9)], zh);
    expect(rows.map((row) => [row.label, row.tokens])).toEqual([
      ["規則", 100],
      ["紀要", 20],
      ["最近訊息（2 則）", 12],
      ["你的訊息", 3],
      ["宿主區塊「plan」", 9],
    ]);
  });

  it("names the tree's goal block (B9), placed right after the rules", () => {
    expect(groupPreviewBlocks([block("rules", 100), block("goal", 12)], zh).map((row) => row.label)).toEqual(["規則", "目標"]);
    // B16: the first-turn topic / chapter instructions have their own name.
    expect(groupPreviewBlocks([block("reply_lines", 30)], zh).map((row) => row.label)).toEqual(["回覆附註（主題、章節）"]);
  });

  it("formats dollars with enough precision for small amounts", () => {
    expect(formatUsd(0.000169)).toBe("0.0002");
    expect(formatUsd(0.0049)).toBe("0.0049");
    expect(formatUsd(0.05)).toBe("0.05");
    expect(formatUsd(1.234)).toBe("1.23");
  });

  it("compares an estimate with the threshold only when the server priced it", () => {
    expect(isOverThreshold(0.06, 0.05)).toBe(true);
    expect(isOverThreshold(0.05, 0.05)).toBe(false);
    expect(isOverThreshold(undefined, 0.05)).toBe(false);
  });
});
