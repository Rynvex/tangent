/**
 * Which line is on screen, kept in step with the address bar (F18 §2.4).
 * Going to another line pushes a history entry, so the browser's back button
 * returns to where the person was; moving to a message within the line only
 * replaces the entry. Back and forward (`popstate`) bring the screen to what
 * the address says and never write history themselves.
 * The routing stays here in the demo app; `@tangent/react` never sees `window.history`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Navigate } from "./branch-flows";
import type { MessageFocus } from "./focus";
import { historyActionFor, readUrlState, urlWithState, type UrlState } from "./url-state";

type Write = "auto" | "replace";

/** Puts `to` into the address bar; `auto` pushes only when the line changes. */
function writeAddress(to: UrlState, how: Write): void {
  const from = readUrlState(window.location.search);
  const action = how === "replace" ? (historyActionFor(from, to) === "none" ? "none" : "replace") : historyActionFor(from, to);
  if (action === "none") return;
  const url = urlWithState(window.location.href, to);
  if (action === "push") window.history.pushState(window.history.state, "", url);
  else window.history.replaceState(window.history.state, "", url);
}

/** The line on screen and the message to bring into view there. */
export function useNavigation(initial: UrlState) {
  const [current, setCurrent] = useState<string | null>(initial.line);
  const counter = useRef(initial.line && initial.message ? 1 : 0);
  const [focus, setFocus] = useState<MessageFocus | null>(() => (initial.line && initial.message ? { messageId: initial.message, n: counter.current } : null));

  const show = useCallback((state: UrlState) => {
    setCurrent(state.line);
    counter.current += 1;
    setFocus(state.line && state.message ? { messageId: state.message, n: counter.current } : null);
  }, []);

  const navigate: Navigate = useCallback(
    (lineId, messageId) => {
      const state = { line: lineId, message: messageId ?? null };
      writeAddress(state, "auto");
      show(state);
    },
    [show],
  );
  /** Another line in place of the one on screen, with no new entry: the old one is gone (deleted, or never there). */
  const replace = useCallback(
    (lineId: string) => {
      const state = { line: lineId, message: null };
      writeAddress(state, "replace");
      show(state);
    },
    [show],
  );
  /** Back to the default: the first conversation of the list (F7: the one on screen was deleted). */
  const clear = useCallback(() => {
    const state = { line: null, message: null };
    writeAddress(state, "replace");
    show(state);
  }, [show]);

  useEffect(() => {
    const onPopState = () => show(readUrlState(window.location.search));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [show]);

  return { current, focus, navigate, replace, clear };
}

/**
 * The address names the line that is shown, also when it is only the list's
 * first by default: a reload then comes back to the same line even after the
 * list's order moved. It replaces the entry the person is on, never adds one.
 */
export function useShownLineInAddress(shown: string | null): void {
  useEffect(() => {
    if (!shown) return;
    const address = readUrlState(window.location.search);
    if (address.line !== shown) writeAddress({ line: shown, message: null }, "replace");
  }, [shown]);
}
