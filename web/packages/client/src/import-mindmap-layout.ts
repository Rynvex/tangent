/**
 * F17: the import's step 2 as a mind map (Claude Design 2026-11-04, S2):
 * left to right, the main line's root (depth 0), its chapters §1…§n strung on
 * a trunk (depth 1), each chapter's branches with a fork pill above them
 * (depth 2), and a lane of separate conversations under the tree. Every box
 * has the design's fixed size, so the layout is plain geometry in canvas
 * coordinates at 100% (the tree is 860 wide): no node overlaps another,
 * whatever the input. The turn chips' centres are where S3's turn order is
 * drawn (import-mindmap-trace.ts). Pure, no IO.
 */
import type { AssemblyMode, NodeRole } from "./import-assembly";
import { buildMindMapTrace, isInterleaved, LABEL_BOX, type MindMapTrace } from "./import-mindmap-trace";

/** The design's sizes and spacing (TABLES[0] of the F17 design document), in canvas pixels at 100%. */
export const MINDMAP_METRICS = {
  canvasBaseWidth: 860,
  root: { x: 24, width: 196, height: 148 },
  chapter: { x: 270, width: 240, height: 114, gapY: 96 },
  branch: { x: 600, width: 252, height: 140, gapY: 36, forkPillOffsetY: 24 },
  standalone: { x: 270, width: 240, height: 86, gapX: 24, gapY: 16, lanePaddingTop: 28 },
  chip: { width: 28, height: 20, gap: 4, stitchedBadgeWidth: 96 },
} as const;

/** The key of the main line's root in a layout (sessions' keys are a file's and a conversation's, never this). */
export const MINDMAP_ROOT_KEY = "@mindmap/root";

/** Where the tree starts (its first fork pill or chapter), the lane's lowest start, and the margin under it. */
const TREE_TOP = 8;
const CHAPTER_TOP = 24;
const LANE_MIN_Y = 462;
const LANE_PAD_BOTTOM = 14;
const LANE_EMPTY_HEIGHT = 72;
const BOTTOM_MARGIN = 12;
/** A card's border and padding (box-sizing: border-box): content starts this far in. */
const BORDER = 1.5;
const PAD_X = 12;
const PAD_Y = 10;
/** How far below a card's content top its chip row starts (the design's inner heights). */
const CHIP_ROW: Readonly<Record<MindMapNodeKind, number>> = { chapter: 20 + 6 + 40 + 8, branch: 18 + 6 + 40 + 6, standalone: 40 + 6 };
/** Room kept on a chip row for its message count. */
const COUNT_ROOM = 16;
/** Separate conversations' columns: under a tree they start at the chapters' x; alone, at the root's. */
const LANE_COLUMNS_UNDER_TREE = 2;
const LANE_COLUMNS_ALONE = 3;

export type MindMapNodeKind = "chapter" | "branch" | "standalone";

/** One node of step 2 (a visible session) as the mind map needs it. */
export interface ImportMindMapNodeInput {
  key: string;
  role: NodeRole;
  /** Its rounds' numbers (#n) once analyzed; empty before. */
  turns: readonly number[];
  /** A branch's chapter (its key); a missing or unknown one hangs it on the closest chapter before it. */
  attachTo?: string | null;
  /** The round it forks after (#n), when known. */
  forkTurn?: number | null;
  /** Its fork round was moved away and it was re-anchored (decision #6). */
  forkMoved?: boolean;
}

export interface ImportMindMapInput {
  nodes: readonly ImportMindMapNodeInput[];
  /** Batch: every node is a conversation of its own (no main line). */
  mode?: AssemblyMode;
}

export interface MindMapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A turn chip (#n), by its centre; `turn` null is the "+k" chip for the `hidden` rounds that did not fit. */
export interface MindMapChip {
  turn: number | null;
  x: number;
  y: number;
  hidden: readonly number[];
}

export interface MindMapFork {
  x: number;
  y: number;
  turn: number | null;
  moved: boolean;
}

export interface MindMapPlacedNode {
  key: string;
  kind: MindMapNodeKind;
  role: NodeRole;
  rect: MindMapRect;
  /** §n for a chapter (1-based). */
  chapter: number | null;
  /** A branch's chapter. */
  parentKey: string | null;
  /** Whether its attach chapter was not one (it was hung on a fallback). */
  orphan: boolean;
  /** Whether the chip row starts with 「跨段整合 N 輪」 (a chapter whose rounds are not in a row). */
  stitched: boolean;
  chips: MindMapChip[];
  fork: MindMapFork | null;
}

export type MindMapEdgeKind = "root-to-chapter" | "chapter-spine" | "chapter-to-branch";

export interface MindMapEdge {
  kind: MindMapEdgeKind;
  from: string;
  to: string;
  d: string;
  /** The spine's arrow head. */
  head?: string;
}

export interface MindMapLane {
  y: number;
  height: number;
  titleY: number;
}

export interface ImportMindMapLayout {
  width: number;
  height: number;
  root: MindMapRect | null;
  /** Chapters and their branches in order, then the lane's nodes. */
  nodes: MindMapPlacedNode[];
  edges: MindMapEdge[];
  lane: MindMapLane;
  /** Every visible turn's chip centre (a hidden one's is its "+k" chip). */
  chipCenters: ReadonlyMap<number, { x: number; y: number }>;
  trace: MindMapTrace;
}

const n1 = (value: number) => Math.round(value * 10) / 10;

/** How many chips fit on a row (the last becomes "+k" when there are more). */
function chipCapacity(kind: MindMapNodeKind, stitched: boolean): number {
  const width = kind === "branch" ? MINDMAP_METRICS.branch.width : MINDMAP_METRICS.chapter.width;
  const room = width - 2 * (BORDER + PAD_X) - (stitched ? MINDMAP_METRICS.chip.stitchedBadgeWidth + MINDMAP_METRICS.chip.gap : 0) - COUNT_ROOM;
  const step = MINDMAP_METRICS.chip.width + MINDMAP_METRICS.chip.gap;
  return Math.max(1, Math.floor((room + MINDMAP_METRICS.chip.gap) / step));
}

/** A node's chips (sorted turns; the overflow folded into a last "+k" chip). */
export function chipsOf(kind: MindMapNodeKind, rect: MindMapRect, turns: readonly number[], stitched: boolean): MindMapChip[] {
  const sorted = [...turns].sort((a, b) => a - b);
  const capacity = chipCapacity(kind, stitched);
  const shown = sorted.length > capacity ? sorted.slice(0, capacity - 1) : sorted;
  const hidden = sorted.slice(shown.length);
  const left = rect.x + BORDER + PAD_X + (stitched ? MINDMAP_METRICS.chip.stitchedBadgeWidth + MINDMAP_METRICS.chip.gap : 0);
  const y = rect.y + BORDER + PAD_Y + CHIP_ROW[kind] + MINDMAP_METRICS.chip.height / 2;
  const at = (index: number) => left + index * (MINDMAP_METRICS.chip.width + MINDMAP_METRICS.chip.gap) + MINDMAP_METRICS.chip.width / 2;
  const chips: MindMapChip[] = shown.map((turn, index) => ({ turn, x: at(index), y, hidden: [] }));
  return hidden.length > 0 ? [...chips, { turn: null, x: at(shown.length), y, hidden }] : chips;
}

const kindOf = (role: NodeRole): MindMapNodeKind => (role === "chapter" ? "chapter" : role === "standalone" ? "standalone" : "branch");

interface Group {
  chapter: ImportMindMapNodeInput;
  branches: ImportMindMapNodeInput[];
  orphans: ReadonlySet<string>;
}

/** The chapters in order, each with the branches hung on it (in input order); the rest go to the lane. */
function groupNodes(input: ImportMindMapInput): { groups: Group[]; lane: ImportMindMapNodeInput[] } {
  if (input.mode === "batch") return { groups: [], lane: [...input.nodes] };
  const chapters = input.nodes.filter((node) => node.role === "chapter");
  if (chapters.length === 0) return { groups: [], lane: [...input.nodes] };
  const byChapter = new Map(chapters.map((chapter) => [chapter.key, { chapter, branches: [] as ImportMindMapNodeInput[], orphans: new Set<string>() }]));
  let latest = chapters[0]!.key;
  for (const node of input.nodes) {
    if (node.role === "chapter") latest = node.key;
    if (kindOf(node.role) !== "branch") continue;
    const own = node.attachTo ? byChapter.get(node.attachTo) : undefined;
    const group = own ?? byChapter.get(latest)!;
    group.branches.push(node);
    if (!own) group.orphans.add(node.key);
  }
  return { groups: chapters.map((chapter) => byChapter.get(chapter.key)!), lane: input.nodes.filter((node) => node.role === "standalone") };
}

const stackHeight = (count: number) => (count === 0 ? 0 : MINDMAP_METRICS.branch.forkPillOffsetY + count * MINDMAP_METRICS.branch.height + (count - 1) * MINDMAP_METRICS.branch.gapY);

/** The chapters and branches, top to bottom (see the file comment); returns the placed nodes and the tree's bottom. */
function placeTree(groups: readonly Group[]): { nodes: MindMapPlacedNode[]; bottom: number } {
  const { chapter: C, branch: B } = MINDMAP_METRICS;
  const nodes: MindMapPlacedNode[] = [];
  let previousY = Number.NEGATIVE_INFINITY;
  let stackBottom = Number.NEGATIVE_INFINITY;
  let bottom = 0;
  groups.forEach((group, index) => {
    const height = stackHeight(group.branches.length);
    const afterChapter = index === 0 ? CHAPTER_TOP : previousY + C.height + C.gapY;
    // A stack is centred on its chapter; it may not come closer than the branch gap to the stack above.
    const forStack = height === 0 ? afterChapter : Math.max(stackBottom + B.gapY - B.forkPillOffsetY, TREE_TOP) + height / 2 - C.height / 2;
    const y = Math.max(afterChapter, forStack);
    const stitched = isInterleaved(group.chapter.turns);
    const rect = { x: C.x, y, width: C.width, height: C.height };
    nodes.push({ key: group.chapter.key, kind: "chapter", role: "chapter", rect, chapter: index + 1, parentKey: null, orphan: false, stitched, chips: chipsOf("chapter", rect, group.chapter.turns, stitched), fork: null });
    const top = y + C.height / 2 - height / 2;
    group.branches.forEach((branch, at) => {
      const cardY = top + B.forkPillOffsetY + at * (B.height + B.gapY);
      const card = { x: B.x, y: cardY, width: B.width, height: B.height };
      const fork = { x: B.x, y: cardY - B.forkPillOffsetY, turn: branch.forkTurn ?? null, moved: branch.forkMoved === true };
      nodes.push({ key: branch.key, kind: "branch", role: branch.role, rect: card, chapter: null, parentKey: group.chapter.key, orphan: group.orphans.has(branch.key), stitched: false, chips: chipsOf("branch", card, branch.turns, false), fork });
    });
    previousY = y;
    if (height > 0) stackBottom = top + height;
    bottom = Math.max(bottom, y + C.height, height > 0 ? top + height : 0);
  });
  return { nodes, bottom };
}

/** The lane under the tree (or the whole canvas without one) and its nodes in rows. */
function placeLane(nodes: readonly ImportMindMapNodeInput[], treeBottom: number | null): { lane: MindMapLane; placed: MindMapPlacedNode[] } {
  const S = MINDMAP_METRICS.standalone;
  const y = treeBottom === null ? TREE_TOP : Math.max(LANE_MIN_Y, treeBottom + S.lanePaddingTop);
  const columns = treeBottom === null ? LANE_COLUMNS_ALONE : LANE_COLUMNS_UNDER_TREE;
  const left = treeBottom === null ? MINDMAP_METRICS.root.x : S.x;
  const placed = nodes.map((node, index): MindMapPlacedNode => {
    const rect = { x: left + (index % columns) * (S.width + S.gapX), y: y + S.lanePaddingTop + Math.floor(index / columns) * (S.height + S.gapY), width: S.width, height: S.height };
    return { key: node.key, kind: "standalone", role: node.role, rect, chapter: null, parentKey: null, orphan: node.role !== "standalone", stitched: false, chips: chipsOf("standalone", rect, node.turns, false), fork: null };
  });
  const rows = Math.ceil(nodes.length / columns);
  const height = rows === 0 ? LANE_EMPTY_HEIGHT : S.lanePaddingTop + rows * S.height + (rows - 1) * S.gapY + LANE_PAD_BOTTOM;
  return { lane: { y, height, titleY: y + 12 }, placed };
}

/** The root, centred between the first and last chapter. */
function placeRoot(chapters: readonly MindMapPlacedNode[]): MindMapRect | null {
  if (chapters.length === 0) return null;
  const R = MINDMAP_METRICS.root;
  const middle = (chapters[0]!.rect.y + chapters.at(-1)!.rect.y) / 2 + MINDMAP_METRICS.chapter.height / 2;
  return { x: R.x, y: Math.max(TREE_TOP, middle - R.height / 2), width: R.width, height: R.height };
}

/** Root → chapter and chapter → branch curves (cubic, control points halfway), and the trunk between chapters with its arrow. */
function edgesOf(root: MindMapRect | null, nodes: readonly MindMapPlacedNode[]): MindMapEdge[] {
  const chapters = nodes.filter((node) => node.kind === "chapter");
  const centreY = (rect: MindMapRect) => rect.y + rect.height / 2;
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = n1((x1 + x2) / 2);
    return `M ${x1} ${n1(y1)} C ${mx} ${n1(y1)}, ${mx} ${n1(y2)}, ${x2} ${n1(y2)}`;
  };
  const toChapters = root ? chapters.map((chapter): MindMapEdge => ({ kind: "root-to-chapter", from: MINDMAP_ROOT_KEY, to: chapter.key, d: curve(root.x + root.width, centreY(root), chapter.rect.x, centreY(chapter.rect)) })) : [];
  const spineX = MINDMAP_METRICS.chapter.x + MINDMAP_METRICS.chapter.width / 2;
  const spine = chapters.slice(1).map((chapter, index): MindMapEdge => {
    const from = chapters[index]!;
    const top = chapter.rect.y;
    return { kind: "chapter-spine", from: from.key, to: chapter.key, d: `M ${spineX} ${n1(from.rect.y + from.rect.height)} L ${spineX} ${n1(top - 2)}`, head: `M ${spineX - 6} ${n1(top - 10)} L ${spineX} ${n1(top - 1)} L ${spineX + 6} ${n1(top - 10)}` };
  });
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const toBranches = nodes.flatMap((node): MindMapEdge[] => {
    const parent = node.parentKey ? byKey.get(node.parentKey) : undefined;
    return parent ? [{ kind: "chapter-to-branch", from: parent.key, to: node.key, d: curve(parent.rect.x + parent.rect.width, centreY(parent.rect), node.rect.x, centreY(node.rect)) }] : [];
  });
  return [...toChapters, ...spine, ...toBranches];
}

/** Every turn's chip centre (hidden turns at their "+k" chip). */
function chipCentersOf(nodes: readonly MindMapPlacedNode[]): Map<number, { x: number; y: number }> {
  const centres = new Map<number, { x: number; y: number }>();
  for (const node of nodes) {
    for (const chip of node.chips) {
      for (const turn of chip.turn === null ? chip.hidden : [chip.turn]) centres.set(turn, { x: chip.x, y: chip.y });
    }
  }
  return centres;
}

/** The mind map of step 2's nodes (see the file comment). */
export function buildImportMindMapLayout(input: ImportMindMapInput): ImportMindMapLayout {
  const { groups, lane: laneNodes } = groupNodes(input);
  const tree = groups.length > 0 ? placeTree(groups) : null;
  const { lane, placed } = placeLane(laneNodes, tree ? tree.bottom : null);
  const nodes = [...(tree?.nodes ?? []), ...placed];
  const root = placeRoot(nodes.filter((node) => node.kind === "chapter"));
  const chipCenters = chipCentersOf(nodes);
  const turnNode = new Map(input.nodes.flatMap((node) => node.turns.map((turn) => [turn, node.key] as const)));
  const trace = buildMindMapTrace(input.nodes, chipCenters, turnNode);
  const lowestLabel = Math.max(0, ...trace.labels.map((label) => label.y + LABEL_BOX.height));
  return {
    width: MINDMAP_METRICS.canvasBaseWidth,
    height: Math.max(lane.y + lane.height + BOTTOM_MARGIN, lowestLabel),
    root,
    nodes,
    edges: edgesOf(root, nodes),
    lane,
    chipCenters,
    trace,
  };
}
