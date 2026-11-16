/**
 * Transient UI state of the live connection (F1): the text of replies still
 * streaming, the event stream's status, runner retries and whether a write was
 * refused. Server data never lives here — it is in the TanStack Query cache;
 * SSE events only invalidate or update queries. Components read this store
 * with `useSyncExternalStore` (see live-hooks.ts); every update returns a new
 * state object only when something changed, so selectors stay stable.
 */
import type { Delta, EventStreamStatus, JobFailed, ReconnectInfo, TurnRetrying } from "@tangent/client";

/** The streamed part of one running reply. */
export interface StreamState {
  turnId: string;
  /** Deltas sorted by seq, without duplicates. */
  deltas: readonly Delta[];
  text: string;
  /** Where each delta's text starts in `text` (a non-text delta: the length so far), so the text after any seq is a slice. */
  textStarts: readonly number[];
  reasoning: string;
  lastSeq: number;
  /** Deltas before the first one here are gone (`/stream` said `truncated`): the text has a hole at its start. */
  gap: boolean;
}

export interface ConnectionState {
  /** "idle" before anything subscribed. */
  status: EventStreamStatus | "idle";
  attempt: number;
  /** Epoch ms of the next reconnect try, while reconnecting. */
  nextRetryAt: number | null;
}

export interface LiveState {
  connection: ConnectionState;
  /** The runner is retrying the running turn of a line (`turn.retrying`). */
  retrying: Readonly<Record<string, TurnRetrying>>;
  /** Per line: the reply being streamed. */
  streams: Readonly<Record<string, StreamState>>;
  /** Per line: the last turn that finished; its late deltas are ignored. */
  finished: Readonly<Record<string, string>>;
  /** Bumped after a reconnect or `stream.lagged`: streams must be read again. */
  resyncEpoch: number;
  /** A send or turn action was refused with 403 `forbidden`. */
  forbidden: boolean;
  /** Lines the server says should be summarised (`summary.due`, B8.2), until a newer summary or the user answers. */
  summaryDue: Readonly<Record<string, true>>;
  /** Background jobs that failed (B9 phase C `job.failed`), by job id: whoever started one can stop waiting. */
  failedJobs: Readonly<Record<string, JobFailed>>;
  /** Branch lines a delete was asked for and not sent yet (F18): the outline leaves them out until it is sent or undone. */
  hidden: ReadonlySet<string>;
}

/** How many `job.failed` events the store keeps (the newest). */
export const FAILED_JOBS_KEPT = 50;

export interface LiveStore {
  getState(): LiveState;
  subscribe(listener: () => void): () => void;
  /** `gap`: the deltas are what `/stream` still had after it said `truncated`. */
  addDeltas(lineId: string, deltas: readonly Delta[], options?: { gap?: boolean }): void;
  /** A pending reply with this id appeared: a turn id that finished earlier may stream again. */
  beginTurn(lineId: string, turnId: string): void;
  /** The turn ended (done, failed or cancelled): drop its stream and retry state. */
  finishTurn(lineId: string, turnId: string): void;
  /** Lines that were deleted: forget everything about them. False when every one of them was already forgotten. */
  forgetLines(lineIds: readonly string[]): boolean;
  /** Hides branch lines from the outline (a delete waiting to be sent), or shows them again (it was undone or refused). */
  setHidden(lineIds: readonly string[], hidden: boolean): void;
  setConnection(status: EventStreamStatus | "idle", info?: ReconnectInfo): void;
  setRetrying(lineId: string, retrying: TurnRetrying): void;
  /** `summary.due` arrived (true), or the offer was answered or a newer summary came (false). */
  setSummaryDue(lineId: string, due: boolean): void;
  jobFailed(failure: JobFailed): void;
  /** Events were missed: retry banners and streams are stale; they are rebuilt from the server. */
  resync(): void;
  markForbidden(): void;
  /** The event subscription registers how to reconnect now ("retry now" on the banner). */
  bindReconnect(reconnect: (() => void) | null): void;
  reconnect(): void;
}

const NONE_HIDDEN: ReadonlySet<string> = new Set();

const INITIAL: LiveState = {
  hidden: NONE_HIDDEN,
  connection: { status: "idle", attempt: 0, nextRetryAt: null },
  retrying: {},
  summaryDue: {},
  failedJobs: {},
  streams: {},
  finished: {},
  resyncEpoch: 0,
  forbidden: false,
};

function without<T>(record: Readonly<Record<string, T>>, keys: readonly string[]): Readonly<Record<string, T>> {
  if (!keys.some((key) => key in record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

/** A stream rebuilt from sorted deltas (the slow path, after a late or duplicate delta). */
function rebuild(stream: StreamState, deltas: readonly Delta[]): StreamState {
  let text = "";
  let reasoning = "";
  const textStarts: number[] = [];
  for (const delta of deltas) {
    textStarts.push(text.length);
    if (delta.kind === "text") text += delta.text;
    else if (delta.kind === "reasoning") reasoning += delta.text;
  }
  return { ...stream, deltas, text, reasoning, textStarts };
}

const emptyStream = (turnId: string): StreamState => ({ turnId, deltas: [], text: "", textStarts: [], reasoning: "", lastSeq: 0, gap: false });

/**
 * Merges deltas of one turn into a stream; null when nothing new arrived.
 * In-order deltas (seq above the last one) are appended — one copy of the
 * arrays per batch, not per delta; only an out-of-order or duplicate delta
 * takes the slow path (dedupe, sort, rebuild the text).
 */
export function mergeDeltas(current: StreamState | undefined, turnId: string, incoming: readonly Delta[], gap = false): StreamState | null {
  let stream: StreamState = current && current.turnId === turnId ? current : emptyStream(turnId);
  let changed = stream !== current || (gap && !stream.gap);
  const appended: Delta[] = [];
  const starts: number[] = [];
  const late: Delta[] = [];
  let { text, reasoning, lastSeq } = stream;
  for (const delta of incoming) {
    if (delta.turnId !== turnId) continue;
    if (delta.seq <= lastSeq) {
      late.push(delta);
      continue;
    }
    appended.push(delta);
    starts.push(text.length);
    if (delta.kind === "text") text += delta.text;
    else if (delta.kind === "reasoning") reasoning += delta.text;
    lastSeq = delta.seq;
  }
  if (appended.length > 0) {
    stream = { ...stream, deltas: [...stream.deltas, ...appended], textStarts: [...stream.textStarts, ...starts], text, reasoning, lastSeq };
    changed = true;
  }
  if (late.length > 0) {
    const seen = new Set(stream.deltas.map((delta) => delta.seq));
    const fresh = late.filter((delta) => !seen.has(delta.seq));
    if (fresh.length > 0) {
      stream = rebuild(stream, [...stream.deltas, ...fresh].sort((a, b) => a.seq - b.seq));
      changed = true;
    }
  }
  if (!changed) return null;
  return gap && !stream.gap ? { ...stream, gap: true } : stream;
}

/** The streamed text after `seq`: a binary search over the sorted deltas and one slice. */
export function streamTextAfter(stream: StreamState, seq: number): string {
  let low = 0;
  let high = stream.deltas.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((stream.deltas[middle]?.seq ?? Infinity) > seq) high = middle;
    else low = middle + 1;
  }
  return low < stream.textStarts.length ? stream.text.slice(stream.textStarts[low]) : "";
}

export function createLiveStore(): LiveStore {
  let state = INITIAL;
  let reconnectNow: (() => void) | null = null;
  /** Ids of deleted lines (never reused), so a delete's result and its event do the work once. */
  const deleted = new Set<string>();
  const listeners = new Set<() => void>();

  const set = (next: LiveState): void => {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  function addDeltas(lineId: string, deltas: readonly Delta[], options: { gap?: boolean } = {}): void {
    let next = state;
    for (const turnId of new Set(deltas.map((delta) => delta.turnId))) {
      if (next.finished[lineId] === turnId) continue;
      const merged = mergeDeltas(next.streams[lineId], turnId, deltas, options.gap);
      if (!merged) continue;
      const retrying = next.retrying[lineId]?.turnId === turnId ? without(next.retrying, [lineId]) : next.retrying;
      next = { ...next, streams: { ...next.streams, [lineId]: merged }, retrying };
    }
    set(next);
  }

  function finishTurn(lineId: string, turnId: string): void {
    const streams = state.streams[lineId] ? without(state.streams, [lineId]) : state.streams;
    const retrying = state.retrying[lineId]?.turnId === turnId ? without(state.retrying, [lineId]) : state.retrying;
    if (state.finished[lineId] === turnId && streams === state.streams && retrying === state.retrying) return;
    set({ ...state, streams, retrying, finished: { ...state.finished, [lineId]: turnId } });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addDeltas,
    beginTurn(lineId, turnId) {
      if (state.finished[lineId] === turnId) set({ ...state, finished: without(state.finished, [lineId]) });
    },
    finishTurn,
    forgetLines(lineIds) {
      const fresh = lineIds.filter((id) => !deleted.has(id));
      if (fresh.length === 0) return false;
      for (const id of fresh) deleted.add(id);
      const streams = without(state.streams, lineIds);
      const retrying = without(state.retrying, lineIds);
      const finished = without(state.finished, lineIds);
      const summaryDue = without(state.summaryDue, lineIds);
      const gone = new Set(lineIds);
      const failures = Object.entries(state.failedJobs);
      const failedJobs = failures.some(([, failure]) => gone.has(failure.lineId)) ? Object.fromEntries(failures.filter(([, failure]) => !gone.has(failure.lineId))) : state.failedJobs;
      if (streams === state.streams && retrying === state.retrying && finished === state.finished && summaryDue === state.summaryDue && failedJobs === state.failedJobs) return true;
      set({ ...state, streams, retrying, finished, summaryDue, failedJobs });
      return true;
    },
    setHidden(lineIds, hide) {
      // A mark left on a line that was deleted since is harmless: ids are never reused.
      const hidden = new Set(state.hidden);
      for (const id of lineIds) {
        if (hide) hidden.add(id);
        else hidden.delete(id);
      }
      set({ ...state, hidden });
    },
    setConnection(status, info) {
      // A connection attempt after a drop keeps counting, so the banner does not flicker between tries.
      const attempt = info?.attempt ?? (status === "connecting" ? state.connection.attempt : 0);
      const connection: ConnectionState = { status, attempt, nextRetryAt: info?.nextRetryAt ?? null };
      const current = state.connection;
      if (current.status === connection.status && current.attempt === connection.attempt && current.nextRetryAt === connection.nextRetryAt) return;
      set({ ...state, connection });
    },
    setRetrying(lineId, retrying) {
      set({ ...state, retrying: { ...state.retrying, [lineId]: retrying } });
    },
    jobFailed(failure) {
      // Only the newest few: a failure matters to whoever is waiting for that job now (R9 G4).
      const kept = Object.entries(state.failedJobs).filter(([jobId]) => jobId !== failure.jobId).slice(-(FAILED_JOBS_KEPT - 1));
      set({ ...state, failedJobs: Object.fromEntries([...kept, [failure.jobId, failure]]) });
    },
    setSummaryDue(lineId, due) {
      if (Boolean(state.summaryDue[lineId]) === due) return;
      set({ ...state, summaryDue: due ? { ...state.summaryDue, [lineId]: true } : without(state.summaryDue, [lineId]) });
    },
    resync() {
      // Failures seen before the gap are stale: a waiter reads the server again (R9 G4).
      set({ ...state, retrying: {}, streams: {}, failedJobs: {}, resyncEpoch: state.resyncEpoch + 1 });
    },
    markForbidden() {
      if (!state.forbidden) set({ ...state, forbidden: true });
    },
    bindReconnect(reconnect) {
      reconnectNow = reconnect;
    },
    reconnect() {
      reconnectNow?.();
    },
  };
}
