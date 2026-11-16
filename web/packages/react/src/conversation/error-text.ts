/**
 * User-facing text for a failed request (F1): the codes a conversation hits
 * get their own sentence, a host's own codes use the host's text (or the
 * server's), anything else says which code failed. Never shows an HTML page
 * or a stack; `TangentError.message` is already the server's short text.
 */
import { TangentError, extraNumber, type HostErrorText } from "@tangent/client";
import type { MessageKey, Translate } from "../i18n";

/** The server's memo cap (B13), when an error does not say. */
const MEMO_LIMIT_DEFAULT = 500;

const KNOWN: Readonly<Record<string, MessageKey>> = {
  forbidden: "error.forbidden",
  unauthorized: "error.unauthorized",
  unavailable: "error.unavailable",
  archived: "error.archived",
  turn_pending: "error.turnPending",
  // B8 phase A.
  seed_not_open: "error.seedNotOpen",
  seed_not_found: "error.seedNotFound",
  suggestion_not_open: "error.suggestionNotOpen",
  suggestion_not_found: "error.suggestionNotFound",
  leaf_not_found: "error.leafNotFound",
  invalid_leaf: "error.invalidLeaf",
  // B9 phase A.
  goal_not_found: "error.goalNotFound",
  relation_not_found: "error.relationNotFound",
  relation_exists: "error.relationExists",
  // B10 phase A.
  fold_not_found: "error.foldNotFound",
  fold_overlap: "error.foldOverlap",
  invalid_fold: "error.invalidFold",
  // B10 phase B.
  comparison_not_found: "error.comparisonNotFound",
  comparison_not_ready: "error.comparisonNotReady",
  comparison_decided: "error.comparisonDecided",
  invalid_comparison: "error.invalidComparison",
  // B10 phase C.
  memory_not_found: "error.memoryNotFound",
  memory_superseded: "error.memorySuperseded",
  invalid_memory: "error.invalidMemory",
  // B7.1.
  embedder_unavailable: "error.embedderUnavailable",
};

/** domain.DefaultLimits().Parking.MaxOpenPerTree, when the error does not say. */
const SEED_LIMIT_DEFAULT = 100;
/** domain.DefaultLimits().Fold.MaxActivePerLine, when the error does not say. */
const FOLD_LIMIT_DEFAULT = 50;
/** domain.DefaultLimits().Relations.MaxPerTree, when the error does not say. */
const RELATION_LIMIT_DEFAULT = 200;

export function describeError(error: unknown, t: Translate, hostErrorText: HostErrorText = () => undefined): string {
  if (!(error instanceof TangentError)) return t("error.network");
  if (error.code === "rate_limited") return t("error.rateLimited", { seconds: extraNumber(error, "retryAfterSeconds", 1) });
  if (error.code === "seed_limit") return t("error.seedLimit", { limit: extraNumber(error, "limit", SEED_LIMIT_DEFAULT) });
  if (error.code === "fold_limit") return t("error.foldLimit", { limit: extraNumber(error, "limit", FOLD_LIMIT_DEFAULT) });
  if (error.code === "relation_limit") return t("error.relationLimit", { limit: extraNumber(error, "limit", RELATION_LIMIT_DEFAULT) });
  if (error.code === "memo_limit") return t("error.memoLimit", { limit: extraNumber(error, "limit", MEMO_LIMIT_DEFAULT) });
  const known = KNOWN[error.code];
  if (known) return t(known);
  const host = error.code ? hostErrorText(error.code) : undefined;
  if (host) return host;
  if (error.status === 0 || error.status >= 500 || !error.code) return t("error.generic", { code: error.code || String(error.status) });
  return error.message || t("error.generic", { code: error.code });
}
