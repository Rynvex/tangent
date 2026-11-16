import { describe, expect, it, vi } from "vitest";
import { createTangentClient } from "./api";
import { TangentError } from "./errors";
import { backoffDelay, DEFAULT_BACKOFF, EVENT_TYPES, parseEvent, subscribeEvents, type SubscribeEventsOptions } from "./events";

const encoder = new TextEncoder();

/** One server-side stream; the test writes to it. */
class Stream {
  controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly body = new ReadableStream<Uint8Array>({ start: (controller) => void (this.controller = controller) });
  send(text: string): void {
    this.controller.enqueue(encoder.encode(text));
  }
  end(): void {
    this.controller.close();
  }
}

interface Timer {
  id: number;
  callback: () => void;
  ms: number;
}

/** A fake server plus manual timers; responses are streams unless `failWith` says otherwise. */
function harness(failWith: Array<{ status: number; text?: string }> = []) {
  const streams: Stream[] = [];
  const inits: RequestInit[] = [];
  const urls: string[] = [];
  let timers: Timer[] = [];
  let nextId = 0;
  const failures = [...failWith];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    inits.push(init ?? {});
    const failure = failures.shift();
    if (failure) return new Response(failure.text ?? "", { status: failure.status });
    const stream = new Stream();
    streams.push(stream);
    init?.signal?.addEventListener("abort", () => stream.controller.error(new DOMException("aborted", "AbortError")));
    return new Response(stream.body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  const scheduling: Pick<SubscribeEventsOptions, "setTimeout" | "clearTimeout" | "fetch"> = {
    fetch: fetchFn,
    setTimeout: (callback, ms) => {
      nextId += 1;
      timers = [...timers, { id: nextId, callback, ms }];
      return nextId;
    },
    clearTimeout: (id) => {
      timers = timers.filter((timer) => timer.id !== id);
    },
  };
  /** Runs the first pending timer whose delay matches `ms` (or any timer when omitted). */
  const fire = (ms?: number): number => {
    const timer = timers.find((item) => ms === undefined || item.ms === ms);
    if (!timer) throw new Error(`no timer of ${ms}ms; pending: ${timers.map((t) => t.ms).join(",")}`);
    timers = timers.filter((item) => item !== timer);
    timer.callback();
    return timer.ms;
  };
  const pending = (): number[] => timers.map((timer) => timer.ms);
  return { streams, inits, urls, scheduling, fire, pending, fetchFn };
}

/** Lets fetch resolve and the reader pull what was enqueued. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const envelope = (type: string, data: unknown) => JSON.stringify({ type, tenant: "t", rootLineId: "r", lineId: "l", data });
const sse = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`;
const STABLE = 5000;

describe("subscribeEvents over fetch (DESIGN §12)", () => {
  it("sends the host headers and credentials and routes typed events", async () => {
    const h = harness();
    const onDelta = vi.fn();
    const onEvent = vi.fn();
    const sub = subscribeEvents({
      url: "/api/events",
      headers: () => ({ Authorization: "Bearer x" }),
      credentials: "include",
      handlers: { "message.delta": onDelta },
      onEvent,
      ...h.scheduling,
    });
    await settle();
    const headers = new Headers(h.inits[0]!.headers);
    expect(h.urls[0]).toBe("/api/events");
    expect(headers.get("Authorization")).toBe("Bearer x");
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(h.inits[0]!.credentials).toBe("include");
    const delta = sse("message.delta", envelope("message.delta", { turnId: "t1", seq: 1, kind: "text", text: "hi" }));
    h.streams[0]!.send(delta.slice(0, 20));
    h.streams[0]!.send(delta.slice(20) + sse("notes.changed", envelope("notes.changed", { rootLineId: "r", revision: 2 })));
    await settle();
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta.mock.calls[0]![0]).toMatchObject({ type: "message.delta", data: { text: "hi" } });
    expect(onEvent).toHaveBeenCalledTimes(2);
    sub.close();
  });

  it("takes the type from the SSE event name when the envelope has none, and reads unnamed events", async () => {
    const h = harness();
    const onChapters = vi.fn();
    const sub = subscribeEvents({ url: "u", handlers: { "chapters.changed": onChapters }, ...h.scheduling });
    await settle();
    h.streams[0]!.send(sse("chapters.changed", JSON.stringify({ data: { rootLineId: "r" } })));
    h.streams[0]!.send(`data: ${envelope("chapters.changed", { rootLineId: "r2" })}\n\n`);
    await settle();
    expect(onChapters.mock.calls.map((call) => call[0].data.rootLineId)).toEqual(["r", "r2"]);
    sub.close();
  });

  it("reports malformed, unknown and data-less events and keeps going", async () => {
    const h = harness();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const sub = subscribeEvents({ url: "u", handlers: {}, onEvent, onError, ...h.scheduling });
    await settle();
    h.streams[0]!.send(sse("line.updated", "{not json"));
    h.streams[0]!.send(`data: ${envelope("something.new", {})}\n\n`);
    h.streams[0]!.send(sse("line.updated", JSON.stringify({ type: "line.updated", data: null })));
    h.streams[0]!.send(sse("branch.changed", envelope("branch.changed", { change: "exploded", branch: {} })));
    h.streams[0]!.send(sse("line.updated", envelope("line.updated", { id: "l" })));
    await settle();
    expect(onError).toHaveBeenCalledTimes(4);
    expect(onError.mock.calls[0]![1]).toBe("{not json");
    expect(onEvent).toHaveBeenCalledTimes(1);
    sub.close();
  });

  it("isolates a throwing handler and still runs onEvent and later events (review M5)", async () => {
    const h = harness();
    const onError = vi.fn();
    const onEvent = vi.fn();
    const boom = new Error("handler bug");
    const sub = subscribeEvents({
      url: "u",
      handlers: {
        "line.updated": () => {
          throw boom;
        },
      },
      onEvent,
      onError,
      ...h.scheduling,
    });
    await settle();
    h.streams[0]!.send(sse("line.updated", envelope("line.updated", { id: "a" })) + sse("line.updated", envelope("line.updated", { id: "b" })));
    await settle();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]![0]).toBe(boom);
    expect(onEvent).toHaveBeenCalledTimes(2);
    sub.close();
  });

  it("normalizes payloads: null lists in a line become empty arrays (review H1)", async () => {
    const h = harness();
    const onLine = vi.fn();
    const sub = subscribeEvents({ url: "u", handlers: { "line.updated": onLine }, ...h.scheduling });
    await settle();
    h.streams[0]!.send(sse("line.updated", envelope("line.updated", { id: "l", summary: { decisions: null }, branchCounts: null })));
    await settle();
    expect(onLine.mock.calls[0]![0].data.summary.decisions).toEqual([]);
    expect(onLine.mock.calls[0]![0].data.branchCounts.open).toBe(0);
    sub.close();
  });

  it("delivers turn.retrying with its retry fields and a usage on line payloads (DESIGN §12, F0)", async () => {
    const h = harness();
    const onRetry = vi.fn();
    const onLine = vi.fn();
    const sub = subscribeEvents({ url: "u", handlers: { "turn.retrying": onRetry, "line.updated": onLine }, ...h.scheduling });
    await settle();
    h.streams[0]!.send(sse("turn.retrying", envelope("turn.retrying", { turnId: "t1", attempt: 2, maxAttempts: 3, nextRetryAt: "2026-10-15T12:00:12Z" })));
    h.streams[0]!.send(sse("line.updated", envelope("line.updated", { id: "l", usage: { inputTokens: 33000, outputTokens: 5100, costUsd: 0.21 } })));
    await settle();
    expect(onRetry.mock.calls[0]![0].data).toEqual({ turnId: "t1", attempt: 2, maxAttempts: 3, nextRetryAt: "2026-10-15T12:00:12Z" });
    expect(onLine.mock.calls[0]![0].data.usage).toEqual({ inputTokens: 33000, outputTokens: 5100, costUsd: 0.21 });
    sub.close();
  });

  it("backs off exponentially with jitter, reports HTTP errors and reconnects (review M5)", async () => {
    const h = harness([{ status: 503 }, { status: 503 }, { status: 401, text: '{"error":"no","code":"unauthorized"}' }]);
    const onError = vi.fn();
    const statuses: string[] = [];
    const sub = subscribeEvents({
      url: "u",
      handlers: {},
      onError,
      onStatus: (status) => statuses.push(status),
      random: () => 1,
      backoff: { initialMs: 100, maxMs: 300, factor: 2, jitter: 0.5 },
      ...h.scheduling,
    });
    await settle();
    expect(h.pending()).toEqual([50]);
    h.fire(50);
    await settle();
    expect(h.pending()).toEqual([100]);
    h.fire(100);
    await settle();
    expect(h.pending()).toEqual([150]);
    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[2]![0]).toBeInstanceOf(TangentError);
    expect(onError.mock.calls[2]![0]).toMatchObject({ status: 401, code: "unauthorized" });
    expect(statuses.slice(0, 3)).toEqual(["connecting", "reconnecting", "connecting"]);
    sub.close();
  });

  it("tells which reconnect attempt comes next and when", async () => {
    const h = harness([{ status: 503 }, { status: 503 }]);
    const infos: Array<{ attempt: number; nextRetryAt: number } | undefined> = [];
    const before = Date.now();
    const sub = subscribeEvents({
      url: "u",
      handlers: {},
      onStatus: (status, info) => {
        if (status === "reconnecting") infos.push(info);
      },
      random: () => 0,
      backoff: { initialMs: 100, maxMs: 300, factor: 2, jitter: 0.5 },
      ...h.scheduling,
    });
    await settle();
    h.fire(100);
    await settle();
    expect(infos.map((info) => info?.attempt)).toEqual([1, 2]);
    expect(infos[0]!.nextRetryAt).toBeGreaterThanOrEqual(before + 100);
    sub.close();
  });

  it("resets the backoff only after a stable connection or a message, not on mere open (review M5)", async () => {
    const h = harness([{ status: 500 }]);
    const sub = subscribeEvents({ url: "u", handlers: {}, random: () => 0, backoff: { initialMs: 100, maxMs: 10_000, factor: 2 }, stableMs: STABLE, ...h.scheduling });
    await settle();
    h.fire(100);
    await settle();
    // Open, then dropped before it was stable: the next delay keeps growing.
    h.streams[0]!.end();
    await settle();
    expect(h.pending()).toEqual([200]);
    h.fire(200);
    await settle();
    // Open long enough: the stable timer resets the backoff.
    h.fire(STABLE);
    h.streams[1]!.end();
    await settle();
    expect(h.pending()).toEqual([100]);
    h.fire(100);
    await settle();
    // Dropped right after a message: the message reset it too.
    h.streams[2]!.send(sse("chapters.changed", envelope("chapters.changed", { rootLineId: "r" })));
    await settle();
    h.streams[2]!.end();
    await settle();
    expect(h.pending()).toEqual([100]);
    sub.close();
  });

  it("calls onReconnect when the stream is back after a drop, not on the first open (review M5)", async () => {
    const h = harness();
    const onReconnect = vi.fn();
    const statuses: string[] = [];
    const sub = subscribeEvents({ url: "u", handlers: {}, onReconnect, onStatus: (s) => statuses.push(s), random: () => 0, ...h.scheduling });
    await settle();
    expect(onReconnect).not.toHaveBeenCalled();
    h.streams[0]!.end();
    await settle();
    h.fire(DEFAULT_BACKOFF.initialMs);
    await settle();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "connecting", "open"]);
    sub.close();
  });

  it("reconnect() skips the backoff wait, and reopens an open stream at once without reporting an error", async () => {
    const h = harness([{ status: 503 }]);
    const onError = vi.fn();
    const onReconnect = vi.fn();
    const statuses: string[] = [];
    const sub = subscribeEvents({ url: "u", handlers: {}, onError, onReconnect, onStatus: (status) => statuses.push(status), random: () => 0, ...h.scheduling });
    await settle();
    expect(h.pending()).toEqual([1000]);
    sub.reconnect();
    await settle();
    expect(h.pending()).toEqual([STABLE]);
    expect(h.streams).toHaveLength(1);
    const errorsBefore = onError.mock.calls.length;
    sub.reconnect();
    await settle();
    expect(h.streams).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(errorsBefore);
    expect(onReconnect).toHaveBeenCalled();
    expect(statuses.filter((status) => status === "reconnecting")).toHaveLength(1);
    sub.close();
  });

  it("stops for good on close: aborts the stream and cancels a pending reconnect", async () => {
    const h = harness();
    const onError = vi.fn();
    const statuses: string[] = [];
    const sub = subscribeEvents({ url: "u", handlers: {}, onError, onStatus: (s) => statuses.push(s), ...h.scheduling });
    await settle();
    sub.close();
    await settle();
    expect(h.pending()).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(statuses[statuses.length - 1]).toBe("closed");
    sub.close();
  });

  it("is reached through client.subscribe with the client's headers and credentials (review M5)", async () => {
    const h = harness();
    const client = createTangentClient({ baseUrl: "/api/", headers: () => ({ "X-Tenant": "t1" }), credentials: "include", fetch: h.scheduling.fetch! });
    const sub = client.subscribe({ handlers: {}, setTimeout: h.scheduling.setTimeout!, clearTimeout: h.scheduling.clearTimeout! });
    await settle();
    expect(h.urls[0]).toBe("/api/events");
    expect(new Headers(h.inits[0]!.headers).get("X-Tenant")).toBe("t1");
    expect(h.inits[0]!.credentials).toBe("include");
    sub.close();
  });
});

describe("backoffDelay and parseEvent", () => {
  it("caps the delay and applies jitter within [1 - jitter, 1] of it", () => {
    const backoff = { initialMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.5 };
    expect(backoffDelay(0, backoff, 0)).toBe(1000);
    expect(backoffDelay(0, backoff, 1)).toBe(500);
    expect(backoffDelay(10, backoff, 0)).toBe(30_000);
  });

  it("knows the nine event types of DESIGN §6, turn.retrying and stream.lagged (§12), B8's, B9's (goal, group, job.failed), B10's (fold) and B13's (memo)", () => {
    expect(EVENT_TYPES).toHaveLength(24);
    expect(EVENT_TYPES).toContain("memo.changed");
    expect(EVENT_TYPES).toContain("terms.changed");
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(["fold.changed", "comparison.changed", "memory.changed"]));
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(["group.changed", "job.failed"]));
    expect(EVENT_TYPES).toContain("goal.changed");
    expect(EVENT_TYPES).toContain("summary.due");
    expect(EVENT_TYPES).toContain("link.changed");
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(["suggestion.changed", "leaf.changed", "seeds.changed"]));
    expect(EVENT_TYPES).toContain("turn.retrying");
    expect(EVENT_TYPES).toContain("stream.lagged");
    expect(() => parseEvent("message", "[]")).toThrow(/object/);
    // stream.lagged may come without a payload; other events may not.
    expect(parseEvent("stream.lagged", JSON.stringify({ type: "stream.lagged", tenant: "t" })).data).toEqual({});
    expect(parseEvent("stream.lagged", JSON.stringify({ type: "stream.lagged", data: { dropped: 3 } })).data).toEqual({ dropped: 3 });
    expect(() => parseEvent("line.updated", JSON.stringify({ type: "line.updated" }))).toThrow(/no data/);
    expect(() => parseEvent("toString", JSON.stringify({ data: {} }))).toThrow(/unknown event type/);
  });
});
