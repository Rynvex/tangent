/**
 * 前提已更新 (S12): why a returned branch's conclusion may no longer hold —
 * a note it wrote was replaced by a newer one, or a relation marks something
 * as contradicting it. A relation's kind says so (B15 `contradicts`); one
 * from a server before B15 has no kind, and then its label decides
 * (矛盾 / contradict). The user can set reasons aside ("知道了"); a new
 * reason shows again.
 */
import type { BranchView, Link, Note } from "./types";

export { cardEditReasons } from "./card-edit-reasons";

export type StaleReason =
  | { kind: "noteSuperseded"; id: string; note: Note; replacement: Note | null }
  | { kind: "contradicts"; id: string; relation: Link }
  /** B17 (decision #6): the conclusion card this branch was opened from was edited after it opened. */
  | { kind: "cardEdited"; id: string; cardMessageId: string; cardLineId: string; title: string };

/** Without a kind: labels that mark a relation as a contradiction (zh-TW and English); a negated one (「不矛盾」, "does not contradict") does not. */
const CONTRADICTION = /矛盾|衝突|contradict/i;
const NEGATED = /(不|沒有|無|並非)(矛盾|衝突)|(not|n't|no)\s+contradict/i;

export function isContradiction(relation: Link): boolean {
  if (relation.kind !== "relation") return false;
  if (relation.relationKind !== undefined) return relation.relationKind === "contradicts";
  return CONTRADICTION.test(relation.label) && !NEGATED.test(relation.label);
}

/** The reason's key for dismissals: one per note or relation. */
export const staleReasonId = (reason: StaleReason): string => reason.id;

/**
 * The reasons of one branch: notes it (or its card) wrote that are now
 * superseded, and contradiction relations pointing at the branch or its
 * card. Only returned branches have a premise to change; `dismissed` holds
 * reason ids the user set aside.
 */
export function staleReasons(branch: BranchView, notes: readonly Note[], relations: readonly Link[], dismissed: ReadonlySet<string> = new Set()): StaleReason[] {
  if (branch.status !== "merged") return [];
  const byId = new Map(notes.map((note) => [note.id, note]));
  const fromBranch = (note: Note) => note.sourceLineId === branch.lineId || (branch.cardMessageId !== "" && note.sourceCardMessageId === branch.cardMessageId);
  const superseded: StaleReason[] = notes
    .filter((note) => note.status === "superseded" && fromBranch(note))
    .map((note) => ({ kind: "noteSuperseded", id: `note:${note.id}`, note, replacement: byId.get(note.supersededBy) ?? null }));
  const contradicts: StaleReason[] = relations
    .filter((relation) => isContradiction(relation) && (relation.toLineId === branch.lineId || (branch.cardMessageId !== "" && relation.toMessageId === branch.cardMessageId)))
    .map((relation) => ({ kind: "contradicts", id: `relation:${relation.id}`, relation }));
  return [...superseded, ...contradicts].filter((reason) => !dismissed.has(reason.id));
}

/** Every returned branch of the outline that has a reason (outline and map marks). */
export function staleBranchIds(branches: readonly BranchView[], notes: readonly Note[], relations: readonly Link[], dismissed: ReadonlySet<string> = new Set()): Set<string> {
  return new Set(branches.filter((branch) => staleReasons(branch, notes, relations, dismissed).length > 0).map((branch) => branch.lineId));
}
