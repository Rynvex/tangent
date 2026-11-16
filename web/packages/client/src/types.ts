/**
 * Wire shapes of the Go `domain` package (DESIGN §4, §6). Field names follow
 * the JSON tags in `domain/*.go` exactly; Go `time.Time` is an ISO-8601
 * string and a `*time.Time` is `string | null`. Fields tagged `json:"-"` in Go
 * (e.g. `Line.SummaryUptoSeq`) never reach the client and are left out.
 */

/** Any JSON value; used for host-owned data the library stores verbatim. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** `host_meta`: the host's own data, kept as-is (`{}` by default). */
export type HostMeta = JsonValue;

// ---------------------------------------------------------------------------
// Lines and messages (domain/line.go)
// ---------------------------------------------------------------------------

export const LINE_STATUSES = ["idle", "thinking", "error"] as const;
export const MESSAGE_ROLES = ["user", "assistant", "system"] as const;
export const MESSAGE_STATUSES = ["pending", "done", "error"] as const;
export const MESSAGE_KINDS = ["chat", "branch_card", "branch_marker"] as const;
export const DELTA_KINDS = ["text", "reasoning", "tool"] as const;

export type LineStatus = (typeof LINE_STATUSES)[number];
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type DeltaKind = (typeof DELTA_KINDS)[number];

export const MESSAGE_KIND_CHAT: MessageKind = "chat";
export const MESSAGE_KIND_BRANCH_CARD: MessageKind = "branch_card";
export const MESSAGE_KIND_BRANCH_MARKER: MessageKind = "branch_marker";

/** A suggested landing action of a rolling summary (domain/summary.go). */
export interface SummaryLanding {
  kind: string;
  text: string;
}

/** The structured rolling digest of a line; always an object, lists never null. */
export interface Summary {
  topic: string;
  decisions: string[];
  openQuestions: string[];
  files: string[];
  suggestedLandings: SummaryLanding[];
  updatedAt: string;
}

export interface Line {
  id: string;
  tenantId: string;
  title: string;
  status: LineStatus;
  statusDetail: string;
  /** Runner hints; both may be empty. */
  provider: string;
  model: string;
  unread: number;
  summary: Summary;
  /** Changes of the tree's notes (main line only). */
  notesRevision: number;
  hostMeta: HostMeta;
  lastActivityAt: string;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Cumulative usage of this line's turns (DESIGN §12): input / output tokens and cost. */
  usage: Usage;
  /** B18: the main line's folder ("" = unfiled); always "" on a branch. */
  folder: string;
  /** B18: the main line's tags (normalised: no "#", lower case); always an array, `[]` on a branch. */
  tags: string[];
}

/** `LineView.conversationBranch`: what a branch line says about itself. */
export interface BranchRef {
  parentLineId: string;
  rootLineId: string;
  anchorMessageId: string;
  depth: number;
  purpose: string;
  kind: BranchKind;
  status: BranchStatus;
  origin: BranchOrigin;
}

/** Direct branches under one line, per status. */
export interface BranchCounts {
  open: number;
  merged: number;
  discarded: number;
  promoted: number;
}

/** A line with its place in the tree (`line.created` / `line.updated` payload). */
export interface LineView extends Line {
  /** `null` on a main line. */
  conversationBranch: BranchRef | null;
  branchCounts: BranchCounts;
  branchUnread: number;
  /**
   * Open branches below this line (not itself) whose conclusion-card draft is
   * ready for review. "Waiting for you" = `unread + branchUnread > 0 || awaitingReview > 0`.
   */
  awaitingReview: number;
  /** Open suggestions of the tree (B8; main line only, 0 on a branch); counted whatever the feature switches say. */
  openSuggestions: number;
  /** Open seeds of the tree's parking lot (B8; main line only, 0 on a branch). */
  openSeeds: number;
  /** A main line made by a spinoff points back to where it came from (B8 phase B); null otherwise. */
  spunOffFrom: SpinoffRef | null;
  /** B25: import batch id if created via POST /lines/import with a batchId (kept on attach, cleared on spinoff). */
  importBatchId?: string;
  /** B25: UTC timestamp when the main line was pinned; absent when unpinned or on a branch. */
  pinnedAt?: string;
  /**
   * Open branches of the tree with no activity for longer than the server's
   * stale threshold (B9; main line only, 0 on a branch). Counted whatever the
   * switches say and computed when read: time passing alone sends no event.
   */
  staleBranches: number;
}

/** Where a spinoff came from or went to: the line, the message it forked at, the title then. */
export interface SpinoffRef {
  lineId: string;
  messageId: string;
  title: string;
  /** The other conversation still exists (B8.2, checked when read; a marker's copy in `message.created` is from then). */
  available: boolean;
}

/**
 * Token use and cost. A line's `usage` has the three totals only; a
 * message's `meta.usage` may add the cache counts (omitted when 0;
 * `inputTokens` already includes them).
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** The library-owned part of a message's meta. Every field is omitted when empty. */
export interface MessageMeta {
  /** On an assistant message: who started the turn. */
  actor?: string;
  provider?: string;
  model?: string;
  usage?: Usage;
  durationMs?: number;
  error?: string;
  cancelled?: boolean;
  /** The structured conclusion on a `branch_card` message. */
  card?: BranchCard;
  /** The branch a card came from. */
  branchLineId?: string;
  /** Set once a parent turn that carried this card finished without failing. */
  delivered?: boolean;
  /** B17.1: when the card was last edited after its merge (server clock, UTC); absent when never edited. Kept after delivery. */
  editedAt?: string;
  /** On a pending assistant message: the cards that turn's prompt carried. */
  deliversCards?: string[];
  notesRevision?: number;
  /** On a pending assistant message: the last delta seq already saved into `content`. */
  streamSeq?: number;
  /** Side lines the assistant proposed in this reply. */
  suggestions?: BranchSuggestion[];
  /** On a spinoff's marker (B8 phase B): the new conversation ("已獨立 →"). */
  spunOffTo?: SpinoffRef;
}

/** One transcript entry. `seq` is global and increasing; order a line by `seq`. */
/** Argument types (D2, the ibis feature), in the design's order. */
export const TAG_KINDS = ["question", "idea", "pro", "con", "decision"] as const;
export type TagKind = (typeof TAG_KINDS)[number];
export const TAG_SOURCES = ["ai", "user"] as const;
export type TagSource = (typeof TAG_SOURCES)[number];
/** `draft`: AI's, waiting for the user (suggest mode); the user's are always confirmed. */
export const TAG_STATUSES = ["draft", "confirmed"] as const;
export type TagStatus = (typeof TAG_STATUSES)[number];

/** A message's argument type (B10 phase A); AI never replaces one. */
export interface MessageTag {
  kind: TagKind;
  source: TagSource;
  status: TagStatus;
  updatedAt: string;
}

export interface Message {
  id: string;
  seq: number;
  lineId: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  status: MessageStatus;
  meta: MessageMeta;
  hostMeta: HostMeta;
  createdAt: string;
  /** Pinned by the user (B9, core): always sent to the model once fisheye weighs the context. */
  pinned: boolean;
  /** Its argument type (the ibis feature), only when it has one. */
  tag?: MessageTag;
}

/** One streamed piece of a running turn (`message.delta` payload). */
export interface Delta {
  turnId: string;
  seq: number;
  kind: DeltaKind;
  text: string;
}

// ---------------------------------------------------------------------------
// Branches (domain/branch.go, branch_pack.go, branch_card.go, branch_draft.go)
// ---------------------------------------------------------------------------

export const BRANCH_KINDS = ["aside", "investigate", "alternative"] as const;
export const BRANCH_STATUSES = ["open", "merged", "discarded", "promoted"] as const;
/** `seed`: opened from a parked seed (B8). */
/** `merge`: made by combining open sibling branches (B9 phase C). */
/** `import`: written by `POST /lines/import` (B18). */
export const BRANCH_ORIGINS = ["selection", "button", "move", "suggestion", "previous_main_line", "seed", "merge", "diverge", "import"] as const;
export const BRANCH_DRAFT_STATUSES = ["none", "drafting", "ready", "failed"] as const;

/** `aside` is a one-question branch that ends itself once answered. */
export type BranchKind = (typeof BRANCH_KINDS)[number];
export type BranchStatus = (typeof BRANCH_STATUSES)[number];
export type BranchOrigin = (typeof BRANCH_ORIGINS)[number];
export type BranchDraftStatus = (typeof BRANCH_DRAFT_STATUSES)[number];

/** One row of the outline (`GET /branches`) and the branch header. */
export interface BranchView {
  lineId: string;
  parentLineId: string;
  rootLineId: string;
  anchorMessageId: string;
  depth: number;
  purpose: string;
  kind: BranchKind;
  status: BranchStatus;
  origin: BranchOrigin;
  excerpt: string;
  conclusionLine: string;
  cardMessageId: string;
  provider: string;
  model: string;
  /** The branch line's own status. */
  lineStatus: LineStatus;
  unread: number;
  messageCount: number;
  /** A `BranchDraftStatus`; "" from fixtures that leave it out. */
  draftStatus: BranchDraftStatus | "";
  archived: boolean;
  createdAt: string;
  closedAt: string | null;
  lastActivityAt: string;
  /** The branch's leaf as the outline and the map show it (B8); null when it has none. Kept while the feature is off. */
  leaf: LeafSummary | null;
  /** The branch this one was combined into (B9 phase C; then `status` is `discarded`); "" otherwise. */
  mergedIntoLineId: string;
  /** The argument type of the message it forks from (B10 phase A), only when that has one. */
  anchorTag?: MessageTag;
  /** B17.1: when its conclusion card was last edited (the card's `meta.editedAt`); absent without a card or an edit. */
  cardEditedAt?: string;
  /** B23: when a kept aside was kept (it is not cleared after the retention); absent on an aside nobody kept and on every other branch. */
  keptAt?: string;
}

/** One main-line message quoted in the pack. */
export interface BranchPackMessage {
  id: string;
  seq: number;
  role: MessageRole;
  createdAt: string;
  truncated: boolean;
}

/** The stored background of one branch. */
export interface BranchPack {
  /** The exact text the model receives. */
  rendered: string;
  anchorMessageId: string;
  purpose: string;
  excerpt: string;
  recent: BranchPackMessage[];
  summaryUsed: boolean;
  condensedMessages: number;
  omittedMessages: number;
  droppedRecent: number;
  tokenEstimate: number;
  tokenBudget: number;
  laterIncluded: boolean;
  laterMessages: number;
  laterQuoted: number;
  laterCondensed: number;
}

export interface BranchCardEvidence {
  messageId: string;
  note: string;
}

export interface BranchCardDecision {
  branchClaim: string;
  mainLineClaim: string;
  /** A main-line message written after the fork. The server always sends it ("" when unset); requests omit it when empty. */
  mainLineMessageId?: string;
}

export interface BranchCardExcerpt {
  messageId: string;
  text: string;
}

/** The structured conclusion of a branch. */
export interface BranchCard {
  question: string;
  conclusion: string;
  evidence: BranchCardEvidence[];
  impact: string;
  openItems: string[];
  needsDecision: BranchCardDecision[];
  excerpts: BranchCardExcerpt[];
}

/** One reason a card is refused (`invalid_card` extra `problems`). */
export interface BranchCardProblem {
  field: string;
  message: string;
}

/** `draft` of `GET /branch`; `card` is already sanitised and non-null only when ready. */
export interface BranchDraft {
  status: BranchDraftStatus;
  card: BranchCard | null;
  warnings: string[];
  error: string;
  provider: string;
  model: string;
  startedAt: string | null;
  /** Seq of the newest branch message the draft read; 0 when no draft ran. */
  uptoSeq: number;
  parentTipMessageId: string;
  manualCardAvailable: boolean;
  /** The AI's proposed note changes (notes on, B5); same shape and checks as the user's. */
  noteChanges?: NoteChange[];
}

/** `GET /lines/{id}/branch`. */
export interface BranchDetail {
  branch: BranchView;
  pack: BranchPack;
  draft: BranchDraft;
  /** The parent's newest message now; send back the value seen when the review opened. */
  parentTipMessageId: string;
}

/** One side line an assistant reply proposes (`meta.suggestions`). */
export interface BranchSuggestion {
  purpose: string;
  kind: BranchKind;
  excerpt?: string;
}

// ---------------------------------------------------------------------------
// Notes (domain/notes.go)
// ---------------------------------------------------------------------------

export const NOTE_STATUSES = ["active", "done", "superseded"] as const;

/** A note's section. A newer server may send one this client does not know; `groupNotes` keeps those apart. */
export type NoteSection = "decided" | "fact" | "to_confirm" | "todo";
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export interface Note {
  id: string;
  section: NoteSection;
  text: string;
  status: NoteStatus;
  sourceLineId: string;
  sourceMessageId: string;
  sourceCardMessageId: string;
  supersededBy: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The source's name when the note was written (DESIGN §12), for when the source is gone; only when the server sends it. */
  sourceLabel?: string;
  /** A note copied into a spinoff (B8 phase B `copyNotes`): the original's id; its source fields still name the old conversation. */
  copiedFromNoteId?: string;
}

/** One proposed change to the notes, e.g. sent with a merge. */
export type NoteChange =
  | { op: "add"; section: NoteSection; text: string; sourceLineId?: string; sourceMessageId?: string }
  | { op: "supersede"; noteId: string; section?: NoteSection; text: string; sourceLineId?: string; sourceMessageId?: string };

/** One refused field of a note request (`invalid_note` extra `problems`). */
export interface NoteProblem {
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Chapters (domain/chapters.go)
// ---------------------------------------------------------------------------

export const CHAPTER_KINDS = ["start", "idle", "topic", "milestone"] as const;
export const CHAPTER_TITLE_SOURCES = ["time", "topic", "milestone"] as const;

export type ChapterKind = (typeof CHAPTER_KINDS)[number];
export type ChapterTitleSource = (typeof CHAPTER_TITLE_SOURCES)[number];

export interface Chapter {
  index: number;
  title: string;
  titleSource: ChapterTitleSource;
  kind: ChapterKind;
  /** The milestone that opens this chapter; "" when none. */
  milestoneId: string;
  startMessageId: string;
  endMessageId: string;
  startAt: string;
  endAt: string;
  messageCount: number;
  /** Direct branches whose anchor falls in this chapter (any status). */
  branchIds: string[];
  /** Conclusion-card messages brought back inside this chapter. */
  cardMessageIds: string[];
}

/** A stored topic cut or manual milestone (`domain.ChapterCut`). */
export interface Milestone {
  id: string;
  messageId: string;
  kind: string;
  title: string;
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Prompts (domain/prompt.go) — returned by `POST /lines/{id}/preview`
// ---------------------------------------------------------------------------

export interface PromptSection {
  key: string;
  title: string;
  body: string;
  /** A host section placed in the non-cached tail (B7.1); only present when true. */
  trailing?: true;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface Prompt {
  sections: PromptSection[];
  summary: Summary | null;
  /** Sections after the summary (e.g. the conclusion-card notice); omitted when empty. */
  trailing?: PromptSection[];
  earlier: string;
  history: ChatMessage[];
  userMessage: string;
  notesChanged: boolean;
}

// ---------------------------------------------------------------------------
// P1 feature modules (B8 phase A): leaf, parking, the suggestion inbox
// ---------------------------------------------------------------------------

/** What a branch settled (UI_DESIGN_BRIEF §3 收尾): 結論 / 決定 / 答案 / 死路 / 待續. */
export const LEAF_KINDS = ["conclusion", "decision", "answer", "dead_end", "to_continue"] as const;
export const LEAF_STATUSES = ["draft", "confirmed"] as const;
export type LeafKind = (typeof LEAF_KINDS)[number];
/** `draft`: an AI draft waiting for the user; `confirmed`: written or accepted by the user (or a card, or an auto-mode draft). */
export type LeafStatus = (typeof LEAF_STATUSES)[number];

/** `BranchView.leaf`. */
export interface LeafSummary {
  kind: LeafKind;
  line: string;
  status: LeafStatus;
}

/** A branch's leaf (`GET /lines/{id}/leaf`). */
export interface Leaf extends LeafSummary {
  lineId: string;
  rootLineId: string;
  /** At most 4000 characters, may be "". */
  body: string;
  /** Written by AI and not rewritten by the user since (an auto-mode leaf is confirmed and still true). */
  aiDrafted: boolean;
  /** "" when AI wrote it. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const SEED_STATUSES = ["open", "expanded", "noted", "dropped"] as const;
export type SeedStatus = (typeof SEED_STATUSES)[number];

/** A parked thought (停車場的種子): costs no tokens until it is expanded or noted. */
export interface Seed {
  id: string;
  rootLineId: string;
  /** "" when parked on a line without messages. */
  anchorMessageId: string;
  /** The line that message is on now (B8.1, read each time); "" when there is none any more. */
  anchorLineId: string;
  /** Where it was parked, as written then ("主線 #n", "查證・目的"…; B8.1); "" without a message. */
  sourceLabel: string;
  /** One line, at most 500 characters. */
  text: string;
  status: SeedStatus;
  /** "" until expanded / noted. */
  expandedLineId: string;
  noteId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const SUGGESTION_STATUSES = ["open", "accepted", "dismissed", "expired"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

/** One entry of the suggestion inbox (建議匣): proposed by a feature, never carried out on its own. */
export interface Suggestion {
  id: string;
  rootLineId: string;
  /** The line the suggestion is about; it expires when that branch ends. */
  lineId: string;
  feature: string;
  kind: string;
  /** e.g. "line:<id>" (phase B: "branch:<id>"). */
  targetKey: string;
  /** The feature's own content, kept as sent. */
  payload: Readonly<Record<string, JsonValue>>;
  status: SuggestionStatus;
  createdAt: string;
  decidedAt: string | null;
}

export const LINK_KINDS = ["spinoff", "relation"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** What a relation says (B15): `related` when none was given; `contradicts` feeds 前提已更新. */
export const RELATION_KINDS = ["related", "supports", "contradicts", "depends_on"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** A link between two conversations or nodes (B8 phase B: spinoffs; later, relations). */
export interface Link {
  id: string;
  kind: LinkKind;
  fromLineId: string;
  fromMessageId: string;
  toLineId: string;
  /** "" for a spinoff. */
  toMessageId: string;
  label: string;
  /** Relations only (B15); absent on a spinoff and from a server before B15. */
  relationKind?: RelationKind;
  fromTitle: string;
  toTitle: string;
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// P2 feature modules (B9 phase A): goal, relations (links of kind relation)
// ---------------------------------------------------------------------------

export const GOAL_SOURCES = ["manual", "ai"] as const;
/** `ai`: an accepted AI proposal (text unchanged) or written in auto mode. */
export type GoalSource = (typeof GOAL_SOURCES)[number];

/** A conversation's goal (目標): one line, sent with every prompt of the tree. */
export interface Goal {
  rootLineId: string;
  /** One line, at most 300 characters. */
  text: string;
  source: GoalSource;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
