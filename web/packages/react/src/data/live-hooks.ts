/**
 * Hooks over the live store and the event stream (F1): mount
 * `useTangentEvents()` once under the provider; components read streaming
 * text, the A14 banner state and read-only status from here.
 */
import { canWrite, type JobFailed, type Message, type TangentEvent } from "@tangent/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { StatusBannerState } from "../layout/status-banner-model";
import { useTangent } from "../provider";
import { createEventSync, resyncAll } from "./event-sync";
import type { LiveState, StreamState } from "./live-store";
import { useCapabilities, useMessages } from "./queries";

/** Reads a slice of the live store; `select` must return stable references (state slices, primitives). */
export function useLiveState<T>(select: (state: LiveState) => T): T {
  const { live } = useTangent();
  return useSyncExternalStore(
    live.subscribe,
    () => select(live.getState()),
    () => select(live.getState()),
  );
}

/**
 * True when this identity may only read: the host says so, or
 * `/capabilities` reports `permissions.canWrite: false` (B4.1). Only when the
 * server does not report permissions does a 403 on a send or turn action decide.
 */
export function useReadOnly(): boolean {
  const { readOnly } = useTangent();
  const capabilities = useCapabilities();
  const forbidden = useLiveState((state) => state.forbidden);
  const reported = canWrite(capabilities.data);
  return readOnly || (reported === null ? forbidden : !reported);
}

/** Reconnects the event stream now (the banner's "retry now"). */
export function useReconnect(): () => void {
  const { live } = useTangent();
  return live.reconnect;
}

export interface TangentEventsOptions {
  /** Default true; false closes the stream. */
  enabled?: boolean;
  /** Malformed or unknown events and failed connection attempts (`raw` ""); default: warn about malformed events. */
  onError?: (error: Error, raw: string) => void;
  /** Every applied event, after the cache was updated (hosts can react to their own needs). */
  onEvent?: (event: TangentEvent) => void;
}

const warnMalformed = (error: Error, raw: string): void => {
  // Connection failures show in the banner; only a malformed event is worth a console line.
  if (raw !== "") console.warn("[tangent] ignored an event:", error.message);
};

/**
 * Opens `/events` and keeps the cache fresh: each event updates or
 * invalidates queries, deltas (batched per frame) and retries go to the live
 * store, and a reconnect invalidates everything Tangent cached (events were missed).
 */
export function useTangentEvents({ enabled = true, onError = warnMalformed, onEvent }: TangentEventsOptions = {}): void {
  const { client, keys, live } = useTangent();
  const queryClient = useQueryClient();
  // Callbacks in refs: inline functions must not reopen the stream on every render.
  const callbacks = useRef({ onError, onEvent });
  useLayoutEffect(() => {
    callbacks.current = { onError, onEvent };
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const target = { queryClient, keys, live };
    const sync = createEventSync(target);
    const subscription = client.subscribe({
      handlers: {},
      onEvent: (event) => {
        sync.apply(event);
        callbacks.current.onEvent?.(event);
      },
      onStatus: (status, info) => live.setConnection(status, info),
      onReconnect: () => resyncAll(target),
      onError: (error, raw) => callbacks.current.onError(error, raw),
    });
    live.bindReconnect(() => subscription.reconnect());
    return () => {
      live.bindReconnect(null);
      subscription.close();
      sync.dispose();
    };
  }, [enabled, client, keys, live, queryClient]);
}

/**
 * The streamed text of a pending assistant message, or null once it is not
 * pending. On mount (and after a resync) it catches up with `/stream` after
 * the part already saved on the message (`meta.streamSeq`); when
 * `/stream` says `truncated`, the deltas it still has are kept (marked as
 * having a gap) and the messages are read again.
 */
export function useStreamingReply(lineId: string, message: Message): StreamState | null {
  const { client, keys, live } = useTangent();
  const queryClient = useQueryClient();
  const pending = message.status === "pending";
  const epoch = useLiveState((state) => state.resyncEpoch);
  const stream = useLiveState((state) => state.streams[lineId]);

  useEffect(() => {
    if (!pending) return undefined;
    const controller = new AbortController();
    // The server saves the reply so far into the pending message up to `meta.streamSeq` (B4.2):
    // only the tail after it is read, and `truncated` then means a hole after the saved part.
    const afterSeq = message.meta.streamSeq ?? 0;
    client
      .getStream(lineId, afterSeq, { signal: controller.signal })
      .then((page) => {
        live.addDeltas(
          lineId,
          page.deltas.filter((delta) => delta.turnId === message.id),
          { gap: page.truncated },
        );
        if (page.truncated) void queryClient.invalidateQueries({ queryKey: keys.messages(lineId), exact: true });
      })
      .catch(() => undefined); // Aborted or offline: the event stream still delivers new deltas.
    return () => controller.abort();
  }, [pending, lineId, message.id, epoch, client, keys, live, queryClient]);

  return pending && stream?.turnId === message.id ? stream : null;
}

/**
 * The A14 banner for a line: reconnecting, then an AI retry of its running
 * turn (only while that reply is still pending), then read-only, then the limit.
 */
export function useConversationBanner(lineId: string | null, options: { limit?: number | null } = {}): StatusBannerState | null {
  const connection = useLiveState((state) => state.connection);
  const retrying = useLiveState((state) => (lineId ? state.retrying[lineId] : undefined));
  const messages = useMessages(retrying ? lineId : null);
  const readOnly = useReadOnly();
  if (connection.status === "reconnecting" || (connection.status === "connecting" && connection.attempt > 0)) {
    return { kind: "reconnecting", attempt: connection.attempt, nextRetryAt: connection.nextRetryAt };
  }
  const running = retrying && messages.data?.messages.some((message) => message.id === retrying.turnId && message.status === "pending");
  if (retrying && running) return { kind: "aiError", attempt: retrying.attempt, maxAttempts: retrying.maxAttempts, nextRetryAt: retrying.nextRetryAt || null };
  if (readOnly) return { kind: "readonly" };
  if (options.limit) return { kind: "limit", limit: options.limit };
  return null;
}

/** The server asked for this line to be summarised (`summary.due`, B8.2) and nobody answered yet. */
/** The failure of a background job this page started (B9 phase C `job.failed`), or null while none came. */
export function useJobFailure(jobId: string | null): JobFailed | null {
  return useLiveState((state) => (jobId ? (state.failedJobs[jobId] ?? null) : null));
}

export function useSummaryDue(lineId: string | null): boolean {
  return useLiveState((state) => (lineId ? state.summaryDue[lineId] === true : false));
}
