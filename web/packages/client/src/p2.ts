/**
 * Pure logic of the P2 interface (F5 phase 1): the goal's text, reading the
 * B9 suggestions (goal proposals, drift hints, relations) and how long a
 * branch has been idle. The map's relation helpers are in `p2-map.ts` (they
 * load with the map only).
 */
import { text } from "./p2-drift";
import { RELATION_KINDS, type RelationKind, type Suggestion } from "./types";
import { oneOf } from "./wire";

export { driftByMessage, driftOf, type Drift } from "./p2-drift";

/** domain `Limits.Goal.TextMaxRunes`. */
export const GOAL_TEXT_MAX = 300;
/** The server's default relation label limit (`GET /relations` reports the real one). */
export const RELATION_LABEL_MAX = 200;

const DAY_MS = 86_400_000;

/** The goal as the server stores it: one line, spaces collapsed. */
export function goalLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export type GoalProblem = "required" | "tooLong";

/** Why a goal would be refused, or null. */
export function validateGoal(text: string, max = GOAL_TEXT_MAX): GoalProblem | null {
  const line = goalLine(text);
  if (line === "") return "required";
  return Array.from(line).length > max ? "tooLong" : null;
}

/** A `goal_propose` suggestion's text; null for any other suggestion. */
export function goalProposalOf(suggestion: Pick<Suggestion, "feature" | "kind" | "payload">): { text: string } | null {
  if (suggestion.feature !== "goal" || suggestion.kind !== "goal_propose") return null;
  const proposed = suggestion.payload.text;
  return typeof proposed === "string" && proposed !== "" ? { text: proposed } : null;
}

/** What a `relation` suggestion proposes: two branches of the tree, a label and (B15) a kind. */
export interface RelationProposal {
  fromLineId: string;
  toLineId: string;
  fromTitle: string;
  toTitle: string;
  label: string;
  /** `related` when the payload has none or an unknown one. */
  relationKind: RelationKind;
}

export function relationSuggestionOf(suggestion: Pick<Suggestion, "feature" | "kind" | "payload">): RelationProposal | null {
  if (suggestion.feature !== "relations" || suggestion.kind !== "relation") return null;
  const payload = suggestion.payload;
  const proposal = { fromLineId: text(payload.fromLineId), toLineId: text(payload.toLineId), fromTitle: text(payload.fromTitle), toTitle: text(payload.toTitle), label: text(payload.label), relationKind: oneOf(payload.relationKind, RELATION_KINDS, "related") };
  return proposal.fromLineId && proposal.toLineId ? proposal : null;
}

/** Whole days since `lastActivityAt` (0 when unknown). */
export function idleDays(lastActivityAt: string, now: number = Date.now()): number {
  const at = Date.parse(lastActivityAt);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / DAY_MS));
}
