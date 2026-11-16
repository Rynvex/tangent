/**
 * Pure logic of the P1 screens (F4 phase 1): leaves (B1), the parking lot
 * (B3), the suggestion inbox (B5) and the 待處理 tab that holds both.
 */
import { chatNumbers } from "./branch-view";
import { TangentError } from "./errors";
import { isObject } from "./wire";
import type { Leaf, LeafSummary, Message, Seed, Suggestion } from "./types";
import type { DiscardBranchBody } from "./p1-routes";
import { flatten } from "./p1-inbox";

export { hasInbox, inboxCount, SEED_FROM_MESSAGE_CHARS, SEED_TEXT_MAX, seedFromText } from "./p1-inbox";

/** domain.DefaultLimits().Leaf. */
export const LEAF_LINE_MAX = 200;
export const LEAF_BODY_MAX = 4000;
/** domain.DefaultLimits().Parking: the open seeds of one tree (one seed's text: `SEED_TEXT_MAX`). */
export const SEED_OPEN_MAX = 100;
/** From this share of the limit on, the parking lot says it is nearly full. */
const SEED_NEAR_SHARE = 0.9;

const runes = (text: string) => Array.from(text).length;

// Leaves -----------------------------------------------------------------------

/** A leaf's line as the server stores it: one line. */
export function leafLine(text: string): string {
  return flatten(text);
}

export type LeafLineProblem = "empty" | "tooLong" | null;

export function validateLeafLine(text: string, max = LEAF_LINE_MAX): LeafLineProblem {
  const line = leafLine(text);
  if (line === "") return "empty";
  return runes(line) > max ? "tooLong" : null;
}

/**
 * The discard body for a "why not" reason (A6 → B1): a dead-end leaf, or no
 * body at all when the reason is blank (then suggest / auto modes draft one).
 */
export function discardLeafBody(reason: string): DiscardBranchBody | undefined {
  const line = leafLine(reason);
  return line === "" ? undefined : { leaf: { line } };
}

/** How a leaf is shown: an AI draft to confirm (dashed), one AI made in auto mode (marked, editable), or the user's. */
export type LeafPresentation = "draft" | "ai" | "confirmed";

export function leafPresentation(leaf: Pick<LeafSummary, "status"> & Partial<Pick<Leaf, "aiDrafted">>): LeafPresentation {
  if (leaf.status === "draft") return "draft";
  return leaf.aiDrafted ? "ai" : "confirmed";
}

export type LeafField = "kind" | "line" | "body";

/** The refused fields of an `invalid_leaf` error and the server's reason for each. */
export function leafProblems(error: unknown): Partial<Record<LeafField, string>> {
  if (!(error instanceof TangentError) || error.code !== "invalid_leaf" || !Array.isArray(error.extra.problems)) return {};
  const fields: readonly string[] = ["kind", "line", "body"];
  return Object.fromEntries(
    error.extra.problems
      .filter((problem): problem is { field: LeafField; message: string } => isObject(problem) && fields.includes(String(problem.field)) && typeof problem.message === "string")
      .map((problem) => [problem.field, problem.message]),
  );
}

// Seeds ------------------------------------------------------------------------

export type SeedLimitState = "ok" | "near" | "full";

export function seedLimitState(open: number, limit = SEED_OPEN_MAX): SeedLimitState {
  if (open >= limit) return "full";
  return open >= Math.ceil(limit * SEED_NEAR_SHARE) ? "near" : "ok";
}

/** A line whose messages are loaded, to look a seed's message up in. */
export interface LoadedLine {
  lineId: string;
  messages: readonly Message[];
}

/**
 * Where a seed was parked: a main-line message ("#n"), a message of a loaded
 * branch, a message this page has not loaded (`unknown`, no link), or none
 * (parked on a line without messages).
 */
export type SeedOrigin =
  | { kind: "main" | "branch"; lineId: string; messageId: string; n: number }
  | { kind: "unknown"; lineId: null; messageId: string }
  | { kind: "none"; lineId: null; messageId: "" };

export function seedOrigin(seed: Pick<Seed, "anchorMessageId">, rootLineId: string, lines: readonly LoadedLine[]): SeedOrigin {
  const messageId = seed.anchorMessageId;
  if (messageId === "") return { kind: "none", lineId: null, messageId: "" };
  for (const line of lines) {
    const n = chatNumbers(line.messages).get(messageId);
    if (n !== undefined) return { kind: line.lineId === rootLineId ? "main" : "branch", lineId: line.lineId, messageId, n };
  }
  return { kind: "unknown", lineId: null, messageId };
}

// The 待處理 tab ------------------------------------------------------------------

/** The reason a feature gave in its payload, or "". */
export function suggestionReason(suggestion: Pick<Suggestion, "payload">): string {
  const reason = suggestion.payload.reason;
  return typeof reason === "string" ? reason : "";
}
