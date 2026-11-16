/**
 * `errorFromResponse` on its own (F20b), re-exported by `errors.ts` so every import path stays the
 * same. Only the HTTP client and the SSE stream build errors from responses; the UI in the main
 * chunk needs `TangentError` and `hasErrorCode`, and with `errorFromResponse` in `errors.ts` a
 * host that loads the client lazily still carried it in its main chunk.
 */
import { TangentError } from "./errors";

/** The longest server text (in characters) a non-JSON error body may put into a message. */
export const ERROR_TEXT_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/**
 * Builds the error for a failed response from its status, status text, raw
 * body text and content type. A JSON envelope supplies message, code and
 * extra. Any other body is only quoted when it is `text/plain` (cut to
 * ERROR_TEXT_MAX); an HTML error page from a proxy never becomes the message.
 */
export function errorFromResponse(status: number, statusText: string, bodyText: string, contentType = ""): TangentError {
  const fallback = statusText || `HTTP ${status}`;
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    const plain = contentType.toLowerCase().startsWith("text/plain") ? bodyText.trim() : "";
    return new TangentError(status, plain ? truncate(plain, ERROR_TEXT_MAX) : fallback);
  }
  const { error, code, ...extra } = parsed;
  const message = typeof error === "string" && error !== "" ? error : fallback;
  return new TangentError(status, message, typeof code === "string" ? code : "", extra);
}
