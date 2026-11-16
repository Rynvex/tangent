/**
 * F16.2: the pure glue between an analysis (@tangent/client's
 * import-analyze*) and step 2's assembly state. The assembly stays the
 * source of truth for the tree (merges, roles, attach points), so whatever
 * the user changed with the F16.1 tools after the analysis is read back
 * from it (`currentPlan`) before a round is moved and the plan applied again.
 */
import {
  applyAnalyzePlanToAssembly,
  expandSessionsToTurnUnits,
  IMPORT_ANALYZE_MAX_UNITS,
  mergeMembers,
  moveUnitBetweenNodes,
  reanchorMovedForks,
  sessionsToUnits,
  syncAnalyzePlan,
  type AssemblyEdits,
  type ImportAnalyzeNode,
  type ImportAnalyzePlan,
  type ImportAnalyzeUnit,
  type NodeRole,
  type ReanchoredPlan,
  type SessionMerge,
  type TimelineSession,
} from "@tangent/client";
import type { AssemblyState } from "./use-assembly";

/** The rounds option is offered for 1–3 picked conversations of 6 messages or more. */
export const EXPAND_MAX_SESSIONS = 3;
export const EXPAND_MIN_MESSAGES = 6;

/** One analysis and what it was made from. */
export interface AiAnalysis {
  plan: ImportAnalyzePlan;
  units: readonly ImportAnalyzeUnit[];
  /** The rounds as sessions (untitled) when they were expanded; null when the units are the sessions. */
  unitSessions: readonly TimelineSession[] | null;
  /** Merges made before the analysis: folded into every application (the units are their targets). */
  baseMerges: readonly SessionMerge[];
  /** Each node's first session's title (the plan's). */
  titles: Readonly<Record<string, string>>;
}

/** What is sent: the rounds of the visible sessions, or the visible sessions themselves. */
export interface AnalysisInput {
  units: ImportAnalyzeUnit[];
  unitSessions: TimelineSession[] | null;
  baseMerges: readonly SessionMerge[];
}

/** The visible sessions (merged ones as merged) and their edits, as units. */
export function analysisInput(visible: readonly TimelineSession[], edits: AssemblyEdits, merges: readonly SessionMerge[], expand: boolean): AnalysisInput {
  if (!expand) return { units: sessionsToUnits(visible, edits), unitSessions: null, baseMerges: merges };
  const { turnSessions, units } = expandSessionsToTurnUnits(visible, edits);
  return { units, unitSessions: turnSessions, baseMerges: [] };
}

/** How many rounds expanding would make (more than the server reads means analyzing whole conversations). */
export const roundCount = (visible: readonly TimelineSession[], edits: AssemblyEdits): number => expandSessionsToTurnUnits(visible, edits).units.length;

export const canExpand = (rounds: number): boolean => rounds <= IMPORT_ANALYZE_MAX_UNITS;

/**
 * The assembly state of `plan`: its merges, order, roles, attach points and cards. The message edits are kept (the
 * expanded rounds carry the earlier ones themselves).
 */
export function applyAnalysis(analysis: Omit<AiAnalysis, "titles">, plan: ImportAnalyzePlan, originals: readonly TimelineSession[], messages: AssemblyEdits["messages"]): { analysis: AiAnalysis; state: AssemblyState } {
  const applied = applyAnalyzePlanToAssembly(analysis.unitSessions ?? originals, plan, analysis.baseMerges);
  const edits: AssemblyEdits = { roles: applied.roles, attach: applied.attach, conclusions: applied.conclusions, ...(messages ? { messages } : {}) };
  return { analysis: { ...analysis, plan, titles: applied.titles }, state: { order: applied.order, mode: applied.mode, merges: applied.merges, edits } };
}

/** A visible node's units (the analysis' units it holds), in their order. */
export function unitsOfNode(analysis: AiAnalysis, merges: readonly SessionMerge[], key: string): ImportAnalyzeUnit[] {
  const members = new Set(mergeMembers(merges, key));
  return analysis.units.filter((unit) => members.has(unit.key));
}

/** The plan node an analysis made for a visible node (by its first unit), for its reason. */
export function planNodeOf(analysis: AiAnalysis, merges: readonly SessionMerge[], key: string): ImportAnalyzeNode | undefined {
  const first = unitsOfNode(analysis, merges, key)[0];
  return first ? analysis.plan.nodes.find((node) => node.unitKeys.includes(first.key)) : undefined;
}

export interface AssemblyView {
  /** The visible sessions in order. */
  ordered: readonly TimelineSession[];
  state: AssemblyState;
  roleOf: (key: string) => NodeRole;
}

/** The plan as the assembly shows it now (nodes, roles, attach points, cards), keyed by the nodes' first units. */
export function currentPlan(analysis: AiAnalysis, view: AssemblyView): ImportAnalyzePlan {
  const { merges, edits } = view.state;
  const nodes = view.ordered.flatMap((session): ImportAnalyzeNode[] => {
    const unitKeys = unitsOfNode(analysis, merges, session.key).map((unit) => unit.key);
    if (unitKeys.length === 0) return [];
    const reason = planNodeOf(analysis, merges, session.key)?.reason;
    return [{ key: session.key, unitKeys, title: session.conversation.title, role: view.roleOf(session.key), ...(reason ? { reason } : {}) }];
  });
  return syncAnalyzePlan({ ...analysis.plan, nodes }, { attach: edits.attach, conclusions: edits.conclusions }, { units: analysis.units });
}

/**
 * The plan after moving `unitKey` to the node shown as `targetKey` (a visible key) or into a new node; F17: a branch
 * that forked after that unit is re-anchored after its chapter's unit before it (decision #6) and listed in `moved`.
 */
export function movedPlan(analysis: AiAnalysis, view: AssemblyView, unitKey: string, target: string): ReanchoredPlan {
  const plan = currentPlan(analysis, view);
  const targetUnit = unitsOfNode(analysis, view.state.merges, target)[0]?.key;
  const into = targetUnit ? plan.nodes.find((node) => node.unitKeys.includes(targetUnit))?.key : undefined;
  const after = moveUnitBetweenNodes(plan, unitKey, into ?? target, { units: analysis.units });
  return reanchorMovedForks(plan, after, unitKey, analysis.units);
}
