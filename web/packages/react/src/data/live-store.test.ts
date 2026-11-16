import type { Delta } from "@tangent/client";
import { describe, expect, it, vi } from "vitest";
import { createLiveStore, FAILED_JOBS_KEPT } from "./live-store";

const delta = (seq: number, text: string, turnId = "t1", kind: Delta["kind"] = "text"): Delta => ({ turnId, seq, kind, text });

describe("live store: streamed replies", () => {
  it("joins deltas in seq order, ignoring duplicates and late arrivals out of order", () => {
    const live = createLiveStore();
    live.addDeltas("l1", [delta(3, "c"), delta(1, "a")]);
    live.addDeltas("l1", [delta(2, "b"), delta(3, "c")]);
    expect(live.getState().streams.l1).toMatchObject({ turnId: "t1", text: "abc", lastSeq: 3 });
  });

  it("keeps reasoning apart from the reply text", () => {
    const live = createLiveStore();
    live.addDeltas("l1", [delta(1, "thinking", "t1", "reasoning"), delta(2, "answer")]);
    expect(live.getState().streams.l1).toMatchObject({ text: "answer", reasoning: "thinking" });
  });

  it("starts over for a new turn and ignores deltas of a finished one", () => {
    const live = createLiveStore();
    live.addDeltas("l1", [delta(1, "old")]);
    live.finishTurn("l1", "t1");
    expect(live.getState().streams.l1).toBeUndefined();
    live.addDeltas("l1", [delta(2, "late")]);
    expect(live.getState().streams.l1).toBeUndefined();
    live.addDeltas("l1", [delta(3, "new", "t2")]);
    expect(live.getState().streams.l1).toMatchObject({ turnId: "t2", text: "new" });
  });

  it("keeps the same state object when nothing changes, and notifies only on change", () => {
    const live = createLiveStore();
    const listener = vi.fn();
    live.subscribe(listener);
    live.addDeltas("l1", [delta(1, "a")]);
    live.finishTurn("l2", "x");
    const before = live.getState();
    live.addDeltas("l1", [delta(1, "a")]);
    live.finishTurn("l2", "x");
    live.setConnection("idle");
    live.markForbidden();
    live.markForbidden();
    expect(live.getState().streams).toBe(before.streams);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("live store: connection, retries, read-only", () => {
  it("tracks the event stream and counts resyncs", () => {
    const live = createLiveStore();
    expect(live.getState().connection.status).toBe("idle");
    live.setConnection("reconnecting", { attempt: 2, nextRetryAt: 5000 });
    expect(live.getState().connection).toEqual({ status: "reconnecting", attempt: 2, nextRetryAt: 5000 });
    live.setConnection("connecting");
    expect(live.getState().connection).toEqual({ status: "connecting", attempt: 2, nextRetryAt: null });
    live.setConnection("open");
    expect(live.getState().connection).toEqual({ status: "open", attempt: 0, nextRetryAt: null });
    const epoch = live.getState().resyncEpoch;
    live.resync();
    expect(live.getState().resyncEpoch).toBe(epoch + 1);
  });

  it("remembers a retrying turn per line until that turn streams or ends", () => {
    const live = createLiveStore();
    live.setRetrying("l1", { turnId: "t1", attempt: 1, maxAttempts: 3, nextRetryAt: "2026-01-01T00:00:00Z" });
    expect(live.getState().retrying.l1?.attempt).toBe(1);
    live.addDeltas("l1", [delta(1, "x", "other")]);
    expect(live.getState().retrying.l1).toBeDefined();
    live.addDeltas("l1", [delta(2, "x", "t1")]);
    expect(live.getState().retrying.l1).toBeUndefined();
    live.setRetrying("l1", { turnId: "t2", attempt: 1, maxAttempts: 3, nextRetryAt: "" });
    live.finishTurn("l1", "t2");
    expect(live.getState().retrying.l1).toBeUndefined();
  });

  it("turns read-only once a write is refused", () => {
    const live = createLiveStore();
    expect(live.getState().forbidden).toBe(false);
    live.markForbidden();
    expect(live.getState().forbidden).toBe(true);
  });
});

describe("live store: review fixes", () => {
  it("resync clears retry banners and streams (no stuck aiError after a reconnect)", () => {
    const live = createLiveStore();
    live.setRetrying("l1", { turnId: "t1", attempt: 1, maxAttempts: 2, nextRetryAt: "" });
    live.addDeltas("l2", [delta(1, "x")]);
    live.resync();
    expect(live.getState().retrying).toEqual({});
    expect(live.getState().streams).toEqual({});
  });

  it("assembles a real reordered and gapped stream, and fills the gap later", () => {
    const live = createLiveStore();
    // Arrival order from the wire: 10, 12, 11 (late), 14 (13 missing), then 13 from /stream.
    live.addDeltas("l1", [delta(10, "The ")]);
    live.addDeltas("l1", [delta(12, "brown ")]);
    live.addDeltas("l1", [delta(11, "quick ")]);
    live.addDeltas("l1", [delta(14, "jumps")]);
    expect(live.getState().streams.l1?.text).toBe("The quick brown jumps");
    live.addDeltas("l1", [delta(10, "The "), delta(13, "fox "), delta(14, "jumps")]);
    expect(live.getState().streams.l1).toMatchObject({ text: "The quick brown fox jumps", lastSeq: 14 });
  });

  it("appends in-order deltas without rebuilding (the earlier text object is extended)", () => {
    const live = createLiveStore();
    live.addDeltas("l1", [delta(1, "a"), delta(2, "b")]);
    const before = live.getState().streams.l1!;
    live.addDeltas("l1", [delta(3, "c")]);
    const after = live.getState().streams.l1!;
    expect(after.text).toBe("abc");
    expect(after.deltas.slice(0, 2)).toEqual(before.deltas);
  });

  it("marks a stream whose start is gone, and lets a re-run of a finished turn id stream again", () => {
    const live = createLiveStore();
    live.addDeltas("l1", [delta(5, "tail")], { gap: true });
    expect(live.getState().streams.l1?.gap).toBe(true);
    live.finishTurn("l1", "t1");
    live.addDeltas("l1", [delta(6, "late")]);
    expect(live.getState().streams.l1).toBeUndefined();
    live.beginTurn("l1", "t1");
    live.addDeltas("l1", [delta(7, "again")]);
    expect(live.getState().streams.l1?.text).toBe("again");
  });

  it("forgets deleted lines", () => {
    const live = createLiveStore();
    live.addDeltas("l1", [delta(1, "a")]);
    live.setRetrying("l1", { turnId: "t1", attempt: 1, maxAttempts: 2, nextRetryAt: "" });
    live.finishTurn("l2", "x");
    live.forgetLines(["l1", "l2"]);
    expect(live.getState()).toMatchObject({ streams: {}, retrying: {}, finished: {} });
  });

  it("says whether a deletion was news (F7: a delete's result and its event do the work once)", () => {
    const live = createLiveStore();
    expect(live.forgetLines(["l1", "l2"])).toBe(true);
    expect(live.forgetLines(["l2", "l1"])).toBe(false);
    expect(live.forgetLines(["l1", "l3"])).toBe(true);
    expect(live.forgetLines([])).toBe(false);
  });

  it("reconnects through the bound subscription", () => {
    const live = createLiveStore();
    const reconnect = vi.fn();
    live.reconnect();
    live.bindReconnect(reconnect);
    live.reconnect();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});

describe("live store: failed jobs (R9 G4)", () => {
  const failure = (n: number, lineId = "l") => ({ jobId: `j${n}`, kind: "goal_propose", lineId, rootLineId: "r", error: { code: "run_failed" as const, message: "" } });

  it("keeps only the newest FAILED_JOBS_KEPT failures", () => {
    const store = createLiveStore();
    for (let n = 1; n <= FAILED_JOBS_KEPT + 5; n += 1) store.jobFailed(failure(n));
    const ids = Object.keys(store.getState().failedJobs);
    expect(ids).toHaveLength(FAILED_JOBS_KEPT);
    expect(ids[0]).toBe("j6");
    expect(ids.at(-1)).toBe(`j${FAILED_JOBS_KEPT + 5}`);
  });

  it("forgets them on a resync and with their deleted lines", () => {
    const store = createLiveStore();
    store.jobFailed(failure(1, "a"));
    store.jobFailed(failure(2, "b"));
    store.forgetLines(["a"]);
    expect(Object.keys(store.getState().failedJobs)).toEqual(["j2"]);
    store.resync();
    expect(store.getState().failedJobs).toEqual({});
  });
});
