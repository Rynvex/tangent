import { TangentError } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { describeError } from "./error-text";

const t = createTranslator("zh-TW");

describe("describeError", () => {
  it("says the memory service is down for a while (B7.1 embedder_unavailable, 503)", () => {
    expect(describeError(new TangentError(503, "x", "embedder_unavailable"), t)).toBe("記憶服務暫時不能用，請稍後再試。");
  });

  it("names the memory refusals (B10 phase C)", () => {
    expect(describeError(new TangentError(409, "x", "memory_superseded"), t)).toBe("這條記憶已被取代；請改現在的那一條。");
    expect(describeError(new TangentError(422, "x", "invalid_memory"), t)).toBe("記憶要有種類、內容，重要性在 1 到 10 之間。");
    expect(describeError(new TangentError(404, "x", "memory_not_found"), t)).toBe("這條記憶已經不在了。");
  });

  it("names the comparison refusals (B10 phase B)", () => {
    expect(describeError(new TangentError(409, "x", "comparison_not_ready"), t)).toBe("比較表還沒寫好。");
    expect(describeError(new TangentError(409, "x", "comparison_decided"), t)).toBe("這個比較已經決定過了。");
    expect(describeError(new TangentError(422, "x", "invalid_comparison"), t)).toBe("比較要選同一條線底下 2 到 5 條進行中的支線。");
    expect(describeError(new TangentError(404, "x", "comparison_not_found"), t)).toBe("這個比較已經不在了。");
  });

  it("names the fold refusals (B10 phase A)", () => {
    expect(describeError(new TangentError(409, "x", "fold_overlap", { foldId: "f" }), t)).toBe("這段和另一個折疊重疊了。");
    expect(describeError(new TangentError(409, "x", "fold_limit", { limit: 7 }), t)).toBe("這條線的折疊已經到上限（7 個）。");
    expect(describeError(new TangentError(422, "x", "invalid_fold"), t)).toBe("折疊要包含 2 到 200 則已完成的訊息。");
    expect(describeError(new TangentError(404, "x", "fold_not_found"), t)).toBe("這個折疊已經不在了。");
  });

  it("has a sentence for the codes a conversation hits", () => {
    expect(describeError(new TangentError(403, "x", "forbidden"), t)).toBe("你只有檢視權限，沒有做任何變更。");
    expect(describeError(new TangentError(409, "x", "archived"), t)).toContain("已封存");
    expect(describeError(new TangentError(429, "x", "rate_limited", { retryAfterSeconds: 7 }), t)).toBe("請求太頻繁，請 7 秒後再試。");
  });

  it("has a sentence for B9's goal and relation codes (F5)", () => {
    expect(describeError(new TangentError(404, "x", "goal_not_found"), t)).toBe("這個對話沒有目標。");
    expect(describeError(new TangentError(404, "x", "relation_not_found"), t)).toBe("這條關聯已經不在了。");
    expect(describeError(new TangentError(409, "x", "relation_exists"), t)).toBe("這兩個地方已經有關聯了。");
    expect(describeError(new TangentError(409, "x", "relation_limit", { limit: 200 }), t)).toBe("這個對話的關聯已達 200 條。");
    expect(describeError(new TangentError(409, "x", "relation_limit"), t)).toBe("這個對話的關聯已達 200 條。");
  });

  it("uses the host's text for its own codes, else the server's short text", () => {
    expect(describeError(new TangentError(409, "daemon offline", "daemon_offline"), t, (code) => (code === "daemon_offline" ? "離線" : undefined))).toBe("離線");
    expect(describeError(new TangentError(409, "daemon offline", "daemon_offline"), t)).toBe("daemon offline");
  });

  it("never shows internal details, and treats non-API failures as network errors", () => {
    expect(describeError(new TangentError(500, "internal error", "internal"), t)).toBe("發生錯誤（internal）。");
    expect(describeError(new TangentError(502, "Bad Gateway"), t)).toBe("發生錯誤（502）。");
    expect(describeError(new TypeError("Failed to fetch"), t)).toBe("連不上伺服器。");
  });
});
