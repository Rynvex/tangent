/**
 * The error envelope of the HTTP API (DESIGN §7): `{ error, code, ...extra }`.
 * Codes mirror `domain/errors.go`; a host's own codes (from its `TurnGate`)
 * may appear too, so `code` stays a plain string on the error object.
 */

/** Every code `domain/errors.go` defines (kept in sync by errors.test.ts). */
export const DOMAIN_ERROR_CODES = [
  // Opening branches.
  "depth_soft_limit",
  "depth_hard_limit",
  "branch_limit",
  "tree_limit",
  "parent_closed",
  "anchor_not_found",
  "kind_unsupported",
  "suggestion_not_found",
  // Turns and the state of a branch.
  "branch_closed",
  "archived",
  "aside_answered",
  "branch_busy",
  "branch_drafting",
  // Drafting and merging.
  "no_messages",
  "draft_not_pending",
  "parent_busy",
  "parent_moved",
  "invalid_card",
  "invalid_parent_tip",
  // Moving, promoting and deleting.
  "invalid_count",
  "not_enough_messages",
  "move_must_start_with_user",
  "move_protected_message",
  "move_no_anchor",
  "source_busy",
  "promote_not_top_level",
  "open_branches_on_old_tail",
  "session_busy",
  "branch_not_main_line",
  "branch_not_deletable",
  // Notes.
  "note_not_found",
  "note_superseded",
  "note_limit",
  "invalid_note",
  "note_source_not_found",
  // Chapters.
  "milestone_not_found",
  "milestone_exists",
  "milestone_limit",
  "message_not_found",
  "invalid_milestone",
  // Codes tangent adds.
  "turn_pending",
  "turn_not_pending",
  "invalid_transition",
  "line_not_found",
  "branch_not_found",
  "invalid_input",
  "job_not_found",
  "job_not_pending",
  "concurrent_change",
  "id_unavailable",
  // Feature modules (DESIGN §11): reading a turned-off feature's data.
  "feature_disabled",
  // B4.1: input limits (extra {field, max}), allowed models, retrying a failed turn.
  "too_long",
  "model_not_allowed",
  "nothing_to_retry",
  // B8 phase A: leaves, the parking lot and the suggestion inbox.
  "invalid_leaf",
  "leaf_not_found",
  "seed_not_found",
  "seed_not_open",
  "seed_limit",
  "suggestion_not_open",
  // B9 phase A: the goal and relations.
  "goal_not_found",
  "relation_not_found",
  "relation_exists",
  "relation_limit",
  // B9 phase C: groups.
  "group_not_found",
  "group_not_active",
  "invalid_group",
  "group_limit",
  // B10 phase A: folds (tags reuse invalid_input, message_not_found, archived, feature_disabled).
  "fold_not_found",
  "fold_overlap",
  "fold_limit",
  "invalid_fold",
  // B10 phase B: diverge and converge.
  "comparison_not_found",
  "comparison_not_ready",
  "comparison_decided",
  "invalid_comparison",
  // B10 phase C: memory.
  "memory_not_found",
  "memory_superseded",
  "invalid_memory",
  // B13: memos (not sent to the AI).
  "memo_not_found",
  "memo_limit",
  // B24: the glossary (`term_exists` carries the stored term as extra `term`).
  "term_not_found",
  "term_limit",
  "term_exists",
  // B25: import batches.
  "import_batch_not_found",
  // B7.1: the host's Embedder failed (503; try again later).
  "embedder_unavailable",
] as const;

/**
 * Codes httpapi and the reference server add (docs/devlog/B4-api.md), outside
 * `domain/errors.go`; kept apart so the drift test above stays exact.
 */
export const HTTP_ERROR_CODES = [
  /** 401: the host's `Scope` refused the request (or the reference server's token check). */
  "unauthorized",
  /** 403: a write by an identity that may only read (`CanWrite` false). */
  "forbidden",
  /** 413: the body is over the server's limit. */
  "payload_too_large",
  /** 404: no such route, including the routes of a feature that is not configured. */
  "not_found",
  /** 503: the work could not be handed to the dispatcher, or the event stream is closed. */
  "unavailable",
  /** 500: anything that is not a domain error; the text is always "internal error". */
  "internal",
  /** 429 with `Retry-After` (reference server); `extra.retryAfterSeconds` carries the header. */
  "rate_limited",
  /** 415: the request body is not `application/json` (B4.1). */
  "unsupported_media_type",
] as const;

/** Codes this client raises itself, without a server envelope. */
export const CLIENT_ERROR_CODES = [
  /** A 2xx body that is not valid JSON. */
  "invalid_response",
  /** A path id the client refuses to send ("", "." or ".."). */
  "invalid_id",
] as const;

/** A domain code (now including `feature_disabled`, DESIGN §11), an httpapi code or a client code. */
export type TangentErrorCode = (typeof DOMAIN_ERROR_CODES)[number] | (typeof HTTP_ERROR_CODES)[number] | (typeof CLIENT_ERROR_CODES)[number];

/** Every code the library knows; a host may still send its own (DESIGN §12). */
export const ALL_ERROR_CODES: readonly TangentErrorCode[] = [...DOMAIN_ERROR_CODES, ...HTTP_ERROR_CODES, ...CLIENT_ERROR_CODES];

export { ERROR_TEXT_MAX, errorFromResponse } from "./error-response";

export type ErrorExtra = Readonly<Record<string, unknown>>;

/** Thrown for every non-2xx response of the Tangent API. */
export class TangentError extends Error {
  readonly status: number;
  /** The envelope's `code`; "" when the body carried none (e.g. a proxy error page). Status 0: raised before any request. */
  readonly code: string;
  /** Every envelope field besides `error` and `code` (limits, ids, problems…). */
  readonly extra: ErrorExtra;

  constructor(status: number, message: string, code = "", extra: ErrorExtra = {}) {
    super(message);
    this.name = "TangentError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** True when `error` is a TangentError with the given code. */
export function hasErrorCode(error: unknown, code: TangentErrorCode): error is TangentError {
  return error instanceof TangentError && error.code === code;
}

/** A number field of the error's extra, or `fallback` when absent or not a number. */
export function extraNumber(error: TangentError, key: string, fallback: number): number {
  const value = error.extra[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
