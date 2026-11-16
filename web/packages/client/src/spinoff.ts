/**
 * Pure logic of spinoff (B2) and the tree-balance hint (B4), F4 phase 2.
 * The origin capsule itself comes from the server (`POST /spinoff/preview`, B8.2).
 */
import { normalizeBranchView } from "./branch-normalize";
import { normalizeLine } from "./line-normalize";
import { normalizeLink, type SpinoffMode } from "./spinoff-routes";
import type { BranchKind, BranchStatus, BranchView, Link, LineView, Message, Suggestion } from "./types";
import { count, isObject, strings } from "./wire";

export interface SpinoffModesInput {
  /** The line's branch status; null on a main line. */
  branchStatus: BranchStatus | null;
  kind: BranchKind | null;
  /** The message a fresh conversation would start from; "" when none. */
  atMessageId: string;
}

/** What can be spun off: a whole open branch (not an aside), or a fresh start from a message. */
export function spinoffModes({ branchStatus, kind, atMessageId }: SpinoffModesInput): SpinoffMode[] {
  return [...(branchStatus === "open" && kind !== "aside" ? (["detach"] as const) : []), ...(atMessageId ? (["fresh"] as const) : [])];
}

// Tree balance (rebalance) ---------------------------------------------------------

export const REBALANCE_ACTIONS = ["promote", "spinoff"] as const;
export type RebalanceAction = (typeof REBALANCE_ACTIONS)[number];

export interface Rebalance {
  /** The branch it is about. */
  lineId: string;
  /** `share`: more replies than its parent since the fork; `recent`: the last replies were all here. */
  reason: "share" | "recent";
  branchTurns: number;
  parentTurns: number;
  recentInBranch: boolean;
  /** What can be done now (the server lists only those). */
  actions: RebalanceAction[];
  /** B8.2: the branch hangs on the main line (an older server's payload counts as yes). */
  parentIsMain: boolean;
  /** B8.2: the parent's title when it is a branch. */
  parentTitle: string;
}

/** A tree-balance suggestion's content, or null for any other suggestion. */
export function rebalanceOf(suggestion: Pick<Suggestion, "feature" | "kind" | "lineId" | "payload">): Rebalance | null {
  if (suggestion.feature !== "rebalance" || suggestion.kind !== "promote_or_spinoff") return null;
  const payload = suggestion.payload;
  return {
    lineId: suggestion.lineId,
    reason: payload.reason === "recent" ? "recent" : "share",
    branchTurns: count(payload.branchTurns),
    parentTurns: count(payload.parentTurns),
    recentInBranch: payload.recentInBranch === true,
    actions: strings(payload.actions).filter((action): action is RebalanceAction => (REBALANCE_ACTIONS as readonly string[]).includes(action)),
    parentIsMain: payload.parentIsMain !== false,
    parentTitle: typeof payload.parentTitle === "string" ? payload.parentTitle : "",
  };
}

/** `POST /suggestions/{id}/accept` of a tree-balance suggestion. */
export type RebalanceAcceptBody = { action: "promote" } | { action: "spinoff"; title?: string; copyNotes?: boolean };

export interface RebalanceResult {
  action: RebalanceAction;
  /** promote: the main line; spinoff: the new conversation. */
  line: LineView;
  branch?: BranchView;
  previousMainLine?: BranchView;
  link?: Link;
}

/** The `result` of an accepted tree-balance suggestion, or null when it is something else. */
export function rebalanceResultOf(raw: unknown): RebalanceResult | null {
  if (!isObject(raw) || (raw.action !== "promote" && raw.action !== "spinoff")) return null;
  return {
    action: raw.action,
    line: normalizeLine(raw.line),
    ...(isObject(raw.branch) ? { branch: normalizeBranchView(raw.branch) } : {}),
    ...(isObject(raw.previousMainLine) ? { previousMainLine: normalizeBranchView(raw.previousMainLine) } : {}),
    ...(isObject(raw.link) ? { link: normalizeLink(raw.link) } : {}),
  };
}

/** The marker a spinoff left on a line, newest last (`meta.spunOffTo`); null when none. */
export function lastSpinoff(messages: readonly Message[]): (NonNullable<Message["meta"]["spunOffTo"]> & { markerId: string }) | null {
  const marker = [...messages].reverse().find((message) => message.kind === "branch_marker" && message.meta.spunOffTo);
  return marker?.meta.spunOffTo ? { ...marker.meta.spunOffTo, markerId: marker.id } : null;
}

