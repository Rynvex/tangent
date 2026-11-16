/**
 * The shared shapes of a parsed import, and how a tree of messages (ChatGPT's
 * `mapping`, Claude's `parent_message_uuid`) becomes one main line plus the
 * alternative versions hanging on it: the main path runs from the root to
 * the current message; at every node with more than one child, each child
 * off the path is another version (an edited question or a regenerated
 * reply), followed down its newest children.
 */
import type { ImportRole } from "./b18-routes";

/** Where an import came from (also sent as the import's `source`). */
export type ImportSourceKind = "chatgpt" | "claude" | "gemini" | "tangent" | "markdown" | "text";

export interface ParsedMessage {
  /** Unique within the conversation (the source's id, or made up). */
  externalId: string;
  role: ImportRole;
  content: string;
  /** How many versions the source had of this message (1 + the alternatives restored as branches); 1 when none. */
  versions: number;
  /** B19 / F14: when the source says it was written (ISO); null or left out when it does not. */
  createdAt?: string | null;
}

/** A message of a restored branch. */
export interface ParsedBranchMessage {
  role: ImportRole;
  content: string;
  createdAt?: string | null;
}

/**
 * F14: where a conversation's time comes from: the source's own dates (`exact`), the file's modification
 * time because the source has none (`file`), or nothing at all (`none`, pasted text without dates).
 */
export type ImportTimeSource = "exact" | "file" | "none";

/** Why a branch exists: an edited question, a regenerated reply, or a branch of a Tangent backup. */
export type ParsedBranchReason = "edit" | "regenerate" | "branch";

export interface ParsedBranch {
  /** The `externalId` of the main-line message it hangs on. */
  anchorExternalId: string;
  reason: ParsedBranchReason;
  messages: ParsedBranchMessage[];
  /** A Tangent backup's own purpose, kind and status; restored versions leave them to the import's defaults. */
  purpose?: string;
  kind?: "investigate" | "alternative";
  status?: "open" | "discarded";
}

export interface ParsedConversation {
  /** The source's id, or the index in the file. */
  id: string;
  title: string;
  /** ISO times when the source had them (the picker sorts by `updatedAt`, newest first). */
  createdAt: string | null;
  updatedAt: string | null;
  messages: ParsedMessage[];
  branches: ParsedBranch[];
  /** Versions that had no main-line message before them to hang on (an edited first question). */
  skippedBranches: number;
  /** A Tangent backup's own folder and tags. */
  folder?: string;
  tags?: string[];
  /** F14: where its time comes from (`parseImport` fills it; left out means `exact` when it has a date, else `none`). */
  timeSource?: ImportTimeSource;
  /** F14: the file's modification time, when the source has no date of its own (`timeSource: "file"`). */
  fileTime?: string | null;
  /** B22: the file's rounds (1-based) a topic cut threads together when they are not one run (1, 3, 5). */
  threadedRounds?: number[];
}

/** One node of a source's message tree; `message` is null for nodes that show nothing (the root, tool calls…). */
export interface TreeNode {
  id: string;
  parent: string | null;
  children: string[];
  message: ParsedBranchMessage | null;
}

/** The ids from the root to `currentId`, oldest first; a cycle or a missing parent ends the walk. */
function pathTo(nodes: ReadonlyMap<string, TreeNode>, currentId: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  for (let id: string | null = currentId; id !== null && nodes.has(id) && !seen.has(id); id = nodes.get(id)!.parent) {
    seen.add(id);
    path.push(id);
  }
  return path.reverse();
}

/** The visible messages from `startId` down its newest children. */
function followNewest(nodes: ReadonlyMap<string, TreeNode>, startId: string): ParsedBranchMessage[] {
  const out: ParsedBranchMessage[] = [];
  const seen = new Set<string>();
  for (let id: string | undefined = startId; id !== undefined && nodes.has(id) && !seen.has(id); ) {
    seen.add(id);
    const node: TreeNode = nodes.get(id)!;
    if (node.message) out.push(node.message);
    id = node.children.at(-1);
  }
  return out;
}

/**
 * The main line (the path to `currentId`) and the versions off it. A
 * version hangs on the newest visible main-line message above the fork; one
 * with none (an edited first question) is counted in `skipped`.
 */
export function conversationFromTree(nodes: ReadonlyMap<string, TreeNode>, currentId: string): { messages: ParsedMessage[]; branches: ParsedBranch[]; skipped: number } {
  const path = pathTo(nodes, currentId);
  const onPath = new Set(path);
  const messages: ParsedMessage[] = [];
  const branches: ParsedBranch[] = [];
  let skipped = 0;
  /** Index into `messages` of the newest visible main-line message so far. */
  let lastVisible = -1;
  /** Versions found at a fork, waiting for the next visible main-line message (the one they are versions of). */
  let pendingVersions = 0;
  for (const id of path) {
    const node = nodes.get(id)!;
    if (node.message) {
      messages.push({ externalId: id, ...node.message, versions: 1 + pendingVersions });
      pendingVersions = 0;
      lastVisible = messages.length - 1;
    }
    if (node.children.length < 2) continue;
    for (const child of node.children) {
      if (onPath.has(child)) continue;
      const version = followNewest(nodes, child);
      if (version.length === 0) continue;
      if (lastVisible < 0) {
        skipped += 1;
        continue;
      }
      pendingVersions += 1;
      branches.push({ anchorExternalId: messages[lastVisible]!.externalId, reason: version[0]!.role === "user" ? "edit" : "regenerate", messages: version });
    }
  }
  return { messages, branches, skipped };
}
