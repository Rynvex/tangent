/**
 * Deletes that wait before they are sent (F18 §2.1, §2.3): the server has no
 * undo, so 丟掉 and a childless 刪除支線 only hide the branch and are sent
 * after `delayMs`; taking it back within that time just cancels it. Leaving
 * the page, switching conversations or unmounting sends what is waiting at
 * once (`flush`). Each delete is sent exactly once, or never (undone).
 */
export const DELETE_UNDO_MS = 5000;

export interface PendingDelete {
  lineId: string;
  /** The tree it is in: switching to another conversation sends it. */
  rootLineId: string;
}

export interface PendingDeleteTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface PendingDeletesOptions {
  /** Sends one delete. `leaving`: the page is going away (the request must outlive it). Its failures are the caller's to show. */
  send: (item: PendingDelete, leaving: boolean) => void;
  delayMs?: number;
  timers?: PendingDeleteTimers;
}

export interface PendingDeletes {
  /** Starts the wait; false when this line is already waiting (nothing changes). */
  schedule(item: PendingDelete): boolean;
  /** Takes it back; false when it was not waiting any more (already sent). */
  undo(lineId: string): boolean;
  /** Gives a waiting delete the full time again (one 復原 then covers it and a newer one); false when it was not waiting. */
  restart(lineId: string): boolean;
  /** Sends everything `match` picks (all by default) now. */
  flush(match?: (item: PendingDelete) => boolean, leaving?: boolean): void;
  waiting(): readonly PendingDelete[];
}

const DEFAULT_TIMERS: PendingDeleteTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createPendingDeletes({ send, delayMs = DELETE_UNDO_MS, timers = DEFAULT_TIMERS }: PendingDeletesOptions): PendingDeletes {
  const waiting = new Map<string, { item: PendingDelete; timer: unknown }>();

  /** Takes the entry out first, so nothing can send it a second time. */
  const take = (lineId: string): PendingDelete | null => {
    const entry = waiting.get(lineId);
    if (!entry) return null;
    waiting.delete(lineId);
    timers.clearTimeout(entry.timer);
    return entry.item;
  };

  const sendNow = (lineId: string, leaving: boolean): void => {
    const item = take(lineId);
    if (item) send(item, leaving);
  };

  return {
    schedule(item) {
      if (waiting.has(item.lineId)) return false;
      waiting.set(item.lineId, { item, timer: timers.setTimeout(() => sendNow(item.lineId, false), delayMs) });
      return true;
    },
    undo: (lineId) => take(lineId) !== null,
    restart(lineId) {
      const item = take(lineId);
      if (!item) return false;
      waiting.set(lineId, { item, timer: timers.setTimeout(() => sendNow(lineId, false), delayMs) });
      return true;
    },
    flush(match = () => true, leaving = false) {
      for (const { item } of [...waiting.values()]) {
        if (match(item)) sendNow(item.lineId, leaving);
      }
    },
    waiting: () => [...waiting.values()].map((entry) => entry.item),
  };
}
