/**
 * Routes and rules B18 added (docs/devlog/B18-import-extract-organize.md):
 * folders and tags on main lines, renaming a folder
 * (`POST /lines/folders/rename`), importing a conversation written elsewhere
 * (`POST /lines/import`), extracting any stretch of a line into a branch
 * (`POST /lines/{id}/branches/extract`), the decompose plan
 * (`GET /lines/{id}/decompose`) and, since B18.1, the tenant's folders and
 * tags with their counts (`GET /lines/organization`). Inputs are untrusted JSON; every reader
 * fills the defaults. The limits are the server's defaults
 * (domain/line_org.go, domain/import.go, domain/limits.go, httpapi/api.go).
 */
import { BRANCH_MOVE_MAX } from "./branch-move-limit";
import { normalizeBranchView } from "./branch-normalize";
import { TangentError } from "./errors";
import { normalizeLine, normalizeMessage } from "./line-normalize";
import type { BranchCard, BranchView, LineView, Message } from "./types";
import { bool, count, list, obj, str, strings } from "./wire";

// Folders and tags ------------------------------------------------------------

/** The `GET /lines?folder=` value for main lines without a folder; never a folder's name. */
export const FOLDER_UNFILED = "__unfiled__";
/** `domain.FolderMaxRunes`. */
export const FOLDER_MAX_RUNES = 40;
/** `domain.TagsMax`: tags of one main line. */
export const TAGS_MAX = 12;
/** `domain.TagMaxRunes`. */
export const TAG_MAX_RUNES = 24;

const runes = (text: string) => Array.from(text).length;

/** Control characters (line breaks and tabs included) and the bidirectional controls, as `domain.dropControls` removes them. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** One tag as the server stores it (`domain.NormalizeTag`): no controls, trimmed, no leading "#", lower case; "" when nothing is left. */
export function normalizeTag(tag: string): string {
  return tag.replace(CONTROLS, "").trim().replace(/^#+/, "").trim().toLowerCase();
}

export type TagsProblem = "tooLong" | "tooMany";

/** Every tag normalised, empty and repeated ones dropped (first kept, input order), and what the server would refuse. */
export function normalizeTags(tags: readonly string[]): { tags: string[]; problem: TagsProblem | null } {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (tag === "" || out.includes(tag)) continue;
    if (runes(tag) > TAG_MAX_RUNES) return { tags: out, problem: "tooLong" };
    out.push(tag);
  }
  return { tags: out, problem: out.length > TAGS_MAX ? "tooMany" : null };
}

export type FolderProblem = "tooLong" | "reserved";

/** A folder name as the server stores it (`domain.NormalizeFolder`); "" is unfiled. */
export function normalizeFolder(folder: string): { folder: string; problem: FolderProblem | null } {
  const name = folder.replace(CONTROLS, "").trim();
  if (runes(name) > FOLDER_MAX_RUNES) return { folder: name, problem: "tooLong" };
  if (name === FOLDER_UNFILED) return { folder: name, problem: "reserved" };
  return { folder: name, problem: null };
}

/** `POST /lines/folders/rename`: every main line in `from` (archived ones too) moves to `to`; `to: ""` dissolves the folder. */
export interface RenameFolderInput {
  from: string;
  to: string;
}

export interface RenameFolderResult {
  /** How many main lines changed (0 when `from` = `to`). */
  updated: number;
}

export function normalizeRenameFolderResult(raw: unknown): RenameFolderResult {
  return { updated: count(obj(raw).updated) };
}

/** One folder of `GET /lines/organization`: its main lines, unarchived and archived counted apart. */
export interface FolderSummary {
  folder: string;
  active: number;
  archived: number;
}

/** One tag of `GET /lines/organization`: how many unarchived main lines carry it. */
export interface TagSummary {
  tag: string;
  count: number;
}

/**
 * `GET /lines/organization` (B18.1): the tenant's folders and tags over every main line, not one page of `GET /lines`.
 * Folders by name (code point order); tags most used first, then by name.
 */
export interface LineOrganization {
  folders: FolderSummary[];
  tags: TagSummary[];
}

export function normalizeLineOrganization(raw: unknown): LineOrganization {
  const body = obj(raw);
  return {
    folders: list(body.folders, (item) => {
      const folder = obj(item);
      return { active: count(folder.active), archived: count(folder.archived), folder: str(folder.folder) };
    }).filter((item) => item.folder !== ""),
    tags: list(body.tags, (item) => {
      const tag = obj(item);
      return { count: count(tag.count), tag: str(tag.tag) };
    }).filter((item) => item.tag !== ""),
  };
}

// Import -----------------------------------------------------------------------

/** `domain.ImportMaxMessages`: main-line messages of an import. */
export const IMPORT_MAX_MESSAGES = 2000;
/** `domain.ImportMaxBranches`. */
export const IMPORT_MAX_BRANCHES = 50;
/** `domain.ImportMaxBranchMessages`. */
export const IMPORT_MAX_BRANCH_MESSAGES = 500;
/** `Limits.Text.MessageMaxRunes` (default): one message's content after cleaning. */
export const IMPORT_MAX_MESSAGE_RUNES = 32_000;
/** `domain.ImportSourceMaxRunes`. */
export const IMPORT_SOURCE_MAX_RUNES = 40;
/** `httpapi.DefaultMaxImportBodyBytes`: the JSON request body (16 MiB). */
export const IMPORT_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** The largest file the import dialog reads (the design's 20 MB); the body it makes must still fit IMPORT_MAX_BODY_BYTES. */
export const IMPORT_MAX_FILE_BYTES = 20 * 1000 * 1000;
/** `Limits.Branch.MaxOpenPerParent`: an import's `open` branches all hang on the main line and count against it. */
export const IMPORT_MAX_OPEN_BRANCHES = 8;
/** `Limits.Branch.PurposeMaxRunes`. */
export const BRANCH_PURPOSE_MAX_RUNES = 200;
/** `domain.ImportMaxChapterCuts` (B19): chapter cuts of one import (also capped by the milestone limit). */
export const IMPORT_MAX_CHAPTER_CUTS = 50;
/** `domain.ImportTitleRunes`: a chapter cut's title is 1–60 characters. */
export const IMPORT_CUT_TITLE_MAX_RUNES = 60;
/** `domain.ImportFutureSlack` (B19): an imported date may be at most this far past now. */
export const IMPORT_FUTURE_SLACK_MS = 24 * 60 * 60_000;
/** `domain.ImportEarliest` (B19). */
export const IMPORT_EARLIEST = "1970-01-01T00:00:00Z";

export type ImportRole = "user" | "assistant";

export interface ImportMessageInput {
  /** The source's id, only to hang branches and chapter cuts on. */
  externalId?: string;
  role: ImportRole;
  content: string;
  /** B19: when it was written (RFC 3339); one dated earlier than the message above takes that one's date (never refused). */
  createdAt?: string;
}

export interface ImportBranchInput {
  /** The `externalId` of a main-line message of the same import. */
  anchorExternalId: string;
  /** "" or left out: the server takes the branch's first user message. */
  purpose?: string;
  /** `alternative` by default. */
  kind?: "investigate" | "alternative";
  /**
   * `discarded` by default (an earlier attempt that was left behind); `open` counts against the 8 open branches per parent;
   * B19 `merged` arrives brought back and must carry `card` (its card goes on the main line right after the anchor).
   */
  status?: "open" | "discarded" | "merged";
  /** B19: only with `merged` (an empty question takes the purpose); it cannot cite messages (they have no ids yet). */
  card?: Partial<BranchCard>;
  /** B19: when the branch started (RFC 3339). */
  createdAt?: string;
  messages: Array<{ role: ImportRole; content: string; createdAt?: string }>;
}

/** B19: a milestone chapter cut on a main-line message of the import. */
export interface ImportChapterCutInput {
  anchorExternalId: string;
  /** 1–60 characters, flattened to one line. */
  title: string;
}

/** `POST /lines/import` body: a whole conversation, written in one transaction without calling a model. */
export interface ImportConversationInput {
  title?: string;
  provider?: string;
  model?: string;
  folder?: string;
  tags?: string[];
  /** Where it came from (a label of at most 40 characters; not stored). */
  source?: string;
  /** B25: client-chosen UUID grouping a multi-file import so it can be listed and undone. */
  batchId?: string;
  /** B25: optional batch label (e.g. filename, at most 120 characters; kept from the first import in the batch). */
  batchLabel?: string;
  /** B19: when the conversation started (RFC 3339); the line starts at the earlier of this and its first dated message. */
  createdAt?: string;
  messages: ImportMessageInput[];
  branches?: ImportBranchInput[];
  /** B19: at most IMPORT_MAX_CHAPTER_CUTS, one per message. */
  chapterCuts?: ImportChapterCutInput[];
}

export interface ImportConversationResult {
  line: LineView;
  /** In the order given. */
  branches: BranchView[];
  /** Messages written to the main line. */
  messageCount: number;
}

export function normalizeImportResult(raw: unknown): ImportConversationResult {
  const body = obj(raw);
  return { line: normalizeLine(body.line), branches: list(body.branches, normalizeBranchView), messageCount: count(body.messageCount) };
}

// Extract ----------------------------------------------------------------------

/** `Limits.Branch.MoveMaxMessages`: an extracted range has 1–40 messages (`400 invalid_count`). */
export const EXTRACT_MAX_MESSAGES = BRANCH_MOVE_MAX;

/** `POST /lines/{id}/branches/extract` body: `[fromMessageId … toMessageId]` (seq order, both included). */
export interface ExtractBranchInput {
  fromMessageId: string;
  toMessageId: string;
  purpose: string;
  /** `investigate` by default; `aside` is `400 kind_unsupported`. */
  kind?: "investigate" | "alternative";
  provider?: string;
  model?: string;
  confirmDeeper?: boolean;
  /** Brings the branch back at once: it is `merged` and its card stays where the range was, already delivered. */
  card?: Partial<BranchCard>;
}

/** The new branch line, the marker (or delivered card) left in the range's place, and what moved with it. */
export interface ExtractBranchResult {
  line: LineView;
  branch: BranchView;
  marker: Message;
  sourceLineId: string;
  rootLineId: string;
  movedMessageIds: string[];
  reparented: string[];
  summaryReset: boolean;
}

export function normalizeExtractResult(raw: unknown): ExtractBranchResult {
  const body = obj(raw);
  return {
    branch: normalizeBranchView(body.branch),
    line: normalizeLine(body.line),
    marker: normalizeMessage(body.marker),
    movedMessageIds: strings(body.movedMessageIds),
    reparented: strings(body.reparented),
    rootLineId: str(body.rootLineId),
    sourceLineId: str(body.sourceLineId),
    summaryReset: bool(body.summaryReset),
  };
}

/** Why an extract was refused, as the dialog words it. */
export type ExtractFailure =
  | { kind: "notUserStart" }
  | { kind: "noAnchor" }
  | { kind: "protected" }
  | { kind: "busy" }
  | { kind: "archived" }
  | { kind: "closed" }
  | { kind: "count"; max: number }
  | { kind: "invalidCard" }
  | { kind: "other"; error: unknown };

export function classifyExtractError(error: unknown): ExtractFailure {
  if (!(error instanceof TangentError)) return { kind: "other", error };
  switch (error.code) {
    case "move_must_start_with_user":
      return { kind: "notUserStart" };
    case "move_no_anchor":
      return { kind: "noAnchor" };
    case "move_protected_message":
      return { kind: "protected" };
    case "source_busy":
      return { kind: "busy" };
    case "archived":
      return { kind: "archived" };
    case "parent_closed":
    case "branch_closed":
      return { kind: "closed" };
    case "invalid_count":
      return { kind: "count", max: typeof error.extra.max === "number" ? error.extra.max : EXTRACT_MAX_MESSAGES };
    case "invalid_card":
      return { kind: "invalidCard" };
    default:
      return { kind: "other", error };
  }
}

// Decompose --------------------------------------------------------------------

export type ChapterCutReason = "topic_shift" | "time_gap";
export type SeedCandidateReason = "question" | "open_item";

export interface ChapterCutSuggestion {
  messageId: string;
  seq: number;
  /** The message's first 40 characters (the milestone's name when applied). */
  title: string;
  /** "topic_shift" | "time_gap"; a newer server's reason is kept as sent. */
  reason: string;
}

/** A stretch that could go into a branch, ready for `POST /branches/extract`. */
export interface DetourRange {
  anchorMessageId: string;
  fromMessageId: string;
  toMessageId: string;
  messageCount: number;
  purpose: string;
  suggestedConclusion: string;
}

export interface SeedCandidate {
  messageId: string;
  text: string;
  reason: string;
}

export interface RelatedLine {
  lineId: string;
  title: string;
  folder: string;
  sharedTags: string[];
}

/** `GET /lines/{id}/decompose`: suggestions only, made without a model; every list is capped and never null. */
export interface DecomposePlan {
  lineId: string;
  /** As the server sent them; `filterSuggestedTags` cleans them for display. */
  suggestedTags: string[];
  chapterCuts: ChapterCutSuggestion[];
  detourRanges: DetourRange[];
  seedCandidates: SeedCandidate[];
  relatedLines: RelatedLine[];
  /** The line has more messages than were read (400). */
  truncated: boolean;
}

export function normalizeDecomposePlan(raw: unknown): DecomposePlan {
  const body = obj(raw);
  return {
    chapterCuts: list(body.chapterCuts, (item) => {
      const cut = obj(item);
      return { messageId: str(cut.messageId), reason: str(cut.reason), seq: count(cut.seq), title: str(cut.title) };
    }),
    detourRanges: list(body.detourRanges, (item) => {
      const range = obj(item);
      return {
        anchorMessageId: str(range.anchorMessageId),
        fromMessageId: str(range.fromMessageId),
        messageCount: count(range.messageCount),
        purpose: str(range.purpose),
        suggestedConclusion: str(range.suggestedConclusion),
        toMessageId: str(range.toMessageId),
      };
    }),
    lineId: str(body.lineId),
    relatedLines: list(body.relatedLines, (item) => {
      const related = obj(item);
      return { folder: str(related.folder), lineId: str(related.lineId), sharedTags: strings(related.sharedTags), title: str(related.title) };
    }),
    seedCandidates: list(body.seedCandidates, (item) => {
      const seed = obj(item);
      return { messageId: str(seed.messageId), reason: str(seed.reason), text: str(seed.text) };
    }),
    suggestedTags: strings(body.suggestedTags),
    truncated: bool(body.truncated),
  };
}

/** How many suggestions a plan holds (the banner's and the panel's count): each detour, the cuts as one, the tags as one, each seed, each related line. */
export function decomposeSuggestionCount(plan: DecomposePlan, cleanTags: readonly string[] = plan.suggestedTags): number {
  return plan.detourRanges.length + (plan.chapterCuts.length > 0 ? 1 : 0) + (cleanTags.length > 0 ? 1 : 0) + plan.seedCandidates.length + plan.relatedLines.length;
}
