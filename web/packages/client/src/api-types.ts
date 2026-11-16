/**
 * Request and response bodies of the HTTP API (DESIGN §7, docs/devlog/B4-api.md).
 * The shapes follow the contract samples in `httpapi/testdata/contract/`;
 * contract.test.ts sends every sample through the client.
 */
import type { AppliedFold, FisheyeReport, PromptBudget } from "./fisheye";
import type { RecalledMemory } from "./memory-routes";
import type {
  BranchCard,
  BranchKind,
  BranchPack,
  BranchView,
  Chapter,
  ChatMessage,
  Delta,
  LineView,
  Message,
  Milestone,
  Note,
  NoteChange,
  NoteSection,
  Prompt,
} from "./types";

// Lines ----------------------------------------------------------------------

/** `GET /lines` query. */
export interface ListLinesQuery {
  archived?: boolean;
  limit?: number;
  cursor?: string;
  /** B18: only this folder's main lines; `FOLDER_UNFILED` (`__unfiled__`) only those without one. */
  folder?: string;
  /** B18: only main lines with this tag (normalised by the server: no "#", lower case). */
  tag?: string;
  /** B25: only pinned main lines, newest-pinned first (unpaged, at most 200; cursor is refused). */
  pinned?: boolean;
}

/** `GET /lines` body: cursor paging; `nextCursor` is "" on the last page. */
export interface LinePage {
  lines: LineView[];
  nextCursor: string;
}

/** `POST /lines` body. Clients never send `hostMeta` (400); the host writes it. */
export interface CreateLineInput {
  title?: string;
  provider?: string;
  model?: string;
  /** B18: the folder ("" unfiled; at most 40 characters; `__unfiled__` is reserved). */
  folder?: string;
  /** B18: at most 12 tags of at most 24 characters each. */
  tags?: string[];
  /**
   * G1: the reasoning effort (low, medium, high, xhigh, max; "" clears it).
   * httpapi ignores the field; the reference server's host_meta hook keeps it
   * in the line's `hostMeta.reasoningEffort` and runs the line's turns with it.
   */
  reasoningEffort?: string;
}

/**
 * `PATCH /lines/{id}` body: at least one field (else 400). B18: `folder` and
 * `tags` (the whole set) are a main line's only; a non-empty value on a branch is 400.
 */
export interface UpdateLineInput {
  title?: string;
  provider?: string;
  model?: string;
  folder?: string;
  tags?: string[];
  /** B25: pin or unpin a main line (branches reject `true` with 400 `invalid_input`). */
  pinned?: boolean;
  /**
   * G1: the reasoning effort (low, medium, high, xhigh, max; "" clears it).
   * httpapi ignores the field; the reference server's host_meta hook keeps it
   * in the line's `hostMeta.reasoningEffort` and runs the line's turns with it.
   */
  reasoningEffort?: string;
}

/** `DELETE /lines/{id}`: the deleted tree. */
export interface DeleteLineResult {
  rootLineId: string;
  lineIds: string[];
}

/** `POST /lines/{id}/archive` and `/unarchive`: every line of the tree, the main line first. */
export interface ArchiveResult {
  lines: LineView[];
}

// Messages and turns ---------------------------------------------------------

/** `GET /lines/{id}/messages` query. */
export interface ListMessagesQuery {
  afterSeq?: number;
  limit?: number;
}

/** `GET /lines/{id}/messages` body, ordered by seq. */
export interface MessagePage {
  messages: Message[];
}

/** `POST /lines/{id}/messages` body. */
export interface SendMessageInput {
  content: string;
  /** G1: this turn's reasoning effort (the reference server; else the line's). */
  reasoningEffort?: string;
}

/** 202 body of `POST /lines/{id}/messages` (DESIGN §7). */
export interface SendMessageResult {
  turnId: string;
  userMessage: Message;
  pendingMessage: Message;
}

/**
 * `GET /lines/{id}/stream`: the buffered deltas after the cursor, the newest
 * seq handed out for the line (0 when none is buffered) and whether deltas
 * after the cursor are gone. When `truncated`, reload the messages instead.
 */
export interface StreamPage {
  deltas: Delta[];
  seq: number;
  truncated: boolean;
}

/** `POST /lines/{id}/cancel`: `message` is the stopped reply, null when nothing was running. */
export interface CancelResult {
  cancelled: boolean;
  line: LineView;
  message: Message | null;
}

/** `POST /lines/{id}/preview` body; `content` may be left out (an empty next message). */
export interface PreviewTurnInput {
  content?: string;
}

/** One block of the next prompt as the model will see it, with its token estimate. */
export interface PreviewBlock {
  /** Section key (`rules`, `pack`, `notes`, `summary`, host keys…), `history` or `user_message`. */
  key: string;
  /** Set on chat blocks (`history`, `user_message`). */
  role?: ChatMessage["role"];
  content: string;
  tokens: number;
}

/** `POST /lines/{id}/preview`: nothing is written; read-only identities may call it. */
export interface PreviewTurnResult {
  prompt: Prompt;
  blocks: PreviewBlock[];
  totalTokens: number;
  provider: string;
  model: string;
  /** Input side only; present when the server has a price for the model. */
  estimatedCostUsd?: number;
  /** How the shared token budget was spent (B9 phase B; zeros from older servers). */
  budget: PromptBudget;
  /** How much of each message and branch the model sees; only with the fisheye feature on. */
  fisheye?: FisheyeReport;
  /** The folds that replaced part of this line's history (B10 phase A); only when some did. */
  folds?: AppliedFold[];
  /** The memories this turn recalls (B10 phase C, the memory feature); only when some are. */
  memories?: RecalledMemory[];
}

/** Body of `POST /lines/{id}/compact` and `/branch/draft`: the job that was started. */
export interface JobStarted {
  jobId: string;
  kind: string;
  lineId: string;
  /** The provider and model the job will use (B5; `TANGENT_JOB_MODEL` included). */
  provider?: string;
  model?: string;
}

// Branches -------------------------------------------------------------------

/** `GET /lines/{id}/branches` query. */
export interface ListBranchesQuery {
  includeAside?: boolean;
}

/** `GET /lines/{id}/branches` body: the whole tree's outline. */
export interface BranchList {
  branches: BranchView[];
}

/** `POST /lines/{id}/branches` body. */
export interface CreateBranchInput {
  purpose: string;
  kind: BranchKind;
  anchorMessageId: string;
  excerpt?: string;
  provider?: string;
  model?: string;
  confirmDeeper?: boolean;
  /** Set when the user accepted an assistant suggestion unchanged. */
  suggestionMessageId?: string;
  /** Also bring in what the parent did after the anchor. */
  includeLater?: boolean;
  /** B23: an aside kept from the start (never cleared); `true` on another kind is `400 invalid_input`. */
  keep?: boolean;
}

/** 201 body of `POST /lines/{id}/branches`; `line` is the new branch line. */
export interface CreateBranchResult {
  branch: BranchView;
  line: LineView;
  pack: BranchPack;
}

/** Branch kinds a move can create (a move never makes an aside). */
export type MovableBranchKind = Exclude<BranchKind, "aside">;

/** `POST /lines/{id}/branches/move` body: the last `count` messages become the branch. */
export interface MoveBranchInput {
  purpose: string;
  count: number;
  kind?: MovableBranchKind;
  provider?: string;
  model?: string;
  confirmDeeper?: boolean;
}

/** 201 body of `POST /branches/move`; there is no pack (read it with `GET /branch`). */
export interface MoveBranchResult {
  line: LineView;
  branch: BranchView;
  marker: Message;
  sourceLineId: string;
  rootLineId: string;
  movedMessageIds: string[];
  reparented: string[];
  summaryReset: boolean;
}

/** `POST /lines/{id}/branch/merge` body. */
export interface MergeBranchBody {
  card: Partial<BranchCard>;
  parentTipMessageId: string;
  confirmParentMoved?: true;
  /** Written in the same transaction as the card. */
  noteChanges?: NoteChange[];
}

/** `POST /branch/merge` body; `notes` only when the request sent `noteChanges`. */
export interface MergeBranchResult {
  branch: BranchView;
  message: Message;
  line: LineView;
  notes?: { rootLineId: string; revision: number; created: Note[]; superseded: Note[] };
}

/** `POST /branch/discard` body. */
export interface DiscardBranchResult {
  branch: BranchView;
}

/** `POST /branch/promote` body: `line` is the main line, `previousMainLine` the ended old tail. */
export interface PromoteBranchResult {
  branch: BranchView;
  previousMainLine: BranchView;
  line: LineView;
  reparented: string[];
}

// Notes ----------------------------------------------------------------------

export interface NoteLimitsView {
  maxActive: number;
  maxTotal: number;
  maxRunes: number;
  maxChangesPerMerge: number;
  /** Tokens the notes block of one prompt may use (B5); older servers do not send it. */
  tokenBudget?: number;
}

/** `GET /lines/{id}/notes`: newest first, superseded and done notes included. */
export interface NotesView {
  rootLineId: string;
  revision: number;
  notes: Note[];
  limits: NoteLimitsView;
}

export interface CreateNoteInput {
  section: NoteSection;
  text: string;
  sourceLineId?: string;
  sourceMessageId?: string;
}

export interface UpdateNoteInput {
  text?: string;
  section?: NoteSection;
  status?: "active" | "done";
}

export interface SupersedeNoteInput {
  text: string;
  section?: NoteSection;
  sourceLineId?: string;
  sourceMessageId?: string;
}

/** Body of every note write. */
export interface NoteWriteResult {
  note: Note;
  superseded?: Note;
  revision: number;
  rootLineId: string;
}

// Chapters -------------------------------------------------------------------

export interface ChapterLimitsView {
  maxChapters: number;
  minMessages: number;
  idleGapMinutes: number;
  maxMilestones: number;
  milestoneMaxLen: number;
}

/** `GET /lines/{id}/chapters`. */
export interface ChaptersView {
  lineId: string;
  rootLineId: string;
  chapters: Chapter[];
  milestones: Milestone[];
  limits: ChapterLimitsView;
}

/** `POST /lines/{id}/chapters/milestones` body. */
export interface CreateMilestoneInput {
  messageId: string;
  title?: string;
}

/** 201 body of `POST /lines/{id}/chapters/milestones`. */
export interface MilestoneWriteResult {
  milestone: Milestone;
  rootLineId: string;
}
