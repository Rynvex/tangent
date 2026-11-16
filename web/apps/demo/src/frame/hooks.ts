import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

function subscribeResize(callback: () => void): () => void {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

/** The viewport width, updated on resize. */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth);
}

const TOAST_MS = 2800;
/** A toast with an action stays longer, so it can be reached. */
const TOAST_ACTION_MS = 6000;

/** A short message for the live region (mock actions, F0). */
/** A toast's one action (F8: 「看停車場」 after parking a list). */
export interface ToastAction {
  label: string;
  run: () => void;
}

export function useToast(): { message: string | null; action: ToastAction | null; show: (message: string, action?: ToastAction, durationMs?: number) => void } {
  const [toast, setToast] = useState<{ message: string; action: ToastAction | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // F14: an import's toast stays longer (its 復原這次匯入 has to be reachable).
  const show = useCallback((message: string, action?: ToastAction, durationMs?: number) => {
    setToast({ message, action: action ?? null });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), durationMs ?? (action ? TOAST_ACTION_MS : TOAST_MS));
  }, []);
  return { message: toast?.message ?? null, action: toast?.action ?? null, show };
}

/** A settled value and the key (e.g. the line) it was settled for. */
export interface Keyed<T> {
  key: string | null;
  value: T;
}

/** The settled value while it belongs to `key`; for any other key, that key's live value (never a stale one from elsewhere). */
export function settledFor<T>(settled: Keyed<T>, key: string | null, live: T): T {
  return settled.key === key ? settled.value : live;
}

/**
 * The value once it has stopped changing for `ms`, tied to `key`: when the
 * key changes (another line), the new key's value applies at once. A zero
 * delay follows the value directly, so a later switch to a real delay starts
 * from the current value.
 */
export function useKeyedDebounced<T>(key: string | null, value: T, ms: number): T {
  const [settled, setSettled] = useState<Keyed<T>>({ key, value });
  useEffect(() => {
    if (ms <= 0) {
      setSettled({ key, value });
      return undefined;
    }
    const timer = setTimeout(() => setSettled({ key, value }), ms);
    return () => clearTimeout(timer);
  }, [key, value, ms]);
  return ms <= 0 ? value : settledFor(settled, key, value);
}

/** The value once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  return useKeyedDebounced(null, value, ms);
}

/** How close (px) to the bottom still counts as "following the conversation". */
const STICK_SLACK = 48;

/** Where the scroller is now and was at the last scroll event. */
export interface ScrollState {
  top: number;
  lastTop: number;
  height: number;
  client: number;
}

/**
 * Whether the scroller still follows the bottom after a scroll event: back
 * near the bottom pins it; only the reader scrolling up lets go. A scroll
 * that moved down (ours, to the end, before rows took their real height —
 * `content-visibility`) keeps it pinned, so a hint that arrives after a reply
 * (F5 drift) is followed too.
 */
export function stillPinned(pinned: boolean, { top, lastTop, height, client }: ScrollState): boolean {
  if (height - top - client < STICK_SLACK) return true;
  return top < lastTop ? false : pinned;
}

/**
 * Keeps a scroller pinned to the bottom while its content grows (new
 * messages, streamed text), unless the reader scrolled up. Returns the ref
 * for the scroller and one for the content to observe.
 */
export function useStickToBottom<S extends HTMLElement, C extends HTMLElement>(resetKey: string | null) {
  const scroller = useRef<S | null>(null);
  const content = useRef<C | null>(null);
  const pinned = useRef(true);
  useEffect(() => {
    pinned.current = true;
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [resetKey]);
  useEffect(() => {
    const box = scroller.current;
    const inner = content.current;
    if (!box || !inner) return undefined;
    let lastTop = box.scrollTop;
    const onScroll = () => {
      pinned.current = stillPinned(pinned.current, { top: box.scrollTop, lastTop, height: box.scrollHeight, client: box.clientHeight });
      lastTop = box.scrollTop;
    };
    const observer = new ResizeObserver(() => {
      if (!pinned.current) return;
      box.scrollTop = box.scrollHeight;
      // Our own scroll counts as seen: a jump away from the end in the same frame (F18: a pasted address) must read as upward.
      lastTop = box.scrollTop;
    });
    box.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(inner);
    return () => {
      box.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [resetKey]);
  /** Let go of the bottom: the reader (or a jump to a message) chose where to look. */
  const release = useCallback(() => {
    pinned.current = false;
  }, []);
  return { scroller, content, release };
}

/**
 * The last value that was defined: a query reset (F13: after an extract the
 * moved lines' messages are reset and refetched) must not unmount what is
 * showing them for the moment the data is gone.
 */
export function useSticky<T>(value: T | undefined): T | undefined {
  const last = useRef(value);
  if (value !== undefined) last.current = value;
  return last.current;
}
