/**
 * The conversation on screen as the address bar says it (F18 §2.4):
 * `?line=<lineId>&m=<messageId>`. Every other parameter of the demo (`frame`,
 * `focus`, `theme`, …) belongs to someone else and passes through untouched.
 */

export interface UrlState {
  /** The line on screen; null means the default (the list's first conversation). */
  line: string | null;
  /** The message to bring into view on that line. Never set without a line. */
  message: string | null;
}

export type HistoryAction = "push" | "replace" | "none";

const LINE_PARAM = "line";
const MESSAGE_PARAM = "m";

export function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const line = params.get(LINE_PARAM) || null;
  return { line, message: line ? params.get(MESSAGE_PARAM) || null : null };
}

/** `href` with `state` written in; returns path + query + hash, ready for `pushState`. */
export function urlWithState(href: string, state: UrlState): string {
  const url = new URL(href);
  if (state.line) {
    url.searchParams.set(LINE_PARAM, state.line);
    if (state.message) url.searchParams.set(MESSAGE_PARAM, state.message);
    else url.searchParams.delete(MESSAGE_PARAM);
  } else {
    url.searchParams.delete(LINE_PARAM);
    url.searchParams.delete(MESSAGE_PARAM);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A new line is a new place to go back to; a message within the same line is not. */
export function historyActionFor(from: UrlState, to: UrlState): HistoryAction {
  if (from.line !== to.line) return "push";
  return from.message === to.message ? "none" : "replace";
}
