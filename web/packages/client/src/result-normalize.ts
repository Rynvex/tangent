/**
 * Normalizers for the response bodies of api-types.ts. `createTangentClient`
 * runs every 2xx body through one of these; contract.test.ts checks each one
 * against the server's contract samples.
 */
import type {
  ArchiveResult,
  BranchList,
  CancelResult,
  DeleteLineResult,
  CreateBranchResult,
  DiscardBranchResult,
  JobStarted,
  LinePage,
  MergeBranchResult,
  MessagePage,
  MoveBranchResult,
  NotesView,
  NoteWriteResult,
  PreviewBlock,
  PreviewTurnResult,
  PromoteBranchResult,
  SendMessageResult,
  StreamPage,
} from "./api-types";
import { normalizeBranchPack, normalizeBranchView } from "./branch-normalize";
import { normalizeAppliedFold, normalizeFisheye, normalizePromptBudget } from "./fisheye";
import { normalizeRecalledMemory } from "./memory-routes";
import { normalizeDelta, normalizeLine, normalizeMessage, normalizePrompt } from "./line-normalize";
import { MESSAGE_ROLES, NOTE_STATUSES, type Note, type NoteSection } from "./types";
import { bool, count, isObject, list, num, obj, oneOf, str, strings } from "./wire";

/** Domain default note limits (domain.DefaultLimits().Notes), used when a body lacks them. */
export const DEFAULT_NOTE_LIMITS = { maxActive: 200, maxTotal: 1000, maxRunes: 400, maxChangesPerMerge: 10 } as const;

export function normalizeLinePage(raw: unknown): LinePage {
  const page = obj(raw);
  return { lines: list(page.lines, normalizeLine), nextCursor: str(page.nextCursor) };
}

export function normalizeMessagePage(raw: unknown): MessagePage {
  return { messages: list(obj(raw).messages, normalizeMessage) };
}

export function normalizeDeleteLineResult(raw: unknown): DeleteLineResult {
  const body = obj(raw);
  return { rootLineId: str(body.rootLineId), lineIds: strings(body.lineIds) };
}

export function normalizeArchiveResult(raw: unknown): ArchiveResult {
  return { lines: list(obj(raw).lines, normalizeLine) };
}

export function normalizeStreamPage(raw: unknown): StreamPage {
  const body = obj(raw);
  return { deltas: list(body.deltas, normalizeDelta), seq: count(body.seq), truncated: bool(body.truncated) };
}

export function normalizeCancelResult(raw: unknown): CancelResult {
  const body = obj(raw);
  return { cancelled: bool(body.cancelled), line: normalizeLine(body.line), message: isObject(body.message) ? normalizeMessage(body.message) : null };
}

export function normalizeSendResult(raw: unknown): SendMessageResult {
  const body = obj(raw);
  return { turnId: str(body.turnId), userMessage: normalizeMessage(body.userMessage), pendingMessage: normalizeMessage(body.pendingMessage) };
}

function normalizePreviewBlock(raw: unknown): PreviewBlock {
  const block = obj(raw);
  return {
    key: str(block.key),
    ...(typeof block.role === "string" ? { role: oneOf(block.role, MESSAGE_ROLES, "system") } : {}),
    content: str(block.content),
    tokens: count(block.tokens),
  };
}

export function normalizePreviewResult(raw: unknown): PreviewTurnResult {
  const body = obj(raw);
  return {
    prompt: normalizePrompt(body.prompt),
    blocks: list(body.blocks, normalizePreviewBlock),
    totalTokens: count(body.totalTokens),
    provider: str(body.provider),
    model: str(body.model),
    ...(typeof body.estimatedCostUsd === "number" ? { estimatedCostUsd: num(body.estimatedCostUsd) } : {}),
    budget: normalizePromptBudget(body.budget),
    ...(isObject(body.fisheye) ? { fisheye: normalizeFisheye(body.fisheye)! } : {}),
    ...(Array.isArray(body.folds) ? { folds: list(body.folds, normalizeAppliedFold) } : {}),
    ...(Array.isArray(body.memories) ? { memories: list(body.memories, normalizeRecalledMemory) } : {}),
  };
}

export function normalizeJobStarted(raw: unknown): JobStarted {
  const body = obj(raw);
  return {
    jobId: str(body.jobId),
    kind: str(body.kind),
    lineId: str(body.lineId),
    ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
  };
}

export function normalizeBranchList(raw: unknown): BranchList {
  return { branches: list(obj(raw).branches, normalizeBranchView) };
}

export function normalizeCreateBranchResult(raw: unknown): CreateBranchResult {
  const body = obj(raw);
  return { branch: normalizeBranchView(body.branch), line: normalizeLine(body.line), pack: normalizeBranchPack(body.pack) };
}

export function normalizeMoveBranchResult(raw: unknown): MoveBranchResult {
  const body = obj(raw);
  return {
    line: normalizeLine(body.line),
    branch: normalizeBranchView(body.branch),
    marker: normalizeMessage(body.marker),
    sourceLineId: str(body.sourceLineId),
    rootLineId: str(body.rootLineId),
    movedMessageIds: strings(body.movedMessageIds),
    reparented: strings(body.reparented),
    summaryReset: bool(body.summaryReset),
  };
}

/** A note; an unknown section is kept as sent (see `groupNotes`). */
export function normalizeNote(raw: unknown): Note {
  const note = obj(raw);
  return {
    id: str(note.id),
    section: str(note.section) as NoteSection,
    text: str(note.text),
    status: oneOf(note.status, NOTE_STATUSES, "active"),
    sourceLineId: str(note.sourceLineId),
    sourceMessageId: str(note.sourceMessageId),
    sourceCardMessageId: str(note.sourceCardMessageId),
    supersededBy: str(note.supersededBy),
    createdBy: str(note.createdBy),
    createdAt: str(note.createdAt),
    updatedAt: str(note.updatedAt),
    ...(str(note.sourceLabel) !== "" ? { sourceLabel: str(note.sourceLabel) } : {}),
    ...(str(note.copiedFromNoteId) !== "" ? { copiedFromNoteId: str(note.copiedFromNoteId) } : {}),
  };
}

export function normalizeMergeBranchResult(raw: unknown): MergeBranchResult {
  const body = obj(raw);
  const notes = obj(body.notes);
  return {
    branch: normalizeBranchView(body.branch),
    message: normalizeMessage(body.message),
    line: normalizeLine(body.line),
    ...(isObject(body.notes)
      ? {
          notes: {
            rootLineId: str(notes.rootLineId),
            revision: count(notes.revision),
            created: list(notes.created, normalizeNote),
            superseded: list(notes.superseded, normalizeNote),
          },
        }
      : {}),
  };
}

export function normalizeDiscardResult(raw: unknown): DiscardBranchResult {
  return { branch: normalizeBranchView(obj(raw).branch) };
}

export function normalizePromoteResult(raw: unknown): PromoteBranchResult {
  const body = obj(raw);
  return {
    branch: normalizeBranchView(body.branch),
    previousMainLine: normalizeBranchView(body.previousMainLine),
    line: normalizeLine(body.line),
    reparented: strings(body.reparented),
  };
}

function positive(value: unknown, fallback: number): number {
  return count(value) || fallback;
}

export function normalizeNotesView(raw: unknown): NotesView {
  const body = obj(raw);
  const limits = obj(body.limits);
  return {
    rootLineId: str(body.rootLineId),
    revision: count(body.revision),
    notes: list(body.notes, normalizeNote),
    limits: {
      maxActive: positive(limits.maxActive, DEFAULT_NOTE_LIMITS.maxActive),
      maxTotal: positive(limits.maxTotal, DEFAULT_NOTE_LIMITS.maxTotal),
      maxRunes: positive(limits.maxRunes, DEFAULT_NOTE_LIMITS.maxRunes),
      maxChangesPerMerge: positive(limits.maxChangesPerMerge, DEFAULT_NOTE_LIMITS.maxChangesPerMerge),
      ...(typeof limits.tokenBudget === "number" && limits.tokenBudget > 0 ? { tokenBudget: limits.tokenBudget } : {}),
    },
  };
}

export function normalizeNoteWriteResult(raw: unknown): NoteWriteResult {
  const body = obj(raw);
  return {
    note: normalizeNote(body.note),
    ...(isObject(body.superseded) ? { superseded: normalizeNote(body.superseded) } : {}),
    revision: count(body.revision),
    rootLineId: str(body.rootLineId),
  };
}
