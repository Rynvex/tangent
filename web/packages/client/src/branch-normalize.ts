/** Normalizers for the branch shapes of the wire (domain/branch*.go). Input is untrusted JSON. */
import { normalizeMessageTag } from "./tag-normalize";
import {
  BRANCH_DRAFT_STATUSES,
  BRANCH_KINDS,
  BRANCH_ORIGINS,
  BRANCH_STATUSES,
  LEAF_KINDS,
  LEAF_STATUSES,
  LINE_STATUSES,
  MESSAGE_ROLES,
  type BranchCard,
  type BranchCounts,
  type BranchDetail,
  type BranchDraft,
  type BranchPack,
  type BranchPackMessage,
  type BranchRef,
  type BranchSuggestion,
  type BranchView,
  type LeafSummary,
  type NoteChange,
  type NoteSection,
} from "./types";
import { bool, count, isObject, list, nullableStr, num, obj, oneOf, str, strings } from "./wire";

export const EMPTY_BRANCH_COUNTS: BranchCounts = { open: 0, merged: 0, discarded: 0, promoted: 0 };

/** Total branches directly under a line, in any status. */
export function totalBranches(counts: BranchCounts): number {
  return counts.open + counts.merged + counts.discarded + counts.promoted;
}

export function normalizeBranchCounts(raw: unknown): BranchCounts {
  const counts = obj(raw);
  return { open: count(counts.open), merged: count(counts.merged), discarded: count(counts.discarded), promoted: count(counts.promoted) };
}

/** `LineView.conversationBranch`; null for a main line or anything that is not an object. */
export function normalizeBranchRef(raw: unknown): BranchRef | null {
  if (!isObject(raw)) return null;
  return {
    parentLineId: str(raw.parentLineId),
    rootLineId: str(raw.rootLineId),
    anchorMessageId: str(raw.anchorMessageId),
    depth: num(raw.depth, 1),
    purpose: str(raw.purpose),
    kind: oneOf(raw.kind, BRANCH_KINDS, "investigate"),
    status: oneOf(raw.status, BRANCH_STATUSES, "open"),
    origin: oneOf(raw.origin, BRANCH_ORIGINS, "button"),
  };
}

/** `BranchView.leaf` (B8): null when absent; an unknown kind reads as a conclusion, an unknown status as confirmed. */
export function normalizeLeafSummary(raw: unknown): LeafSummary | null {
  if (!isObject(raw)) return null;
  return { kind: oneOf(raw.kind, LEAF_KINDS, "conclusion"), line: str(raw.line), status: oneOf(raw.status, LEAF_STATUSES, "confirmed") };
}

/** Defaults for a `BranchView` with missing fields, so the UI never reads `undefined`. */
export function normalizeBranchView(raw: unknown): BranchView {
  const view = obj(raw);
  const createdAt = str(view.createdAt);
  const anchorTag = normalizeMessageTag(view.anchorTag);
  return {
    lineId: str(view.lineId),
    parentLineId: str(view.parentLineId),
    rootLineId: str(view.rootLineId),
    anchorMessageId: str(view.anchorMessageId),
    depth: num(view.depth, 1),
    purpose: str(view.purpose),
    kind: oneOf(view.kind, BRANCH_KINDS, "investigate"),
    status: oneOf(view.status, BRANCH_STATUSES, "open"),
    origin: oneOf(view.origin, BRANCH_ORIGINS, "button"),
    excerpt: str(view.excerpt),
    conclusionLine: str(view.conclusionLine),
    cardMessageId: str(view.cardMessageId),
    provider: str(view.provider),
    model: str(view.model),
    lineStatus: oneOf(view.lineStatus, LINE_STATUSES, "idle"),
    unread: count(view.unread),
    messageCount: count(view.messageCount),
    draftStatus: oneOf(view.draftStatus, [...BRANCH_DRAFT_STATUSES, ""], ""),
    archived: bool(view.archived),
    createdAt,
    closedAt: nullableStr(view.closedAt),
    lastActivityAt: str(view.lastActivityAt, createdAt),
    leaf: normalizeLeafSummary(view.leaf),
    mergedIntoLineId: str(view.mergedIntoLineId),
    ...(anchorTag ? { anchorTag } : {}),
    ...(typeof view.cardEditedAt === "string" && view.cardEditedAt !== "" ? { cardEditedAt: view.cardEditedAt } : {}),
    ...(typeof view.keptAt === "string" && view.keptAt !== "" ? { keptAt: view.keptAt } : {}),
  };
}

/** A card from the wire with every list present; null when it is not an object. */
export function normalizeBranchCard(raw: unknown): BranchCard | null {
  if (!isObject(raw)) return null;
  return {
    question: str(raw.question),
    conclusion: str(raw.conclusion),
    evidence: list(raw.evidence, (item) => ({ messageId: str(obj(item).messageId), note: str(obj(item).note) })),
    impact: str(raw.impact),
    openItems: strings(raw.openItems),
    needsDecision: list(raw.needsDecision, (item) => {
      const decision = obj(item);
      const mainLineMessageId = str(decision.mainLineMessageId);
      return {
        branchClaim: str(decision.branchClaim),
        mainLineClaim: str(decision.mainLineClaim),
        ...(mainLineMessageId ? { mainLineMessageId } : {}),
      };
    }),
    excerpts: list(raw.excerpts, (item) => ({ messageId: str(obj(item).messageId), text: str(obj(item).text) })),
  };
}

export function normalizeBranchSuggestion(raw: unknown): BranchSuggestion {
  const suggestion = obj(raw);
  const excerpt = str(suggestion.excerpt);
  return {
    purpose: str(suggestion.purpose),
    kind: oneOf(suggestion.kind, BRANCH_KINDS, "investigate"),
    ...(excerpt ? { excerpt } : {}),
  };
}

/**
 * One proposed note change as the server writes it (a card draft's
 * `noteChanges`, B5): optional fields only when present, so it round-trips.
 */
export function normalizeNoteChange(raw: unknown): NoteChange {
  const change = obj(raw);
  const source = {
    ...(typeof change.sourceLineId === "string" ? { sourceLineId: change.sourceLineId } : {}),
    ...(typeof change.sourceMessageId === "string" ? { sourceMessageId: change.sourceMessageId } : {}),
  };
  const section = str(change.section) as NoteSection;
  if (change.op === "supersede") return { op: "supersede", noteId: str(change.noteId), ...(section ? { section } : {}), text: str(change.text), ...source };
  return { op: "add", section, text: str(change.text), ...source };
}

export function normalizeBranchDraft(raw: unknown): BranchDraft {
  const draft = obj(raw);
  return {
    status: oneOf(draft.status, BRANCH_DRAFT_STATUSES, "none"),
    card: normalizeBranchCard(draft.card),
    warnings: strings(draft.warnings),
    error: str(draft.error),
    provider: str(draft.provider),
    model: str(draft.model),
    startedAt: nullableStr(draft.startedAt),
    uptoSeq: count(draft.uptoSeq),
    parentTipMessageId: str(draft.parentTipMessageId),
    manualCardAvailable: draft.manualCardAvailable !== false,
    ...(Array.isArray(draft.noteChanges) ? { noteChanges: list(draft.noteChanges, normalizeNoteChange) } : {}),
  };
}

function normalizePackMessage(raw: unknown): BranchPackMessage {
  const message = obj(raw);
  return {
    id: str(message.id),
    seq: count(message.seq),
    role: oneOf(message.role, MESSAGE_ROLES, "system"),
    createdAt: str(message.createdAt),
    truncated: bool(message.truncated),
  };
}

export function normalizeBranchPack(raw: unknown): BranchPack {
  const pack = obj(raw);
  return {
    rendered: str(pack.rendered),
    anchorMessageId: str(pack.anchorMessageId),
    purpose: str(pack.purpose),
    excerpt: str(pack.excerpt),
    recent: list(pack.recent, normalizePackMessage),
    summaryUsed: bool(pack.summaryUsed),
    condensedMessages: count(pack.condensedMessages),
    omittedMessages: count(pack.omittedMessages),
    droppedRecent: count(pack.droppedRecent),
    tokenEstimate: count(pack.tokenEstimate),
    tokenBudget: count(pack.tokenBudget),
    laterIncluded: bool(pack.laterIncluded),
    laterMessages: count(pack.laterMessages),
    laterQuoted: count(pack.laterQuoted),
    laterCondensed: count(pack.laterCondensed),
  };
}

/** `GET /branch` with every field defaulted. */
export function normalizeBranchDetail(raw: unknown): BranchDetail {
  const detail = obj(raw);
  return {
    branch: normalizeBranchView(detail.branch),
    pack: normalizeBranchPack(detail.pack),
    draft: normalizeBranchDraft(detail.draft),
    parentTipMessageId: str(detail.parentTipMessageId),
  };
}
