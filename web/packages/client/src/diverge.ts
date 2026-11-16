/**
 * Pure logic of diverge and converge on screen (D3): a line's diverged
 * branches by the message they came from, whether a set can be compared,
 * and reading the table. The server checks everything again.
 */
import { DEFAULT_COMPARISON_LIMITS, type ComparisonCell, type ComparisonMatrix } from "./comparison-routes";
import type { BranchView } from "./types";

/** The branches of `lineId` that one diverge opened (origin `diverge`), by their fork message, in list order. */
export function divergeGroups(branches: readonly BranchView[], lineId: string): Map<string, BranchView[]> {
  const groups = new Map<string, BranchView[]>();
  for (const branch of branches) {
    if (branch.parentLineId !== lineId || branch.origin !== "diverge") continue;
    groups.set(branch.anchorMessageId, [...(groups.get(branch.anchorMessageId) ?? []), branch]);
  }
  return groups;
}

export type ConvergeProblem = "tooFew" | "tooMany" | "ended";

/** Why these branches cannot be compared (2–5 open branches), or null. */
export function convergeProblem(selected: readonly BranchView[], limits = DEFAULT_COMPARISON_LIMITS): ConvergeProblem | null {
  if (selected.length < limits.minOptions) return "tooFew";
  if (selected.length > limits.maxOptions) return "tooMany";
  return selected.some((branch) => branch.status !== "open") ? "ended" : null;
}

const EMPTY_CELL: ComparisonCell = { score: 0, why: "" };

/** The cell at a row (criterion) and column (option); a missing one is empty. */
export function cellOf(matrix: ComparisonMatrix, row: number, column: number): ComparisonCell {
  return matrix.scores[row]?.[column] ?? EMPTY_CELL;
}

/** The label an option had when compared; "" when it is not one. */
export function optionLabel(matrix: ComparisonMatrix, lineId: string): string {
  return matrix.options.find((option) => option.lineId === lineId)?.label ?? "";
}
