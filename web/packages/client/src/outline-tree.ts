/**
 * The keyboard model of the outline tree (interactions.md A8): the visible
 * rows with their ARIA tree positions, focus moves, typeahead and range
 * selection. Pure; the component keeps focus, collapse and selection state.
 */
import { buildBranchTree, type BranchNode } from "./branch-tree";
import type { BranchView } from "./types";

/** Key of the main line's row (the tree's first row). */
export const OUTLINE_MAIN_KEY = "__main__";

/** A parent with at least this many ended branches shows them grouped by how they ended (F9 B.4). */
export const OUTLINE_ENDED_GROUP_MIN = 6;
/** The groups, in this order: by the branch's leaf kind; no leaf (or 待續) is 其他. */
export const OUTLINE_ENDED_KINDS = ["decision", "answer", "conclusion", "dead_end", "other"] as const;
export type OutlineEndedKind = (typeof OUTLINE_ENDED_KINDS)[number];

const GROUP_PREFIX = "__ended__:";
const TOGGLE_PREFIX = "__ended-all__:";
/** The row of one parent's ended branches of one kind. */
export const outlineGroupKey = (parentKey: string, kind: OutlineEndedKind) => `${GROUP_PREFIX}${parentKey}:${kind}`;
/** The row that switches one parent's ended branches between grouped and all shown. */
export const outlineToggleKey = (parentKey: string) => `${TOGGLE_PREFIX}${parentKey}`;
export const isOutlineGroupKey = (key: string) => key.startsWith(GROUP_PREFIX);
export const isOutlineToggleKey = (key: string) => key.startsWith(TOGGLE_PREFIX);

/** Merged or discarded (a promoted branch became the main line and stays in place). */
export const isEndedBranch = (branch: BranchView) => branch.status === "merged" || branch.status === "discarded";

/** The group an ended branch falls in: its leaf's kind, else 其他. */
export function outlineEndedKind(branch: BranchView): OutlineEndedKind {
  const kind = branch.leaf?.kind;
  return kind === "decision" || kind === "answer" || kind === "conclusion" || kind === "dead_end" ? kind : "other";
}

export interface OutlineItem {
  key: string;
  /** Null on the main line's row. */
  branch: BranchView | null;
  /** `aria-level`: 1 for the main line, 2 for its branches, and so on. */
  level: number;
  parentKey: string | null;
  hasChildren: boolean;
  /** Meaningful only with children. */
  expanded: boolean;
  setSize: number;
  posInSet: number;
  /** A row of ended branches of one kind (F9 B.4): no branch of its own; its children are those branches. */
  group?: { parentKey: string; kind: OutlineEndedKind; count: number; /** Open because it holds `reveal`. */ revealed: boolean };
  /** The row that groups or shows all of a parent's ended branches. */
  toggle?: { parentKey: string; grouped: boolean; count: number };
}

export interface OutlineOptions {
  collapsed: ReadonlySet<string>;
  /** Asides (one-question branches) are hidden unless asked for (A8). */
  showAsides: boolean;
  /** Parents whose ended branches are all shown, not grouped (grouped by default from OUTLINE_ENDED_GROUP_MIN). */
  endedShown?: ReadonlySet<string>;
  /** Group rows that are open (closed by default). */
  openGroups?: ReadonlySet<string>;
  /** A line that must stay visible (the line on screen): the group holding it, or one of its ancestors, is open. */
  reveal?: string | null;
}

function withoutAsides(nodes: readonly BranchNode[]): BranchNode[] {
  return nodes.filter((node) => node.branch.kind !== "aside").map((node) => ({ ...node, children: withoutAsides(node.children) }));
}

interface FlattenContext {
  collapsed: ReadonlySet<string>;
  endedShown: ReadonlySet<string>;
  openGroups: ReadonlySet<string>;
  /** The line to keep visible and its ancestors. */
  revealed: ReadonlySet<string>;
}

/** One branch row and, when it is expanded, its subtree. */
function branchRows(node: BranchNode, level: number, parentKey: string, setSize: number, posInSet: number, ctx: FlattenContext): OutlineItem[] {
  const key = node.branch.lineId;
  const expanded = !ctx.collapsed.has(key);
  const item: OutlineItem = { key, branch: node.branch, level, parentKey, hasChildren: node.children.length > 0, expanded, setSize, posInSet };
  return expanded ? [item, ...flatten(node.children, level + 1, key, ctx)] : [item];
}

/**
 * The rows of one parent's children. With OUTLINE_ENDED_GROUP_MIN or more
 * ended branches the parent gets a toggle row last; grouped (the default),
 * its ended branches sit under one row per kind instead of in line.
 */
function flatten(nodes: readonly BranchNode[], level: number, parentKey: string, ctx: FlattenContext): OutlineItem[] {
  const ended = nodes.filter((node) => isEndedBranch(node.branch));
  if (ended.length < OUTLINE_ENDED_GROUP_MIN) return nodes.flatMap((node, index) => branchRows(node, level, parentKey, nodes.length, index + 1, ctx));
  const toggleKey = outlineToggleKey(parentKey);
  if (ctx.endedShown.has(parentKey)) {
    const setSize = nodes.length + 1;
    const toggle: OutlineItem = { key: toggleKey, branch: null, level, parentKey, hasChildren: false, expanded: false, setSize, posInSet: setSize, toggle: { parentKey, grouped: false, count: ended.length } };
    return [...nodes.flatMap((node, index) => branchRows(node, level, parentKey, setSize, index + 1, ctx)), toggle];
  }
  const open = nodes.filter((node) => !isEndedBranch(node.branch));
  const groups = OUTLINE_ENDED_KINDS.map((kind) => ({ kind, members: ended.filter((node) => outlineEndedKind(node.branch) === kind) })).filter((group) => group.members.length > 0);
  const setSize = open.length + groups.length + 1;
  const rows = open.flatMap((node, index) => branchRows(node, level, parentKey, setSize, index + 1, ctx));
  groups.forEach((group, index) => {
    const key = outlineGroupKey(parentKey, group.kind);
    const revealed = group.members.some((node) => ctx.revealed.has(node.branch.lineId));
    const expanded = revealed || ctx.openGroups.has(key);
    rows.push({ key, branch: null, level, parentKey, hasChildren: true, expanded, setSize, posInSet: open.length + index + 1, group: { parentKey, kind: group.kind, count: group.members.length, revealed } });
    if (expanded) rows.push(...group.members.flatMap((node, at) => branchRows(node, level + 1, key, group.members.length, at + 1, ctx)));
  });
  rows.push({ key: toggleKey, branch: null, level, parentKey, hasChildren: false, expanded: false, setSize, posInSet: setSize, toggle: { parentKey, grouped: true, count: ended.length } });
  return rows;
}

/** `lineId` and every branch above it. */
function ancestry(branches: readonly BranchView[], lineId: string | null | undefined): Set<string> {
  const parentOf = new Map(branches.map((branch) => [branch.lineId, branch.parentLineId]));
  const chain = new Set<string>();
  for (let at = lineId ?? undefined; at && parentOf.has(at) && !chain.has(at); at = parentOf.get(at)) chain.add(at);
  return chain;
}

/** The visible rows: the main line, then the branch tree depth-first, skipping the children of collapsed rows (and of closed groups). */
export function outlineItems(branches: readonly BranchView[], { collapsed, showAsides, endedShown = new Set(), openGroups = new Set(), reveal = null }: OutlineOptions): OutlineItem[] {
  const tree = buildBranchTree(branches);
  const nodes = showAsides ? tree : withoutAsides(tree);
  const expanded = !collapsed.has(OUTLINE_MAIN_KEY);
  const main: OutlineItem = { key: OUTLINE_MAIN_KEY, branch: null, level: 1, parentKey: null, hasChildren: nodes.length > 0, expanded, setSize: 1, posInSet: 1 };
  const ctx: FlattenContext = { collapsed, endedShown, openGroups, revealed: ancestry(branches, reveal) };
  return expanded ? [main, ...flatten(nodes, 2, OUTLINE_MAIN_KEY, ctx)] : [main];
}

export type OutlineMove = "next" | "prev" | "first" | "last" | "parent" | "firstChild";

/** The row focus moves to; it stays put at the edges and where there is nowhere to go. */
export function moveOutlineFocus(items: readonly OutlineItem[], key: string, move: OutlineMove): string {
  const index = items.findIndex((item) => item.key === key);
  const item = items[index];
  if (!item) return items[0]?.key ?? key;
  switch (move) {
    case "next":
      return items[index + 1]?.key ?? key;
    case "prev":
      return items[index - 1]?.key ?? key;
    case "first":
      return items[0]?.key ?? key;
    case "last":
      return items.at(-1)?.key ?? key;
    case "parent":
      return item.parentKey ?? key;
    case "firstChild":
      return item.hasChildren && item.expanded ? (items[index + 1]?.key ?? key) : key;
  }
}

/** The visible rows that share `key`'s parent (for `*`). */
export function outlineSiblings(items: readonly OutlineItem[], key: string): string[] {
  const parent = items.find((item) => item.key === key)?.parentKey;
  return items.filter((item) => item.parentKey === parent).map((item) => item.key);
}

/** The next row after `fromKey` (wrapping) whose label starts with `query`, ignoring case; null when none does. */
export function outlineTypeahead(items: readonly OutlineItem[], fromKey: string, query: string, label: (key: string) => string): string | null {
  const wanted = query.toLocaleLowerCase();
  const start = items.findIndex((item) => item.key === fromKey);
  for (let step = 1; step <= items.length; step += 1) {
    const item = items[(start + step) % items.length];
    if (item && label(item.key).toLocaleLowerCase().startsWith(wanted)) return item.key;
  }
  return null;
}

/** Branch rows between two rows (inclusive, any order); the main line and asides are never selected. */
export function outlineRange(items: readonly OutlineItem[], fromKey: string, toKey: string): string[] {
  const a = items.findIndex((item) => item.key === fromKey);
  const b = items.findIndex((item) => item.key === toKey);
  if (a < 0 || b < 0) return [];
  return items
    .slice(Math.min(a, b), Math.max(a, b) + 1)
    .filter((item) => item.branch !== null && item.branch.kind !== "aside")
    .map((item) => item.key);
}

/** Every visible branch row a "select all" takes (no main line, no asides). */
export function outlineSelectable(items: readonly OutlineItem[]): string[] {
  return items.filter((item) => item.branch !== null && item.branch.kind !== "aside").map((item) => item.key);
}
