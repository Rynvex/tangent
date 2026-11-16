/**
 * Turns a parsed conversation, and what the user changed in the preview
 * (roles switched, messages removed, title, folder, tags, whether to restore
 * versions), into the `POST /lines/import` body — checked against the
 * server's limits before anything is sent, so an import never fails whole on
 * a limit the client could see:
 * - main line 1–2,000 messages: a longer conversation is imported in parts of
 *   2,000 (`part`, the first by default);
 * - each message at most 32,000 characters (named, to be removed);
 * - at most 50 branches of 1–500 messages (extra branches dropped, long ones
 *   cut), at most 8 of them open (the rest go in as discarded);
 * - the JSON body at most 16 MiB.
 */
import {
  IMPORT_MAX_BODY_BYTES,
  IMPORT_MAX_BRANCH_MESSAGES,
  IMPORT_MAX_BRANCHES,
  IMPORT_MAX_MESSAGE_RUNES,
  IMPORT_MAX_MESSAGES,
  IMPORT_MAX_OPEN_BRANCHES,
  normalizeFolder,
  normalizeTags,
  type FolderProblem,
  type ImportBranchInput,
  type ImportConversationInput,
  type ImportRole,
  type TagsProblem,
} from "./b18-routes";
import type { ImportSourceKind, ParsedBranch, ParsedConversation } from "./import-tree";

/** What the user changed in the preview, by the parsed messages' `externalId`. */
export interface ImportEdits {
  roles: Readonly<Record<string, ImportRole>>;
  removed: ReadonlySet<string>;
}

export interface ImportPlanOptions {
  title: string;
  folder: string;
  tags: readonly string[];
  /** Restore the source's other versions as branches. */
  restoreBranches: boolean;
  source: ImportSourceKind;
  /** Which 200-message part of a longer conversation (0-based). */
  part?: number;
  /**
   * B19 / F14: each message's date by its `externalId` (a session the user re-timed is shifted); left out, the parsed
   * `createdAt` of each message. Messages without one are dated by the server (never earlier than the one above).
   */
  messageTimes?: ReadonlyMap<string, string>;
  /** B19: when the conversation started; left out, the parsed `createdAt`; null sends none. */
  createdAt?: string | null;
  provider?: string;
  model?: string;
}

/** The purpose a restored version's branch gets; the UI passes its own wording. */
export interface ImportBranchLabels {
  edit: (text: string) => string;
  regenerate: (text: string) => string;
}

export const DEFAULT_BRANCH_LABELS: ImportBranchLabels = {
  edit: (text) => `（重問）${text}`,
  regenerate: (text) => `（重新生成）${text}`,
};

export type ImportProblem =
  | { kind: "noMessages" }
  /** Messages (their numbers in the preview) over IMPORT_MAX_MESSAGE_RUNES. */
  | { kind: "tooLong"; numbers: number[] }
  | { kind: "bodyTooLarge"; bytes: number }
  | { kind: "folder"; problem: FolderProblem }
  | { kind: "tags"; problem: TagsProblem };

export interface ImportPlan {
  input: ImportConversationInput;
  problems: ImportProblem[];
  /** Main-line messages sent. */
  messageCount: number;
  branchCount: number;
  /** Parts of 200 the kept messages make (1 when it fits). */
  parts: number;
  /** The chosen part's first and last message, numbered as in the preview (1-based, removed ones included). */
  partRange: [number, number];
  /** Versions not sent: over 50, hanging outside the chosen part, or with nothing kept before them. */
  droppedBranches: number;
  /** Branches cut to their first 500 messages. */
  cutBranches: number;
  /** Open branches (a Tangent backup's) sent as discarded, so the main line keeps at most 8 open. */
  closedBranches: number;
}

const PURPOSE_TEXT_RUNES = 60;
const cut = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return Array.from(flat).length <= max ? flat : `${Array.from(flat).slice(0, max - 1).join("")}…`;
};
const runes = (text: string) => Array.from(text).length;

function purposeOf(branch: ParsedBranch, anchorText: string, labels: ImportBranchLabels): string | undefined {
  if (branch.purpose) return branch.purpose;
  const firstUser = branch.messages.find((message) => message.role === "user")?.content;
  if (branch.reason === "edit") return labels.edit(cut(firstUser ?? branch.messages[0]?.content ?? "", PURPOSE_TEXT_RUNES));
  if (branch.reason === "regenerate") return labels.regenerate(cut(anchorText, PURPOSE_TEXT_RUNES));
  return undefined;
}

/** The body's size in bytes as sent (UTF-8 JSON). */
export function importBodyBytes(input: ImportConversationInput): number {
  return new TextEncoder().encode(JSON.stringify(input)).length;
}

export function buildImportPlan(conversation: ParsedConversation, edits: ImportEdits, options: ImportPlanOptions, labels: ImportBranchLabels = DEFAULT_BRANCH_LABELS): ImportPlan {
  const all = conversation.messages;
  const numberOf = new Map(all.map((message, index) => [message.externalId, index + 1]));
  const kept = all.filter((message) => !edits.removed.has(message.externalId));
  const parts = Math.max(1, Math.ceil(kept.length / IMPORT_MAX_MESSAGES));
  const part = Math.min(Math.max(options.part ?? 0, 0), parts - 1);
  const slice = kept.slice(part * IMPORT_MAX_MESSAGES, (part + 1) * IMPORT_MAX_MESSAGES);
  const ids = new Map(slice.map((message, index) => [message.externalId, `m${index + 1}`]));
  const timeOf = (message: ParsedConversation["messages"][number]) => (options.messageTimes ? options.messageTimes.get(message.externalId) : message.createdAt) ?? null;
  const messages = slice.map((message) => {
    const at = timeOf(message);
    return { externalId: ids.get(message.externalId)!, role: edits.roles[message.externalId] ?? message.role, content: message.content, ...(at ? { createdAt: at } : {}) };
  });
  const problems: ImportProblem[] = [];
  if (messages.length === 0) problems.push({ kind: "noMessages" });
  const tooLong = slice.filter((message) => runes(message.content) > IMPORT_MAX_MESSAGE_RUNES).map((message) => numberOf.get(message.externalId)!);
  if (tooLong.length > 0) problems.push({ kind: "tooLong", numbers: tooLong });

  // A version whose anchor was removed hangs on the kept message before it; outside the chosen part it is not sent.
  const anchorFor = (externalId: string): string | null => {
    const index = all.findIndex((message) => message.externalId === externalId);
    for (let i = index; i >= 0; i -= 1) {
      const id = all[i]!.externalId;
      if (!edits.removed.has(id)) return ids.get(id) ?? null;
    }
    return null;
  };
  const textOf = new Map(all.map((message) => [message.externalId, message.content]));
  const branches: ImportBranchInput[] = [];
  let dropped = 0;
  let cutBranches = 0;
  let closed = 0;
  let open = 0;
  for (const branch of options.restoreBranches ? conversation.branches : []) {
    const anchor = anchorFor(branch.anchorExternalId);
    if (!anchor || branches.length >= IMPORT_MAX_BRANCHES) {
      dropped += 1;
      continue;
    }
    if (branch.messages.length > IMPORT_MAX_BRANCH_MESSAGES) cutBranches += 1;
    let status = branch.status;
    if (status === "open" && open >= IMPORT_MAX_OPEN_BRANCHES) {
      status = "discarded";
      closed += 1;
    } else if (status === "open") open += 1;
    const purpose = purposeOf(branch, textOf.get(branch.anchorExternalId) ?? "", labels);
    branches.push({
      anchorExternalId: anchor,
      ...(purpose ? { purpose } : {}),
      ...(branch.kind ? { kind: branch.kind } : {}),
      ...(status ? { status } : {}),
      messages: branch.messages.slice(0, IMPORT_MAX_BRANCH_MESSAGES).map((message) => ({ role: message.role, content: message.content, ...(message.createdAt ? { createdAt: message.createdAt } : {}) })),
    });
  }

  const folder = normalizeFolder(options.folder);
  if (folder.problem) problems.push({ kind: "folder", problem: folder.problem });
  const tags = normalizeTags(options.tags);
  if (tags.problem) problems.push({ kind: "tags", problem: tags.problem });
  const title = options.title.trim();
  // Only the first part starts when the conversation did; a later part starts at its own first message.
  const createdAt = part === 0 ? (options.createdAt === undefined ? conversation.createdAt : options.createdAt) : null;
  const input: ImportConversationInput = {
    ...(title ? { title } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(folder.folder ? { folder: folder.folder } : {}),
    ...(tags.tags.length > 0 ? { tags: tags.tags } : {}),
    source: options.source,
    ...(createdAt ? { createdAt } : {}),
    messages,
    ...(branches.length > 0 ? { branches } : {}),
  };
  const bytes = importBodyBytes(input);
  if (bytes > IMPORT_MAX_BODY_BYTES) problems.push({ kind: "bodyTooLarge", bytes });
  const first = slice[0] ? numberOf.get(slice[0].externalId)! : 0;
  const last = slice.at(-1) ? numberOf.get(slice.at(-1)!.externalId)! : 0;
  return { input, problems, messageCount: messages.length, branchCount: branches.length, parts, partRange: [first, last], droppedBranches: dropped, cutBranches, closedBranches: closed };
}
