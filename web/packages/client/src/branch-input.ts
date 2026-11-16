import type { CreateBranchInput } from "./api-types";
import { charCount, sortBySeq, truncateChars } from "./text";
import type { BranchKind, Message } from "./types";

/** Default server limits (domain.DefaultLimits().Branch); hosts may change them, so functions take them as parameters. */
export const BRANCH_PURPOSE_MAX = 200;
export const BRANCH_EXCERPT_MAX = 1500;
/** Characters of a selection used to prefill the purpose. */
export const PURPOSE_PREFILL_CHARS = 40;
/** Messages the background pack quotes verbatim (domain.DefaultLimits().Pack.RecentMessages). */
export const BRANCH_PACK_RECENT = 8;

export interface PreparedExcerpt {
  /** The text to send; empty when nothing was selected. */
  text: string;
  /** True when the selection was longer than the limit and got cut. */
  truncated: boolean;
}

/** The selection to send, cut to `max` characters (the server's `ExcerptMaxRunes`). */
export function prepareExcerpt(selected: string, max = BRANCH_EXCERPT_MAX): PreparedExcerpt {
  const trimmed = selected.trim();
  return { text: truncateChars(trimmed, max), truncated: charCount(trimmed) > max };
}

/** First words of a selection as a one-line purpose the user can edit. */
export function prefillPurpose(excerpt: string): string {
  return truncateChars(excerpt.replace(/\s+/g, " ").trim(), PURPOSE_PREFILL_CHARS);
}

export type PurposeProblem = "required" | "tooLong" | null;

/** `max` is the server's `PurposeMaxRunes`. */
export function validatePurpose(purpose: string, max = BRANCH_PURPOSE_MAX): PurposeProblem {
  const length = charCount(purpose.trim());
  if (length === 0) return "required";
  return length > max ? "tooLong" : null;
}

export interface BranchFormState {
  purpose: string;
  kind: BranchKind;
  anchorMessageId: string;
  excerpt: string;
  /** The provider picked for the branch; "" keeps the parent's. */
  provider: string;
  /** The parent line's provider. */
  mainProvider: string;
  model: string;
  includeLater?: boolean;
}

/** How many finished user and assistant messages follow the anchor in the parent line (by seq). */
export function countLaterMessages(messages: readonly Message[], anchorMessageId: string): number {
  const ordered = sortBySeq(messages);
  const index = ordered.findIndex((message) => message.id === anchorMessageId);
  if (index < 0) return 0;
  return ordered.slice(index + 1).filter((m) => m.status === "done" && (m.role === "user" || m.role === "assistant")).length;
}

/** Builds the POST body: the provider is sent only when it differs from the parent's. */
export function buildCreateInput(form: BranchFormState): CreateBranchInput {
  const model = form.model.trim();
  return {
    purpose: form.purpose.trim(),
    kind: form.kind,
    anchorMessageId: form.anchorMessageId,
    ...(form.excerpt ? { excerpt: form.excerpt } : {}),
    ...(form.provider && form.provider !== form.mainProvider ? { provider: form.provider } : {}),
    ...(model ? { model } : {}),
    ...(form.includeLater ? { includeLater: true } : {}),
  };
}

/** An assistant suggestion the dialog was opened from (A12). */
export interface AcceptedSuggestion {
  /** The assistant message that proposed it. */
  messageId: string;
  purpose: string;
  kind: BranchKind;
}

/**
 * Adds `suggestionMessageId` only when the user kept the suggestion's purpose
 * and kind: an edited suggestion is an ordinary branch (following host convention).
 */
export function withSuggestion(input: CreateBranchInput, suggestion: AcceptedSuggestion | null | undefined): CreateBranchInput {
  if (!suggestion) return input;
  const unchanged = input.purpose === suggestion.purpose.trim() && input.kind === suggestion.kind;
  return unchanged ? { ...input, suggestionMessageId: suggestion.messageId } : input;
}

/** Minimal shape of the DOM `Selection` the resolver needs (so tests need no real range). */
export interface SelectionLike {
  isCollapsed: boolean;
  anchorNode: Node | null;
  focusNode: Node | null;
  toString(): string;
}

export interface MessageSelection {
  messageId: string;
  text: string;
  /**
   * False inside a row marked `data-forkable="false"` (a conclusion card, a
   * move marker): it can be saved to the notes, but no branch can start
   * there (the server answers anchor_not_found).
   */
  forkable: boolean;
}

function messageOf(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>("[data-message-id]") ?? null;
}

/** Whether anything is selected at all (not just a caret or white space), wherever it is. */
export function hasSelectedText(selection: SelectionLike | null): boolean {
  return selection !== null && !selection.isCollapsed && selection.toString().trim() !== "";
}

/**
 * The selected text and its message, only when the whole selection sits inside
 * one message of `container`; a selection spanning messages (or leaving the
 * thread) is ignored. Callers that open a branch must also check `forkable`.
 */
export function resolveMessageSelection(selection: SelectionLike | null, container: Element | null): MessageSelection | null {
  if (!selection || !container || selection.isCollapsed) return null;
  const start = messageOf(selection.anchorNode);
  const end = messageOf(selection.focusNode);
  if (!start || start !== end || !container.contains(start)) return null;
  const text = selection.toString().trim();
  const messageId = start.dataset.messageId;
  return text && messageId ? { messageId, text, forkable: start.dataset.forkable !== "false" } : null;
}
