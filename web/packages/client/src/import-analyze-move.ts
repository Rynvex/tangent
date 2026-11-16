/**
 * F16.2: fine-tuning a plan on the tree without dragging: one unit (a round)
 * moved to another node, or split out as a branch or a conversation of its
 * own (`moveUnitBetweenNodes`), and the user's role and attach choices made
 * on the assembly written back into the plan (`syncAnalyzePlan`). Every
 * result is repaired the way the server repairs a model's plan: nodes keyed
 * by their first unit and in order, at least one chapter, every branch on a
 * chapter after one of its units. Pure: a new plan each time.
 */
import { isBranchRole, type ImportAnalyzeNode, type ImportAnalyzePlan, type ImportAnalyzeUnit } from "./import-analyze";
import { analyzeSummary, unitEnding, unitTitle } from "./import-analyze-local";
import type { AttachPoint, NodeRole } from "./import-assembly";

/** Where a unit goes: another node (its key), a new branch, or a new conversation of its own. */
export type UnitMoveTarget = string;
export const NEW_BRANCH = "new_branch";
export const NEW_STANDALONE = "new_standalone";

export interface PlanContext {
  /** The analysis' units, in their order: positions (spans, the order of nodes) and the texts of new nodes. */
  units?: readonly ImportAnalyzeUnit[];
}

/** Every unit's position: the units' order, else the order the nodes list them in. */
function positionsOf(plan: ImportAnalyzePlan, context: PlanContext): Map<string, number> {
  const keys = context.units ? context.units.map((unit) => unit.key) : plan.nodes.flatMap((node) => node.unitKeys);
  return new Map(keys.map((key, index) => [key, index] as const));
}

const positionOf = (positions: ReadonlyMap<string, number>, key: string) => positions.get(key) ?? Number.MAX_SAFE_INTEGER;

/** The old key of a node the move creates (never a unit's key, so a rename never points at it). */
const NEW_NODE = "\u0000new";

/** A node keyed by its first unit (units in order); the old key is kept apart for the renames. */
interface Draft {
  node: ImportAnalyzeNode;
  oldKey: string;
}

/** A branch's chapter when its own is gone: the innermost chapter whose span holds it, else the latest before it, else the first. */
function fallbackHost(first: number, chapters: readonly ImportAnalyzeNode[], positions: ReadonlyMap<string, number>): ImportAnalyzeNode | undefined {
  const starts = (node: ImportAnalyzeNode) => positionOf(positions, node.unitKeys[0]!);
  const ends = (node: ImportAnalyzeNode) => positionOf(positions, node.unitKeys.at(-1)!);
  const before = chapters.filter((node) => starts(node) < first);
  return before.filter((node) => first < ends(node)).at(-1) ?? before.at(-1) ?? chapters[0];
}

function withoutBranchFields(node: ImportAnalyzeNode): ImportAnalyzeNode {
  const { attachToKey: _to, attachAfterUnitKey: _after, conclusion, ...rest } = node;
  return node.role === "merged_branch" && conclusion ? { ...rest, conclusion } : rest;
}

/** A branch hung on a chapter that exists, after one of its units before the branch (or none), with a card when merged. */
function attached(node: ImportAnalyzeNode, chapters: readonly ImportAnalyzeNode[], positions: ReadonlyMap<string, number>, units: ReadonlyMap<string, ImportAnalyzeUnit>): ImportAnalyzeNode {
  const first = positionOf(positions, node.unitKeys[0]!);
  const host = chapters.find((chapter) => chapter.key === node.attachToKey) ?? fallbackHost(first, chapters, positions);
  if (!host) return withoutBranchFields({ ...node, role: "standalone" });
  const before = host.unitKeys.filter((key) => positionOf(positions, key) < first).at(-1) ?? "";
  const after = node.attachAfterUnitKey && host.unitKeys.includes(node.attachAfterUnitKey) ? node.attachAfterUnitKey : before;
  const last = units.get(node.unitKeys.at(-1)!);
  const conclusion = node.role === "merged_branch" ? node.conclusion || (last ? unitEnding(last) : "") : "";
  const { attachAfterUnitKey: _after, conclusion: _conclusion, ...bare } = node;
  return { ...bare, attachToKey: host.key, ...(after ? { attachAfterUnitKey: after } : {}), ...(conclusion ? { conclusion } : {}) };
}

/** The drafts as a valid plan's nodes (see the file comment); a node whose first unit changed is renamed in its branches. */
function repaired(drafts: readonly Draft[], positions: ReadonlyMap<string, number>, units: ReadonlyMap<string, ImportAnalyzeUnit>): ImportAnalyzeNode[] {
  const keyed = drafts
    .filter((draft) => draft.node.unitKeys.length > 0)
    .map((draft) => {
      const unitKeys = [...draft.node.unitKeys].sort((a, b) => positionOf(positions, a) - positionOf(positions, b));
      return { ...draft, node: { ...draft.node, unitKeys, key: unitKeys[0]! } };
    })
    .sort((a, b) => positionOf(positions, a.node.key) - positionOf(positions, b.node.key));
  const renamed = new Map(keyed.map((draft) => [draft.oldKey, draft.node.key] as const));
  const renamedNodes = keyed.map(({ node }) => (node.attachToKey ? { ...node, attachToKey: renamed.get(node.attachToKey) ?? node.attachToKey } : node));
  const withChapter = renamedNodes.some((node) => node.role === "chapter") ? renamedNodes : renamedNodes.map((node, index) => (index === 0 ? withoutBranchFields({ ...node, role: "chapter" as const }) : node));
  const chapters = withChapter.filter((node) => node.role === "chapter");
  return withChapter.map((node) => (isBranchRole(node.role) ? attached(node, chapters, positions, units) : withoutBranchFields(node)));
}

function planOf(plan: ImportAnalyzePlan, nodes: ImportAnalyzeNode[]): ImportAnalyzePlan {
  return { ...plan, mode: nodes.some((node) => isBranchRole(node.role)) ? "tree" : plan.mode, summary: analyzeSummary(nodes), nodes };
}

const unitsByKey = (context: PlanContext) => new Map((context.units ?? []).map((unit) => [unit.key, unit] as const));

/**
 * The plan with one unit moved: into the node `target` names, or split out as a new merged branch (`NEW_BRANCH`, hung
 * on the chapter it falls inside) or a conversation of its own (`NEW_STANDALONE`). The plan as it was when the unit or
 * the target node is unknown, or when the unit is already there.
 */
export function moveUnitBetweenNodes(plan: ImportAnalyzePlan, unitKey: string, target: UnitMoveTarget, context: PlanContext = {}): ImportAnalyzePlan {
  const source = plan.nodes.find((node) => node.unitKeys.includes(unitKey));
  const into = plan.nodes.find((node) => node.key === target);
  const fresh = target === NEW_BRANCH || target === NEW_STANDALONE;
  if (!source || (!fresh && !into) || into === source) return plan;
  if (fresh && source.unitKeys.length === 1 && source.role === (target === NEW_BRANCH ? "merged_branch" : "standalone")) return plan;
  const positions = positionsOf(plan, context);
  const units = unitsByKey(context);
  // The two nodes that changed lose their reason (it described the units they had).
  const drafts: Draft[] = plan.nodes.map((node) => {
    const { reason: _reason, ...bare } = node;
    if (node === source) return { oldKey: node.key, node: { ...bare, unitKeys: node.unitKeys.filter((key) => key !== unitKey) } };
    if (node === into) return { oldKey: node.key, node: { ...bare, unitKeys: [...node.unitKeys, unitKey] } };
    return { oldKey: node.key, node };
  });
  const unit = units.get(unitKey);
  const role: NodeRole = target === NEW_BRANCH ? "merged_branch" : "standalone";
  const created: Draft[] = fresh
    ? [{ oldKey: NEW_NODE, node: { key: unitKey, unitKeys: [unitKey], title: unit ? unitTitle(unit) : source.title, role, reason: target === NEW_BRANCH ? "手動拆出為支線" : "手動拆出為獨立對話" } }]
    : [];
  return planOf(plan, repaired([...drafts, ...created], positions, units));
}

/** The user's choices on the assembly, by node key; attach points in the units' terms (the unit a branch hangs after). */
export interface AssemblyChoices {
  roles?: Readonly<Record<string, NodeRole>>;
  attach?: Readonly<Record<string, AttachPoint>>;
  conclusions?: Readonly<Record<string, string>>;
}

/**
 * The plan with the user's role, attach and card choices written in (before a unit is moved, so the move keeps them):
 * a branch's point names the unit it hangs after, whose node becomes its chapter when that node is one.
 */
export function syncAnalyzePlan(plan: ImportAnalyzePlan, choices: AssemblyChoices, context: PlanContext = {}): ImportAnalyzePlan {
  const roleOf = (node: ImportAnalyzeNode) => choices.roles?.[node.key] ?? node.role;
  const nodeOfUnit = new Map(plan.nodes.flatMap((node) => node.unitKeys.map((key) => [key, node] as const)));
  const drafts = plan.nodes.map((node): Draft => {
    const role = roleOf(node);
    const point = choices.attach?.[node.key];
    const host = point ? nodeOfUnit.get(point.sessionKey) : undefined;
    const hung = isBranchRole(role) && host && roleOf(host) === "chapter" ? { attachToKey: host.key, attachAfterUnitKey: point!.sessionKey } : {};
    const conclusion = choices.conclusions?.[node.key];
    return { oldKey: node.key, node: { ...node, role, ...hung, ...(conclusion !== undefined ? { conclusion } : {}) } };
  });
  return planOf(plan, repaired(drafts, positionsOf(plan, context), unitsByKey(context)));
}
