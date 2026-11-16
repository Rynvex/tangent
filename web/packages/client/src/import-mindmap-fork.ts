/**
 * F17 decision #6: when the round a branch forks after is moved out of its
 * chapter, the branch is re-anchored after the chapter's round before that one
 * (else the chapter's first round) and flagged, so the mind map can show
 * 「分岔點已移動」 until the user confirms it or picks another round. Pure.
 */
import { isBranchRole, type ImportAnalyzeNode, type ImportAnalyzePlan, type ImportAnalyzeUnit } from "./import-analyze";

/** The round to fork after once `fork` left the chapter: its round before `fork`, else its first; null when it has none. */
export function reanchorFork(chapterTurns: readonly number[], fork: number): number | null {
  const sorted = [...chapterTurns].sort((a, b) => a - b);
  return sorted.filter((turn) => turn < fork).at(-1) ?? sorted[0] ?? null;
}

export interface ReanchoredPlan {
  plan: ImportAnalyzePlan;
  /** The branches re-anchored (their keys in `plan`). */
  moved: string[];
}

/**
 * `after` (the plan once `movedUnitKey` was moved, as moveUnitBetweenNodes repaired it) with every branch that forked
 * after that unit in `before` re-anchored by reanchorFork, when it still hangs on the same chapter.
 */
export function reanchorMovedForks(before: ImportAnalyzePlan, after: ImportAnalyzePlan, movedUnitKey: string, units: readonly ImportAnalyzeUnit[]): ReanchoredPlan {
  const position = new Map(units.map((unit, index) => [unit.key, index] as const));
  const holding = (key: string) => after.nodes.find((node) => node.unitKeys.includes(key));
  const changes = new Map<string, string>();
  for (const branch of before.nodes) {
    if (!isBranchRole(branch.role) || branch.attachAfterUnitKey !== movedUnitKey) continue;
    const host = before.nodes.find((node) => node.key === branch.attachToKey);
    const rest = host?.unitKeys.filter((key) => key !== movedUnitKey) ?? [];
    const hostNow = rest[0] ? holding(rest[0]) : undefined;
    const now = holding(branch.unitKeys[0]!);
    if (!hostNow || hostNow.unitKeys.includes(movedUnitKey) || !now || !isBranchRole(now.role) || now.attachToKey !== hostNow.key) continue;
    const turn = reanchorFork(hostNow.unitKeys.map((key) => position.get(key) ?? 0), position.get(movedUnitKey) ?? 0);
    const anchor = hostNow.unitKeys.find((key) => position.get(key) === turn);
    if (anchor) changes.set(now.key, anchor);
  }
  const nodes = after.nodes.map((node): ImportAnalyzeNode => (changes.has(node.key) ? { ...node, attachAfterUnitKey: changes.get(node.key)! } : node));
  return { plan: { ...after, nodes }, moved: [...changes.keys()] };
}
