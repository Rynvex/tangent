import { describe, expect, it } from "vitest";
import { estimatePack, estimateTokens } from "./branch-pack-estimate";
import { message } from "./test-helpers";

describe("estimateTokens", () => {
  it("counts a CJK character as about one token and other text as about four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("硬碟")).toBe(2);
    expect(estimateTokens("ZFS 硬碟")).toBe(3);
  });
});

describe("estimatePack", () => {
  const messages = Array.from({ length: 12 }, (_, i) => message(`m${i + 1}`, i % 2 ? "assistant" : "user", { seq: i + 1, content: "abcdefgh" }));

  it("quotes the last messages up to the fork point and adds the purpose and excerpt", () => {
    const pack = estimatePack({ messages, anchorMessageId: "m10", purpose: "abcd", excerpt: "硬碟" });
    expect(pack.rows).toEqual([
      { key: "purpose", count: 1, tokens: 1 },
      { key: "excerpt", count: 1, tokens: 2 },
      { key: "recent", count: 8, tokens: 16 },
    ]);
    expect(pack.total).toBe(19);
  });

  it("adds what came after the fork point only when asked", () => {
    const pack = estimatePack({ messages, anchorMessageId: "m10", purpose: "", excerpt: "", includeLater: true, recent: 4 });
    expect(pack.rows).toEqual([
      { key: "recent", count: 4, tokens: 8 },
      { key: "later", count: 2, tokens: 4 },
    ]);
  });

  it("is empty when the fork point is unknown", () => {
    expect(estimatePack({ messages, anchorMessageId: "x", purpose: "", excerpt: "" })).toEqual({ rows: [], total: 0 });
  });
});
