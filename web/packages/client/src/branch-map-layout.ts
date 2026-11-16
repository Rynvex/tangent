import {
  edgePath,
  placeSlots,
  type LayoutDirection,
  type LayoutMetrics,
  type PlacedNode,
  type Slot,
} from "./lib/layered-layout";
import { branchPath, buildBranchTree, type BranchNode } from "./branch-tree";
import type { BranchView } from "./types";

/** Key of the main line node, the root of every map. */
export const MAP_ROOT_KEY = "__main__";

/** Above this many branches the map opens folded to the current path and the first level. */
export const MAP_LARGE_TREE = 40;

const METRICS: LayoutMetrics = { cardWidth: 200, cardHeight: 84, columnStep: 236, rowStep: 104, padding: 24 };

/** The design's map (components.md BranchMap): 188×60 nodes, 236 between depths, 78 between rows. */
export const BRANCH_MAP_METRICS: LayoutMetrics = { cardWidth: 188, cardHeight: 60, columnStep: 236, rowStep: 78, padding: 24 };

export interface MapNode extends PlacedNode {
  /** Null for the main line node. */
  branch: BranchView | null;
  hasChildren: boolean;
  collapsed: boolean;
  /** Branches folded away under this node. */
  hiddenCount: number;
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  path: string;
  /** Lies on the way from the main line to the current branch. */
  onPath: boolean;
}

export interface MapLayout {
  nodes: MapNode[];
  byKey: Map<string, MapNode>;
  edges: MapEdge[];
  width: number;
  height: number;
}

function countDescendants(node: BranchNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

/** Ids on the way from the main line to `currentId`, the main line key included. */
export function pathKeys(currentId: string | null, branches: readonly BranchView[]): Set<string> {
  const keys = new Set<string>([MAP_ROOT_KEY]);
  if (currentId) for (const branch of branchPath(currentId, branches)) keys.add(branch.lineId);
  return keys;
}

/** Branches with children that are folded by default: everything off the current path. */
export function defaultCollapsed(branches: readonly BranchView[], currentId: string | null): Set<string> {
  if (branches.length <= MAP_LARGE_TREE) return new Set();
  const onPath = pathKeys(currentId, branches);
  const parents = new Set(branches.map((branch) => branch.parentLineId));
  const folded = new Set<string>();
  for (const branch of branches) {
    if (parents.has(branch.lineId) && !onPath.has(branch.lineId)) folded.add(branch.lineId);
  }
  return folded;
}

interface Pending {
  slots: Slot[];
  nodes: Map<string, { branch: BranchView | null; hasChildren: boolean; collapsed: boolean; hiddenCount: number }>;
  links: { from: string; to: string }[];
  nextLeafRow: number;
}

/** Places `node` below its parent; leaves take consecutive rows and parents centre over their children. */
function place(node: BranchNode, depth: number, collapsed: ReadonlySet<string>, acc: Pending, parent: string): number {
  const key = node.branch.lineId;
  const isFolded = collapsed.has(key) && node.children.length > 0;
  acc.links.push({ from: parent, to: key });
  const rows = isFolded ? [] : node.children.map((child) => place(child, depth + 1, collapsed, acc, key));
  const row = rows.length > 0 ? (rows[0]! + rows[rows.length - 1]!) / 2 : acc.nextLeafRow++;
  acc.slots.push({ key, depth, row });
  acc.nodes.set(key, {
    branch: node.branch,
    hasChildren: node.children.length > 0,
    collapsed: isFolded,
    hiddenCount: isFolded ? countDescendants(node) : 0,
  });
  return row;
}

export function buildBranchMapLayout(
  branches: readonly BranchView[],
  options: { collapsed: ReadonlySet<string>; direction: LayoutDirection; currentId: string | null; metrics?: LayoutMetrics },
): MapLayout {
  const tree = buildBranchTree(branches);
  const acc: Pending = { slots: [], nodes: new Map(), links: [], nextLeafRow: 0 };
  const rootRows = tree.map((node) => place(node, 1, options.collapsed, acc, MAP_ROOT_KEY));
  const rootRow = rootRows.length > 0 ? (rootRows[0]! + rootRows[rootRows.length - 1]!) / 2 : 0;
  acc.slots.push({ key: MAP_ROOT_KEY, depth: 0, row: rootRow });
  acc.nodes.set(MAP_ROOT_KEY, { branch: null, hasChildren: tree.length > 0, collapsed: false, hiddenCount: 0 });

  const placed = placeSlots(acc.slots, options.direction, options.metrics ?? METRICS);
  const nodes: MapNode[] = placed.nodes.map((node) => ({ ...node, ...acc.nodes.get(node.key)! }));
  nodes.sort((a, b) => a.depth - b.depth || a.row - b.row);
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const onPath = pathKeys(options.currentId, branches);
  const edges: MapEdge[] = acc.links.flatMap((link) => {
    const from = byKey.get(link.from);
    const to = byKey.get(link.to);
    if (!from || !to) return [];
    return [
      {
        id: `${link.from}->${link.to}`,
        from: link.from,
        to: link.to,
        path: edgePath(from, to, options.direction),
        onPath: onPath.has(link.from) && onPath.has(link.to),
      },
    ];
  });
  return { nodes, byKey, edges, width: placed.width, height: placed.height };
}

/** F11 §3: the main line's chapters show on the map from this many (one chapter is the main node itself). */
export const MIN_STAGE_CHAPTERS = 2;

/** Stage nodes (F11 §3): shorter than a branch node, the main node's width, `STAGE_GAP` apart under it. */
export const STAGE_HEIGHT = 44;
const STAGE_GAP = 12;
const STAGE_TOP = 20;

export interface StageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The main line's stage nodes in column 0, one under another below the main
 * node; nothing else sits in that column, so they never meet a branch or an
 * edge (edges leave the main node on its right). `bottom` is the lowest edge,
 * for growing the canvas.
 */
export function chapterStageBoxes(main: PlacedNode, count: number): { boxes: StageBox[]; bottom: number } {
  const start = main.y + main.height + STAGE_TOP;
  const boxes = Array.from({ length: count }, (_, i) => ({ x: main.x, y: start + i * (STAGE_HEIGHT + STAGE_GAP), width: main.width, height: STAGE_HEIGHT }));
  return { boxes, bottom: boxes.at(-1) ? boxes.at(-1)!.y + STAGE_HEIGHT : main.y + main.height };
}

export interface MapViewport {
  /** In layout pixels (already divided by the zoom). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Nodes and edges that touch the viewport grown by `margin`; the rest are not rendered. */
export function cullLayout(layout: MapLayout, view: MapViewport, margin = 120): { nodes: MapNode[]; edges: MapEdge[] } {
  const inside = (n: PlacedNode): boolean =>
    n.x + n.width >= view.x - margin &&
    n.x <= view.x + view.width + margin &&
    n.y + n.height >= view.y - margin &&
    n.y <= view.y + view.height + margin;
  const nodes = layout.nodes.filter(inside);
  const shown = new Set(nodes.map((n) => n.key));
  // An edge is drawn when either end is on screen, so lines never end in mid-air.
  const edges = layout.edges.filter((edge) => shown.has(edge.from) || shown.has(edge.to));
  return { nodes, edges };
}
