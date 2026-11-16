import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingDeletes, DELETE_UNDO_MS, type PendingDelete } from "./pending-deletes";

/** F18: a delete waits 5 seconds, can be taken back, and is sent once whatever ends the wait. */

const A: PendingDelete = { lineId: "a", rootLineId: "root-1" };
const B: PendingDelete = { lineId: "b", rootLineId: "root-1" };
const C: PendingDelete = { lineId: "c", rootLineId: "root-2" };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const send = vi.fn<(item: PendingDelete, leaving: boolean) => void>();
  return { send, deletes: createPendingDeletes({ send }) };
}

describe("createPendingDeletes", () => {
  it("sends nothing until the wait is over, then exactly once", () => {
    const { send, deletes } = setup();
    expect(deletes.schedule(A)).toBe(true);
    vi.advanceTimersByTime(DELETE_UNDO_MS - 1);
    expect(send).not.toHaveBeenCalled();
    expect(deletes.waiting()).toEqual([A]);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(A, false);
    vi.advanceTimersByTime(DELETE_UNDO_MS * 3);
    expect(send).toHaveBeenCalledTimes(1);
    expect(deletes.waiting()).toEqual([]);
  });

  it("an undo within the wait cancels it for good", () => {
    const { send, deletes } = setup();
    deletes.schedule(A);
    vi.advanceTimersByTime(DELETE_UNDO_MS - 1);
    expect(deletes.undo("a")).toBe(true);
    vi.advanceTimersByTime(DELETE_UNDO_MS * 3);
    expect(send).not.toHaveBeenCalled();
    deletes.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("an undo after it was sent says so and sends nothing more", () => {
    const { send, deletes } = setup();
    deletes.schedule(A);
    vi.advanceTimersByTime(DELETE_UNDO_MS);
    expect(deletes.undo("a")).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asking twice for the same line keeps the first wait and sends once", () => {
    const { send, deletes } = setup();
    deletes.schedule(A);
    vi.advanceTimersByTime(3000);
    expect(deletes.schedule(A)).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DELETE_UNDO_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("leaving the page sends everything at once, marked as leaving, and the timers send nothing after", () => {
    const { send, deletes } = setup();
    deletes.schedule(A);
    deletes.schedule(C);
    vi.advanceTimersByTime(1000);
    deletes.flush(undefined, true);
    expect(send.mock.calls).toEqual([
      [A, true],
      [C, true],
    ]);
    vi.advanceTimersByTime(DELETE_UNDO_MS * 2);
    expect(send).toHaveBeenCalledTimes(2);
    deletes.flush(undefined, true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("switching conversations sends only the other trees' deletes; this tree's keep waiting", () => {
    const { send, deletes } = setup();
    deletes.schedule(A);
    deletes.schedule(B);
    deletes.schedule(C);
    deletes.flush((item) => item.rootLineId !== "root-2");
    expect(send.mock.calls).toEqual([
      [A, false],
      [B, false],
    ]);
    expect(deletes.waiting()).toEqual([C]);
    vi.advanceTimersByTime(DELETE_UNDO_MS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(C, false);
  });

  it("each delete has its own wait", () => {
    const { send, deletes } = setup();
    deletes.schedule(A);
    vi.advanceTimersByTime(3000);
    deletes.schedule(B);
    vi.advanceTimersByTime(2000);
    expect(send.mock.calls).toEqual([[A, false]]);
    vi.advanceTimersByTime(3000);
    expect(send.mock.calls).toEqual([
      [A, false],
      [B, false],
    ]);
  });

  it("a send that throws does not stop the others of a flush", () => {
    const send = vi.fn((item: PendingDelete) => {
      if (item.lineId === "a") throw new Error("offline");
    });
    const deletes = createPendingDeletes({ send });
    deletes.schedule(A);
    deletes.schedule(B);
    expect(() => deletes.flush()).toThrow("offline");
    // The one that threw is not waiting any more (never sent twice); the other still is and goes with the next flush.
    expect(deletes.waiting()).toEqual([B]);
    deletes.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("restart gives a waiting delete the full time again, and does nothing for one that is not waiting (追加 B.3)", () => {
    // Arrange
    const { send, deletes } = setup();
    deletes.schedule(A);
    vi.advanceTimersByTime(DELETE_UNDO_MS - 1);

    // Act
    const restarted = deletes.restart(A.lineId);
    vi.advanceTimersByTime(DELETE_UNDO_MS - 1);

    // Assert
    expect(restarted).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(deletes.waiting()).toEqual([A]);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(deletes.restart(A.lineId)).toBe(false);
    expect(deletes.restart("never-asked")).toBe(false);
    vi.advanceTimersByTime(DELETE_UNDO_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
