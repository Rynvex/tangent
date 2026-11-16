/**
 * B21: waiting out the server's rate limit (`429 rate_limited`, `Retry-After`)
 * on the import's many requests. A topic-split combined export can be dozens
 * or hundreds of conversations: the batch's imports and relations and the
 * undo's deletes pass the reference server's burst (60) at once. Each request
 * is retried after the time the server asked for, a bounded number of times;
 * every other error passes through unchanged.
 */
import { TangentError } from "./errors";

/** How many times a request is sent in all before its 429 is given up on. */
export const RATE_LIMIT_MAX_ATTEMPTS = 6;
/** The wait when the 429 says nothing (no or an unreadable `Retry-After`). */
export const RATE_LIMIT_DEFAULT_WAIT_MS = 1000;
/** The longest single wait, whatever `Retry-After` says. */
export const RATE_LIMIT_MAX_WAIT_MS = 10_000;

export interface RateLimitRetryOptions {
  /** Attempts in all (RATE_LIMIT_MAX_ATTEMPTS by default). */
  maxAttempts?: number;
  /** Waits `ms`; tests pass one that resolves at once. */
  sleep?: (ms: number) => Promise<void>;
  /** Before each wait: how long, and which attempt comes next (2 for the first retry). */
  onWait?: (ms: number, nextAttempt: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Whether an error is the server's rate limit. */
export const isRateLimited = (error: unknown): error is TangentError => error instanceof TangentError && error.code === "rate_limited";

/** How long a 429 asks to wait: its `Retry-After` (capped at RATE_LIMIT_MAX_WAIT_MS), else RATE_LIMIT_DEFAULT_WAIT_MS. */
export function rateLimitWaitMs(error: TangentError): number {
  const seconds = error.extra.retryAfterSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return RATE_LIMIT_DEFAULT_WAIT_MS;
  return Math.min(seconds * 1000, RATE_LIMIT_MAX_WAIT_MS);
}

/** Runs `request`, waiting and sending it again while the server answers `rate_limited`; the last error is thrown as it came. */
export async function withRateLimitRetry<T>(request: () => Promise<T>, options: RateLimitRetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS);
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isRateLimited(error) || attempt >= maxAttempts) throw error;
      const wait = rateLimitWaitMs(error);
      options.onWait?.(wait, attempt + 1);
      await sleep(wait);
    }
  }
}

/** Runs `task` on every item with at most `limit` running at once; the results keep the items' order. */
export async function settleBounded<I, T>(items: readonly I[], limit: number, task: (item: I) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        out[index] = { status: "fulfilled", value: await task(items[index]!) };
      } catch (reason) {
        out[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
