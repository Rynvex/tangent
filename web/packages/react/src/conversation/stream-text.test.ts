/**
 * R1 review fixes of the pending reply's text (F2): the text after the saved
 * base is found without walking every delta, a base without `streamSeq` is
 * not repeated, and the gap marker appears only for a real truncation.
 */
import { normalizeMessage, type Delta, type Message } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { mergeDeltas, type StreamState } from "../data/live-store";
import { pendingText } from "./assistant-message";

const TURN = "p1";
const pending = (content: string, streamSeq?: number): Message =>
  normalizeMessage({ id: TURN, seq: 5, lineId: "l1", role: "assistant", status: "pending", content, meta: streamSeq === undefined ? {} : { streamSeq } });
const delta = (seq: number, text: string, kind: Delta["kind"] = "text"): Delta => ({ turnId: TURN, seq, kind, text });

function streamOf(deltas: readonly Delta[], gap = false): StreamState {
  const stream = mergeDeltas(undefined, TURN, deltas, gap);
  if (!stream) throw new Error("no stream");
  return stream;
}

/** The same stream whose deltas count every element read (index access). */
function counting(stream: StreamState): { stream: StreamState; reads: () => number } {
  let reads = 0;
  const deltas = new Proxy([...stream.deltas], {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  return { stream: { ...stream, deltas }, reads: () => reads };
}

describe("R1-1: the text after the saved base is incremental", () => {
  it("reads only a logarithmic number of deltas, however long the reply", () => {
    const deltas = Array.from({ length: 20_000 }, (_, i) => delta(1000 + i * 3, `w${i} `));
    const { stream, reads } = counting(streamOf(deltas));
    const baseSeq = 1000 + 15_000 * 3;
    const text = pendingText(pending("saved ", baseSeq), stream);
    expect(text.startsWith("saved w15001 ")).toBe(true);
    expect(text.endsWith("w19999 ")).toBe(true);
    expect(reads()).toBeLessThan(40);
  });

  it("keeps each delta's start in the text through the in-order and the late (re-sorted) paths", () => {
    const first = streamOf([delta(10, "Half "), delta(12, "thinking", "reasoning"), delta(13, "answer")]);
    expect(first.textStarts).toEqual([0, 5, 5]);
    const late = mergeDeltas(first, TURN, [delta(11, "of the ")])!;
    expect(late.text).toBe("Half of the answer");
    expect(late.textStarts).toEqual([0, 5, 12, 12]);
    expect(pendingText(pending("Half of the ", 11), late)).toBe("Half of the answer");
    expect(pendingText(pending("Half ", 10), late)).toBe("Half of the answer");
    expect(pendingText(pending("Half of the answer", 13), late)).toBe("Half of the answer");
  });
});

describe("R1-2: a stored base without streamSeq (another host) is not repeated", () => {
  it("appends only what the stream has beyond the stored text", () => {
    const stream = streamOf([delta(10, "Hello "), delta(11, "world")]);
    expect(pendingText(pending("Hello "), stream)).toBe("Hello world");
    expect(pendingText(pending("Hello world, and more"), stream)).toBe("Hello world, and more");
    expect(pendingText(pending(""), stream)).toBe("Hello world");
  });

  it("still appends a stream that does not start with the stored text", () => {
    expect(pendingText(pending("Saved. "), streamOf([delta(10, "Next part")]))).toBe("Saved. Next part");
  });
});

describe("R1-3: the gap marker follows /stream's truncated flag, not seq arithmetic", () => {
  // Delta seqs come from one process-wide counter (delta.go), so a line's seqs are not contiguous:
  // the tail after the base may start well above streamSeq + 1 and still be complete.
  it("shows no gap for a complete (truncated=false) tail that starts far above the base's streamSeq", () => {
    const tail = streamOf([delta(1007, "the "), delta(1031, "answer")], false);
    expect(pendingText(pending("Half of ", 1000), tail)).toBe("Half of the answer");
  });

  it("shows the gap when /stream said truncated (deltas after the base are gone)", () => {
    const tail = streamOf([delta(1031, "answer")], true);
    expect(pendingText(pending("Half of ", 1000), tail)).toBe("Half of  … answer");
  });
});
