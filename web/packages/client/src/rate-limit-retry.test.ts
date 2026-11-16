import { describe, expect, it } from "vitest";
import { TangentError } from "./errors";
import { RATE_LIMIT_DEFAULT_WAIT_MS, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_MAX_WAIT_MS, rateLimitWaitMs, settleBounded, withRateLimitRetry } from "./rate-limit-retry";

const limited = (retryAfterSeconds?: number) => new TangentError(429, "too many requests", "rate_limited", retryAfterSeconds === undefined ? {} : { retryAfterSeconds });

/** A request failing with each of `errors` in turn, then answering "ok"; and a sleep that records its waits. */
function scripted(errors: unknown[]) {
  let calls = 0;
  const waits: number[] = [];
  const request = async () => {
    calls += 1;
    const error = errors.shift();
    if (error) throw error;
    return "ok";
  };
  return { request, waits, sleep: async (ms: number) => void waits.push(ms), calls: () => calls };
}

describe("withRateLimitRetry", () => {
  it("waits the Retry-After the server asked for and sends the request again", async () => {
    // Arrange
    const s = scripted([limited(2), limited()]);
    const told: Array<[number, number]> = [];
    // Act
    const result = await withRateLimitRetry(s.request, { sleep: s.sleep, onWait: (ms, next) => told.push([ms, next]) });
    // Assert
    expect(result).toBe("ok");
    expect(s.calls()).toBe(3);
    expect(s.waits).toEqual([2000, RATE_LIMIT_DEFAULT_WAIT_MS]);
    expect(told).toEqual([[2000, 2], [RATE_LIMIT_DEFAULT_WAIT_MS, 3]]);
  });

  it("gives up after the last attempt and throws the 429 as it came", async () => {
    const s = scripted(Array.from({ length: RATE_LIMIT_MAX_ATTEMPTS + 2 }, () => limited(1)));
    await expect(withRateLimitRetry(s.request, { sleep: s.sleep })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(s.calls()).toBe(RATE_LIMIT_MAX_ATTEMPTS);
    expect(s.waits).toHaveLength(RATE_LIMIT_MAX_ATTEMPTS - 1);
  });

  it("never retries another error", async () => {
    const busy = new TangentError(409, "busy", "session_busy");
    const s = scripted([busy]);
    await expect(withRateLimitRetry(s.request, { sleep: s.sleep })).rejects.toBe(busy);
    const offline = scripted([new Error("offline")]);
    await expect(withRateLimitRetry(offline.request, { sleep: offline.sleep })).rejects.toThrow("offline");
    expect(s.calls() + offline.calls()).toBe(2);
    expect([...s.waits, ...offline.waits]).toEqual([]);
  });

  it("caps a long Retry-After and ignores a bad one", () => {
    expect(rateLimitWaitMs(limited(120))).toBe(RATE_LIMIT_MAX_WAIT_MS);
    expect(rateLimitWaitMs(limited(0))).toBe(RATE_LIMIT_DEFAULT_WAIT_MS);
    expect(rateLimitWaitMs(limited(Number.NaN))).toBe(RATE_LIMIT_DEFAULT_WAIT_MS);
  });
});

describe("settleBounded", () => {
  it("runs at most the limit at once and keeps the items' order", async () => {
    let running = 0;
    let most = 0;
    const settled = await settleBounded([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 8 - n));
      running -= 1;
      if (n === 4) throw new Error("four");
      return n * 10;
    });
    expect(most).toBe(3);
    expect(settled.map((item) => (item.status === "fulfilled" ? item.value : "x"))).toEqual([10, 20, 30, "x", 50, 60, 70]);
    expect(await settleBounded([], 3, async () => 1)).toEqual([]);
  });
});
