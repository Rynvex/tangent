/**
 * Pure logic of groups and combining (C2, F5 phase 3): what a selection of
 * branches can become, the active group a branch is in, and reading a group
 * suggestion. The server checks everything again (`invalid_group`).
 */
import { DEFAULT_GROUP_LIMITS, GROUP_MIN_MEMBERS, normalizeConflict, type Conflict, type Group } from "./group-routes";
import type { BranchView, Suggestion } from "./types";
import { list, obj, str } from "./wire";

/** Why a selection can be neither grouped nor combined. */
export type SelectionProblem = "tooFew" | "tooMany" | "mixed" | "promoted" | "noEnding" | "inGroup" | "notSiblings" | "aside";

export type SelectionAction = { action: "group" | "combine" } | { action: null; reason: SelectionProblem };

/** A branch's ending as others see it: its leaf, else its card's conclusion. */
export function endingOf(branch: Pick<BranchView, "leaf" | "conclusionLine">): string {
  return branch.leaf?.line || branch.conclusionLine;
}

export function activeGroupOf(lineId: string, groups: readonly Group[]): Group | null {
  return groups.find((group) => group.status === "active" && group.memberLineIds.includes(lineId)) ?? null;
}

/**
 * A group takes ended branches (not promoted to the main line, R8), each
 * with an ending, none already in an active group; a combine takes open siblings that are not asides. Both take
 * 2–12 (DESIGN §12 B9 phase C).
 */
export function selectionAction(selected: readonly BranchView[], groups: readonly Group[]): SelectionAction {
  if (selected.length < GROUP_MIN_MEMBERS) return { action: null, reason: "tooFew" };
  if (selected.length > DEFAULT_GROUP_LIMITS.maxMembers) return { action: null, reason: "tooMany" };
  const open = selected.filter((branch) => branch.status === "open");
  if (open.length === selected.length) {
    if (open.some((branch) => branch.kind === "aside")) return { action: null, reason: "aside" };
    if (new Set(open.map((branch) => branch.parentLineId)).size > 1) return { action: null, reason: "notSiblings" };
    return { action: "combine" };
  }
  if (open.length > 0) return { action: null, reason: "mixed" };
  if (selected.some((branch) => branch.status === "promoted")) return { action: null, reason: "promoted" };
  if (selected.some((branch) => !endingOf(branch))) return { action: null, reason: "noEnding" };
  if (selected.some((branch) => activeGroupOf(branch.lineId, groups))) return { action: null, reason: "inGroup" };
  return { action: "group" };
}

/** One proposed member of a group suggestion. */
export interface GroupProposalMember {
  lineId: string;
  purpose: string;
  ended: boolean;
  leaf: string;
}

export interface GroupProposal {
  title: string;
  members: GroupProposalMember[];
  /** Each with an id, without a choice. */
  conflicts: Conflict[];
}

/** A `group` suggestion's payload; null for any other suggestion. */
export function groupSuggestionOf(suggestion: Pick<Suggestion, "feature" | "kind" | "payload">): GroupProposal | null {
  if (suggestion.feature !== "group" || suggestion.kind !== "group") return null;
  const payload = suggestion.payload;
  return {
    title: str(payload.title),
    members: list(payload.members, (raw) => {
      const member = obj(raw);
      return { lineId: str(member.lineId), purpose: str(member.purpose), ended: member.ended === true, leaf: str(member.leaf) };
    }),
    conflicts: list(payload.conflicts, normalizeConflict),
  };
}

/** What accepting does by default (the server's rule): group when two members ended, else combine the open ones. */
export function suggestedAction(proposal: GroupProposal): "group" | "combine" {
  return proposal.members.filter((member) => member.ended).length >= GROUP_MIN_MEMBERS ? "group" : "combine";
}
