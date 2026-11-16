/** Normalizers for lines, messages and deltas (domain/line.go, summary.go, prompt.go). Input is untrusted JSON. */
import { normalizeBranchCard, normalizeBranchCounts, normalizeBranchRef, normalizeBranchSuggestion } from "./branch-normalize";
import {
  DELTA_KINDS,
  LINE_STATUSES,
  MESSAGE_KINDS,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
  type ChatMessage,
  type Delta,
  type LineView,
  type Message,
  type MessageMeta,
  type Prompt,
  type SpinoffRef,
  type PromptSection,
  type Summary,
  type Usage,
} from "./types";
import { normalizeMessageTag } from "./tag-normalize";
import { bool, count, isObject, json, list, nullableStr, num, obj, oneOf, str, strings } from "./wire";

export function normalizeSummary(raw: unknown): Summary {
  const summary = obj(raw);
  return {
    topic: str(summary.topic),
    decisions: strings(summary.decisions),
    openQuestions: strings(summary.openQuestions),
    files: strings(summary.files),
    suggestedLandings: list(summary.suggestedLandings, (item) => ({ kind: str(obj(item).kind), text: str(obj(item).text) })),
    updatedAt: str(summary.updatedAt),
  };
}

/** A `LineView` with every field present; branch fields default for a main line. */
export function normalizeLine(raw: unknown): LineView {
  const line = obj(raw);
  return {
    id: str(line.id),
    tenantId: str(line.tenantId),
    title: str(line.title),
    status: oneOf(line.status, LINE_STATUSES, "idle"),
    statusDetail: str(line.statusDetail),
    provider: str(line.provider),
    model: str(line.model),
    unread: count(line.unread),
    summary: normalizeSummary(line.summary),
    notesRevision: count(line.notesRevision),
    hostMeta: json(line.hostMeta),
    lastActivityAt: str(line.lastActivityAt),
    archivedAt: nullableStr(line.archivedAt),
    createdBy: str(line.createdBy),
    createdAt: str(line.createdAt),
    updatedAt: str(line.updatedAt),
    conversationBranch: normalizeBranchRef(line.conversationBranch),
    branchCounts: normalizeBranchCounts(line.branchCounts),
    branchUnread: count(line.branchUnread),
    awaitingReview: count(line.awaitingReview),
    openSuggestions: count(line.openSuggestions),
    openSeeds: count(line.openSeeds),
    spunOffFrom: normalizeSpinoffRef(line.spunOffFrom),
    ...(typeof line.importBatchId === "string" && line.importBatchId !== "" ? { importBatchId: line.importBatchId } : {}),
    ...(typeof line.pinnedAt === "string" && line.pinnedAt !== "" ? { pinnedAt: line.pinnedAt } : {}),
    staleBranches: count(line.staleBranches),
    usage: normalizeUsage(line.usage),
    folder: str(line.folder),
    tags: strings(line.tags),
  };
}

/** `spunOffFrom` / `meta.spunOffTo` (B8 phase B); null when absent. */
export function normalizeSpinoffRef(raw: unknown): SpinoffRef | null {
  if (!isObject(raw)) return null;
  return { lineId: str(raw.lineId), messageId: str(raw.messageId), title: str(raw.title), available: raw.available !== false };
}

/** Usage totals; the cache counts are kept only when the server sent them. */
export function normalizeUsage(raw: unknown): Usage {
  const usage = obj(raw);
  return {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    costUsd: count(usage.costUsd),
    ...(typeof usage.cacheReadTokens === "number" ? { cacheReadTokens: count(usage.cacheReadTokens) } : {}),
    ...(typeof usage.cacheWriteTokens === "number" ? { cacheWriteTokens: count(usage.cacheWriteTokens) } : {}),
  };
}

/** The library meta of a message: only the fields that are present and well typed are kept. */
export function normalizeMessageMeta(raw: unknown): MessageMeta {
  const meta = obj(raw);
  const card = normalizeBranchCard(meta.card);
  return {
    ...(typeof meta.actor === "string" ? { actor: meta.actor } : {}),
    ...(typeof meta.provider === "string" ? { provider: meta.provider } : {}),
    ...(typeof meta.model === "string" ? { model: meta.model } : {}),
    ...(isObject(meta.usage) ? { usage: normalizeUsage(meta.usage) } : {}),
    ...(typeof meta.durationMs === "number" ? { durationMs: num(meta.durationMs) } : {}),
    ...(typeof meta.error === "string" ? { error: meta.error } : {}),
    ...(meta.cancelled === true ? { cancelled: true } : {}),
    ...(card ? { card } : {}),
    ...(typeof meta.branchLineId === "string" ? { branchLineId: meta.branchLineId } : {}),
    ...(meta.delivered === true ? { delivered: true } : {}),
    ...(typeof meta.editedAt === "string" && meta.editedAt !== "" ? { editedAt: meta.editedAt } : {}),
    ...(Array.isArray(meta.deliversCards) ? { deliversCards: strings(meta.deliversCards) } : {}),
    ...(typeof meta.notesRevision === "number" ? { notesRevision: count(meta.notesRevision) } : {}),
    ...(typeof meta.streamSeq === "number" ? { streamSeq: count(meta.streamSeq) } : {}),
    ...(Array.isArray(meta.suggestions) ? { suggestions: list(meta.suggestions, normalizeBranchSuggestion) } : {}),
    ...(isObject(meta.spunOffTo) ? { spunOffTo: normalizeSpinoffRef(meta.spunOffTo)! } : {}),
  };
}

export function normalizeMessage(raw: unknown): Message {
  const message = obj(raw);
  const tag = normalizeMessageTag(message.tag);
  return {
    id: str(message.id),
    seq: count(message.seq),
    lineId: str(message.lineId),
    role: oneOf(message.role, MESSAGE_ROLES, "system"),
    kind: oneOf(message.kind, MESSAGE_KINDS, "chat"),
    content: str(message.content),
    status: oneOf(message.status, MESSAGE_STATUSES, "done"),
    meta: normalizeMessageMeta(message.meta),
    hostMeta: json(message.hostMeta),
    createdAt: str(message.createdAt),
    pinned: bool(message.pinned),
    ...(tag ? { tag } : {}),
  };
}

export function normalizeDelta(raw: unknown): Delta {
  const delta = obj(raw);
  return { turnId: str(delta.turnId), seq: count(delta.seq), kind: oneOf(delta.kind, DELTA_KINDS, "text"), text: str(delta.text) };
}

function normalizeChatMessage(raw: unknown): ChatMessage {
  const message = obj(raw);
  return { role: oneOf(message.role, MESSAGE_ROLES, "system"), content: str(message.content) };
}

function normalizeSection(raw: unknown): PromptSection {
  const section = obj(raw);
  return { key: str(section.key), title: str(section.title), body: str(section.body), ...(section.trailing === true ? { trailing: true as const } : {}) };
}

export function normalizePrompt(raw: unknown): Prompt {
  const prompt = obj(raw);
  return {
    sections: list(prompt.sections, normalizeSection),
    summary: isObject(prompt.summary) ? normalizeSummary(prompt.summary) : null,
    ...(Array.isArray(prompt.trailing) ? { trailing: list(prompt.trailing, normalizeSection) } : {}),
    earlier: str(prompt.earlier),
    history: list(prompt.history, normalizeChatMessage),
    userMessage: str(prompt.userMessage),
    notesChanged: bool(prompt.notesChanged),
  };
}
