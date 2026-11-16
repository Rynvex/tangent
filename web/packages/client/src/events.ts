/**
 * SSE subscription for `GET /events` (DESIGN §6 events, §7 route), read with
 * `fetch` + `ReadableStream` rather than `EventSource` so the host's
 * `headers()` and `credentials` reach the stream (DESIGN §12).
 *
 * Wire format (httpapi `/events`, contract samples `event.*.json`): each SSE
 * message is a JSON envelope `{type, tenant, rootLineId, lineId, data}`, sent
 * with the SSE event name set to `type`; `: connected` and `: keepalive`
 * comments are skipped. Unnamed messages are read too, and an envelope without
 * `type` takes the SSE event name. Every payload is normalized per type.
 *
 * A slow client can miss events (the server drops the oldest): refetch on
 * `onReconnect` and on `stream.lagged`.
 */
import { normalizeBranchView } from "./branch-normalize";
import { errorFromResponse } from "./error-response";
import { normalizeDelta, normalizeLine, normalizeMessage } from "./line-normalize";
import { normalizeLeaf, normalizeLeafDraftError, normalizeSuggestion, type LeafDraftError } from "./p1-routes";
import { normalizeGoal } from "./p2-routes";
import { normalizeGroup, normalizeJobFailed, type Group, type JobFailed } from "./group-routes";
import { normalizeLink } from "./spinoff-routes";
import { normalizeFoldChanged, type FoldChanged } from "./fold-routes";
import { normalizeComparisonChanged, type ComparisonChanged } from "./comparison-routes";
import { normalizeMemoryChanged, type MemoryChanged } from "./memory-routes";
import { normalizeMemoChanged, type MemoChanged } from "./memo-routes";
import type { TermsChanged } from "./glossary-routes";
import { createSseParser, type SseMessage } from "./sse";
import type { BranchView, Delta, Goal, Leaf, Link, LineView, Message, Suggestion } from "./types";
import { count, isObject, obj, oneOf, str, strings, type WireObject } from "./wire";

/** `detached` (B8 phase B): the branch left the tree as a new conversation (spinoff). `kept` (B23): an aside was kept or let go (`branch.keptAt`). */
export const BRANCH_CHANGES = ["created", "moved", "promoted", "draft", "merged", "discarded", "renamed", "detached", "kept"] as const;
export type BranchChange = (typeof BRANCH_CHANGES)[number];

/** Payload per event type (DESIGN §6 table). */
export interface TangentEventDataMap {
  "line.created": LineView;
  "line.updated": LineView;
  "line.deleted": { rootLineId: string; lineIds: string[] };
  "message.created": Message;
  "message.updated": Message;
  "message.delta": Delta;
  "branch.changed": { change: BranchChange; branch: BranchView };
  "notes.changed": { rootLineId: string; revision: number };
  "chapters.changed": { rootLineId: string };
  /** The runner retries a failed turn (429 / 5xx only; DESIGN §12); `nextRetryAt` is RFC 3339, "" when unknown. */
  "turn.retrying": TurnRetrying;
  /**
   * The server dropped events for this client (DESIGN §12, B4 question 5):
   * refetch what is shown. The payload is kept as sent; it may be empty.
   */
  "stream.lagged": StreamLagged;
  /** B8: a suggestion was proposed, accepted, dismissed or expired; a `line.updated` of the main line follows. */
  "suggestion.changed": { rootLineId: string; suggestion: Suggestion };
  /** B8: a branch's leaf was written (merge, discard, PUT, a draft) or deleted (`leaf: null`); no `branch.changed` comes with it. */
  "leaf.changed": { lineId: string; rootLineId: string; leaf: Leaf | null; draftError?: LeafDraftError };
  /** B8: a seed was parked, expanded, noted or dropped; a `line.updated` of the main line follows. */
  "seeds.changed": { rootLineId: string };
  /** B8.2: the line should be summarised (`summary` in suggest mode); offer `POST /compact`. Repeats after each turn while due. */
  "summary.due": { lineId: string; rootLineId: string };
  /** B8 phase B: a link was made (a spinoff or a relation: once for each tree it touches); B9: `deleted` when a relation was removed. */
  "link.changed": { rootLineId: string; link: Link; deleted?: true };
  /** B9: the tree's goal was set (PUT, an accepted proposal, auto mode) or cleared (`goal: null`). */
  "goal.changed": { rootLineId: string; goal: Goal | null };
  /** B9 phase C: a group was made, renamed, dissolved, or its summary started, finished or failed. */
  "group.changed": { rootLineId: string; group: Group };
  /** B9 phase C: a background job failed or timed out (leaf drafts keep `leaf.changed.draftError`). */
  "job.failed": JobFailed;
  /** B10 phase A: a fold was made, written (active), failed, removed or moved with its messages. */
  "fold.changed": FoldChanged;
  /** B10 phase B: a comparison was made (drafting), written (ready), failed or decided; `lineId` is the parent line. */
  "comparison.changed": ComparisonChanged;
  /** B10 phase C: a memory was written, recategorized or replaced (the envelope's line ids are ""). */
  "memory.changed": MemoryChanged;
  /** B13: a memo (not sent to the AI) was written, edited or deleted. */
  "memo.changed": MemoChanged;
  /** B24: a glossary term was saved, edited or deleted (`lineId` is its source line, "" once that is gone). */
  "terms.changed": TermsChanged;
}

/** Payload of `stream.lagged`: whatever the server reports, kept verbatim. */
export type StreamLagged = Readonly<Record<string, unknown>>;

/** Events whose `data` may be absent; it reads as `{}`. */
const OPTIONAL_DATA: ReadonlySet<string> = new Set(["stream.lagged"]);

/** Payload of `turn.retrying`; StatusBanner's `aiError` state takes these fields. */
export interface TurnRetrying {
  turnId: string;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: string;
}

export type TangentEventType = keyof TangentEventDataMap;

export interface TangentEventOf<K extends TangentEventType> {
  type: K;
  tenant: string;
  rootLineId: string;
  lineId: string;
  data: TangentEventDataMap[K];
}

export type TangentEvent = { [K in TangentEventType]: TangentEventOf<K> }[TangentEventType];

export type EventHandlers = { [K in TangentEventType]?: (event: TangentEventOf<K>) => void };

function branchChange(raw: WireObject): TangentEventDataMap["branch.changed"] {
  const change = raw.change;
  if (typeof change !== "string" || !(BRANCH_CHANGES as readonly string[]).includes(change)) {
    throw new Error(`unknown branch change: ${String(change)}`);
  }
  return { change: change as BranchChange, branch: normalizeBranchView(raw.branch) };
}

/** Validates and fills each payload; a payload that is not an object never gets here. */
const DATA_NORMALIZERS: { [K in TangentEventType]: (raw: WireObject) => TangentEventDataMap[K] } = {
  "line.created": normalizeLine,
  "line.updated": normalizeLine,
  "line.deleted": (raw) => ({ rootLineId: str(raw.rootLineId), lineIds: strings(raw.lineIds) }),
  "message.created": normalizeMessage,
  "message.updated": normalizeMessage,
  "message.delta": normalizeDelta,
  "branch.changed": branchChange,
  "notes.changed": (raw) => ({ rootLineId: str(raw.rootLineId), revision: count(raw.revision) }),
  "chapters.changed": (raw) => ({ rootLineId: str(raw.rootLineId) }),
  "turn.retrying": (raw) => ({ turnId: str(raw.turnId), attempt: count(raw.attempt), maxAttempts: count(raw.maxAttempts), nextRetryAt: str(raw.nextRetryAt) }),
  "stream.lagged": (raw) => ({ ...raw }),
  "suggestion.changed": (raw) => ({ rootLineId: str(raw.rootLineId), suggestion: normalizeSuggestion(raw.suggestion) }),
  "leaf.changed": (raw) => {
    const draftError = normalizeLeafDraftError(raw.draftError);
    return { lineId: str(raw.lineId), rootLineId: str(raw.rootLineId), leaf: isObject(raw.leaf) ? normalizeLeaf(raw.leaf) : null, ...(draftError ? { draftError } : {}) };
  },
  "seeds.changed": (raw) => ({ rootLineId: str(raw.rootLineId) }),
  "summary.due": (raw) => ({ lineId: str(raw.lineId), rootLineId: str(raw.rootLineId) }),
  "link.changed": (raw) => ({ rootLineId: str(raw.rootLineId), link: normalizeLink(raw.link), ...(raw.deleted === true ? { deleted: true as const } : {}) }),
  "goal.changed": (raw) => ({ rootLineId: str(raw.rootLineId), goal: isObject(raw.goal) ? normalizeGoal(raw.goal) : null }),
  "group.changed": (raw) => ({ rootLineId: str(raw.rootLineId), group: normalizeGroup(raw.group) }),
  "job.failed": normalizeJobFailed,
  "fold.changed": normalizeFoldChanged,
  "comparison.changed": normalizeComparisonChanged,
  "memory.changed": normalizeMemoryChanged,
  "memo.changed": normalizeMemoChanged,
  // Read here, not in glossary-routes.ts: the event stream is in every bundle, the glossary's readers only where a client calls them.
  "terms.changed": (raw) => ({ rootLineId: str(raw.rootLineId), termId: str(raw.termId), change: oneOf(raw.change, ["created", "updated", "deleted"], "updated") }),
};

export const EVENT_TYPES = Object.keys(DATA_NORMALIZERS) as readonly TangentEventType[];

const DEFAULT_SSE_EVENT = "message";

function isEventType(value: unknown): value is TangentEventType {
  return typeof value === "string" && Object.hasOwn(DATA_NORMALIZERS, value);
}

function makeEvent<K extends TangentEventType>(type: K, body: WireObject, data: WireObject): TangentEventOf<K> {
  return { type, tenant: str(body.tenant), rootLineId: str(body.rootLineId), lineId: str(body.lineId), data: DATA_NORMALIZERS[type](data) };
}

/** Parses one SSE message into a validated event; throws on malformed input. */
export function parseEvent(sseName: string, raw: string): TangentEvent {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error("event is not a JSON object");
  const type = parsed.type ?? (sseName === DEFAULT_SSE_EVENT ? undefined : sseName);
  if (!isEventType(type)) throw new Error(`unknown event type: ${String(type)}`);
  const missing = parsed.data === undefined || parsed.data === null;
  if (!isObject(parsed.data) && !(missing && OPTIONAL_DATA.has(type))) throw new Error(`event ${type} has no data object`);
  // makeEvent ties the payload to `type`; TS cannot narrow the union from a generic key.
  return makeEvent(type, parsed, obj(parsed.data)) as TangentEvent;
}

export type EventStreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/** With status "reconnecting": the 1-based attempt about to be made and when. */
export interface ReconnectInfo {
  attempt: number;
  /** Epoch milliseconds of the next try. */
  nextRetryAt: number;
}

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** 0..1: each delay is cut by up to this share at random, so clients do not reconnect in step. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.5 };

/** A connection that stays open this long (or delivers a message) resets the backoff. */
export const DEFAULT_STABLE_MS = 5000;

export interface SubscribeEventsOptions {
  /** Usually `client.eventsUrl()`; prefer `client.subscribe()`, which fills url, headers and credentials. */
  url: string;
  handlers: EventHandlers;
  /** Called for every valid event, after its typed handler. */
  onEvent?: (event: TangentEvent) => void;
  /** `info` is set with "reconnecting". */
  onStatus?: (status: EventStreamStatus, info?: ReconnectInfo) => void;
  /** The stream is open again after a drop; events were missed, so refetch what is shown. */
  onReconnect?: () => void;
  /**
   * A malformed or unknown event (with its raw data), a throwing handler, or a
   * failed connection attempt (raw ""). The subscription keeps going.
   */
  onError?: (error: Error, raw: string) => void;
  headers?: () => HeadersInit;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
  backoff?: Partial<BackoffOptions>;
  stableMs?: number;
  /** Defaults to Math.random (jitter). */
  random?: () => number;
  /** Default to the global timers. */
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface EventSubscription {
  close(): void;
  /** Reconnect now (the banner's "retry now"): skips a pending backoff wait, or drops and reopens the stream. */
  reconnect(): void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The delay before reconnect attempt `attempt` (0-based). */
export function backoffDelay(attempt: number, backoff: BackoffOptions, random: number): number {
  const capped = Math.min(backoff.maxMs, backoff.initialMs * backoff.factor ** attempt);
  return Math.round(capped * (1 - backoff.jitter * random));
}

/** Opens the stream and keeps it open, reconnecting with jittered exponential backoff. */
export function subscribeEvents(options: SubscribeEventsOptions): EventSubscription {
  const backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  const stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
  const random = options.random ?? Math.random;
  const fetchFn: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const schedule = options.setTimeout ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const cancel = options.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  let closed = false;
  let attempt = 0;
  let hasOpened = false;
  let controller: AbortController | null = null;
  let retryTimer: unknown = null;
  let stableTimer: unknown = null;
  /** The current connection was dropped on purpose by reconnect(): reopen at once instead of backing off. */
  let reopenNow = false;

  const report = (error: unknown, raw: string): void => options.onError?.(asError(error), raw);

  const deliver = (message: SseMessage): void => {
    attempt = 0;
    let event: TangentEvent;
    try {
      event = parseEvent(message.event, message.data);
    } catch (error) {
      return report(error, message.data);
    }
    try {
      (options.handlers[event.type] as ((event: TangentEvent) => void) | undefined)?.(event);
    } catch (error) {
      report(error, message.data);
    }
    try {
      options.onEvent?.(event);
    } catch (error) {
      report(error, message.data);
    }
  };

  const clearStable = (): void => {
    if (stableTimer !== null) cancel(stableTimer);
    stableTimer = null;
  };

  const opened = (): void => {
    options.onStatus?.("open");
    if (hasOpened) options.onReconnect?.();
    hasOpened = true;
    stableTimer = schedule(() => {
      stableTimer = null;
      attempt = 0;
    }, stableMs);
  };

  const reconnectLater = (): void => {
    const delay = backoffDelay(attempt, backoff, random());
    attempt += 1;
    options.onStatus?.("reconnecting", { attempt, nextRetryAt: Date.now() + delay });
    retryTimer = schedule(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const parser = createSseParser(deliver);
    const decoder = new TextDecoder();
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done || closed) return;
      parser.push(decoder.decode(value, { stream: true }));
    }
  }

  async function connect(): Promise<void> {
    if (closed) return;
    const current = new AbortController();
    controller = current;
    options.onStatus?.("connecting");
    const headers = new Headers(options.headers?.());
    headers.set("Accept", "text/event-stream");
    try {
      const response = await fetchFn(options.url, {
        headers,
        signal: current.signal,
        cache: "no-store",
        ...(options.credentials ? { credentials: options.credentials } : {}),
      });
      if (!response.ok) {
        throw errorFromResponse(response.status, response.statusText, await response.text(), response.headers.get("Content-Type") ?? "");
      }
      if (!response.body) throw new Error("the event stream response has no body");
      opened();
      await readStream(response.body);
    } catch (error) {
      if (!closed && !reopenNow) report(error, "");
    }
    clearStable();
    if (closed) return;
    if (reopenNow) {
      reopenNow = false;
      void connect();
      return;
    }
    reconnectLater();
  }

  void connect();

  return {
    reconnect() {
      if (closed) return;
      attempt = 0;
      if (retryTimer !== null) {
        cancel(retryTimer);
        retryTimer = null;
        void connect();
        return;
      }
      reopenNow = true;
      controller?.abort();
    },
    close() {
      if (closed) return;
      closed = true;
      if (retryTimer !== null) cancel(retryTimer);
      clearStable();
      controller?.abort();
      controller = null;
      options.onStatus?.("closed");
    },
  };
}
