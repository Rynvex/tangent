import type { BranchStatus, BranchView, LineView } from "./types";

export { branchPath } from "./branch-path";

export interface BranchNode {
  branch: BranchView;
  children: BranchNode[];
}

export interface BranchRow {
  branch: BranchView;
  /** Indent level: 1 for branches directly under the main line. */
  level: number;
  hasChildren: boolean;
}

/** Creation time in ms; an unparsable time sorts last. */
function createdMs(branch: BranchView): number {
  const ms = Date.parse(branch.createdAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * By creation instant, then by line id. Timestamps are compared as instants,
 * not strings: RFC 3339 with trimmed fractional zeros does not sort as text.
 */
function byCreation(a: BranchView, b: BranchView): number {
  const ta = createdMs(a);
  const tb = createdMs(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.lineId.localeCompare(b.lineId);
}

/**
 * Turns the flat branch list into a tree by `parentLineId` (the `depth`
 * field is not trusted). A branch whose parent is unknown hangs from the main
 * line, repeated ids keep the first entry, and a parent cycle is cut so every
 * branch appears exactly once. Siblings are ordered by creation time.
 */
export function buildBranchTree(branches: readonly BranchView[]): BranchNode[] {
  const unique = new Map<string, BranchView>();
  for (const branch of branches) if (!unique.has(branch.lineId)) unique.set(branch.lineId, branch);
  const nodes = new Map<string, BranchNode>();
  for (const [id, branch] of unique) nodes.set(id, { branch, children: [] });

  const roots: BranchNode[] = [];
  const parentOf = new Map<string, string>();
  const closesCycle = (id: string, parentId: string): boolean => {
    for (let cursor: string | undefined = parentId; cursor !== undefined; cursor = parentOf.get(cursor)) {
      if (cursor === id) return true;
    }
    return false;
  };
  // The nodes are private to this call, so filling their child lists here is safe.
  for (const node of nodes.values()) {
    const parent = nodes.get(node.branch.parentLineId);
    // An unknown parent, or one that would close a parent cycle, hangs from the main line.
    if (parent && !closesCycle(node.branch.lineId, parent.branch.lineId)) {
      parent.children.push(node);
      parentOf.set(node.branch.lineId, parent.branch.lineId);
    } else {
      roots.push(node);
    }
  }
  return sortTree(roots);
}

function sortTree(nodes: readonly BranchNode[]): BranchNode[] {
  return [...nodes]
    .sort((a, b) => byCreation(a.branch, b.branch))
    .map((node) => ({ ...node, children: sortTree(node.children) }));
}

/** The visible outline rows, skipping the children of collapsed branches. */
export function flattenBranchTree(nodes: readonly BranchNode[], collapsed: ReadonlySet<string>, level = 1): BranchRow[] {
  return nodes.flatMap((node) => {
    const row: BranchRow = { branch: node.branch, level, hasChildren: node.children.length > 0 };
    return collapsed.has(node.branch.lineId) ? [row] : [row, ...flattenBranchTree(node.children, collapsed, level + 1)];
  });
}

export type BranchRowPrimary = "error" | "thinking" | "unread" | "none";

export interface BranchRowState {
  status: BranchStatus;
  /** Greyed out: the branch ended without bringing anything back. */
  isMuted: boolean;
  isCurrent: boolean;
  /** The one marker that leads the row: error > thinking > unread. */
  primary: BranchRowPrimary;
  unread: number;
}

/** What one outline row shows; markers only apply while the branch is open. */
export function branchRowState(branch: BranchView, currentId: string | null): BranchRowState {
  const isOpen = branch.status === "open";
  const unread = isOpen ? branch.unread : 0;
  const primary: BranchRowPrimary = !isOpen
    ? "none"
    : branch.lineStatus === "error"
      ? "error"
      : branch.lineStatus === "thinking"
        ? "thinking"
        : unread > 0
          ? "unread"
          : "none";
  return {
    status: branch.status,
    isMuted: branch.status === "discarded",
    isCurrent: branch.lineId === currentId,
    primary,
    unread,
  };
}

export type BranchReadonlyKind = "merged" | "discarded" | "promoted" | "archived";

/** Why a branch cannot take new messages; null while it is open and not archived. */
export function branchReadonlyKind(line: Pick<LineView, "conversationBranch" | "archivedAt">): BranchReadonlyKind | null {
  const info = line.conversationBranch;
  if (!info) return null;
  if (info.status !== "open") return info.status;
  return line.archivedAt ? "archived" : null;
}

/** A live mark a host keeps for a branch that finished while nobody watched it. */
export type AttentionLevel = "idle" | "error";

export interface BranchAttentionSummary {
  unread: boolean;
  level: AttentionLevel | null;
}

const LEVEL_RANK: Record<AttentionLevel, number> = { idle: 1, error: 2 };

/**
 * Folds the branches of one main line into a single summary for its row: the
 * server's unread counter plus any live attention mark on a branch that is not
 * being watched.
 */
export function summarizeBranchAttention(
  line: Pick<LineView, "branchUnread">,
  branches: readonly BranchView[],
  pending: Readonly<Record<string, AttentionLevel>>,
): BranchAttentionSummary {
  let level: AttentionLevel | null = null;
  for (const branch of branches) {
    const mark = pending[branch.lineId];
    if (mark && (level === null || LEVEL_RANK[mark] > LEVEL_RANK[level])) level = mark;
  }
  return { unread: line.branchUnread > 0 || level !== null, level };
}
