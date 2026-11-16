/**
 * How a mock request completes, kept as close to `fetch` as an in-memory
 * client can: an aborted `signal` rejects with an `AbortError` (before or
 * during the simulated latency), the result is a structured clone (callers
 * can never mutate the mock's state) passed through the same normalizer the
 * real client uses, and `dispose()` cancels every request still waiting.
 */
import type { MockTimers } from "./mock-context";

export type Normalize<T> = (raw: unknown) => T;

export interface MockResponder {
  respond<T>(operation: () => unknown, normalize: Normalize<T>, signal?: AbortSignal): Promise<T>;
  dispose(): void;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function createMockResponder(latencyMs: number, timers: MockTimers): MockResponder {
  const waiting = new Set<{ handle: unknown; fail: (error: unknown) => void }>();

  function wait(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (latencyMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const entry = {
        handle: null as unknown,
        fail: (error: unknown) => {
          timers.clearTimeout(entry.handle);
          waiting.delete(entry);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => entry.fail(abortError());
      entry.handle = timers.setTimeout(() => {
        waiting.delete(entry);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, latencyMs);
      waiting.add(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    respond(operation, normalize, signal) {
      return wait(signal).then(() => {
        if (signal?.aborted) throw abortError();
        const result = operation();
        return normalize(result === undefined ? undefined : structuredClone(result));
      });
    },
    dispose() {
      for (const entry of [...waiting]) entry.fail(abortError());
    },
  };
}
