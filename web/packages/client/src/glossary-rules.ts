/**
 * What the screens ask about the glossary (B24): the key two spellings of a
 * term share, what a save is prefilled with, how a refusal reads and how
 * the list is filtered. Pure logic; the mock applies the same rules
 * (domain/glossary.go). Loads with the glossary's screens, never with the
 * first page.
 */
import { asideAnswer } from "./aside-note";
import { stripMarkers } from "./card-text";
import { TangentError, extraNumber } from "./errors";
import { DEFAULT_TERM_LIMITS, normalizeTerm, type Term, type TermLimits } from "./glossary-routes";
import type { BranchView, Message } from "./types";
import { isObject } from "./wire";

/** Full-width ASCII forms (U+FF01..U+FF5E) and their distance from ASCII. */
const FULL_WIDTH_FIRST = 0xff01;
const FULL_WIDTH_LAST = 0xff5e;
const FULL_WIDTH_OFFSET = FULL_WIDTH_FIRST - 0x21;

/** One character of a key: "" for white space, full-width ASCII folded, lower case (domain.NormalizeTermKey, per rune). */
export function termKeyChar(char: string): string {
  if (/\s/u.test(char)) return "";
  const code = char.codePointAt(0) ?? 0;
  const folded = code >= FULL_WIDTH_FIRST && code <= FULL_WIDTH_LAST ? String.fromCodePoint(code - FULL_WIDTH_OFFSET) : char;
  return folded.toLowerCase();
}

/** domain.NormalizeTermKey: every space removed, full-width ASCII folded to ASCII, lower case. */
export function normalizeTermKey(term: string): string {
  let key = "";
  for (const char of term) key += termKeyChar(char);
  return key;
}

const plain = (text: string) => stripMarkers(text.replace(/\r\n?/g, "\n")).trim();

/** domain.CleanTerm's text: protocol markers removed, one line with single spaces. */
export function cleanTerm(term: string): string {
  return plain(term).split(/\s+/u).filter(Boolean).join(" ");
}

/** domain.CleanTermExplanation's text: protocol markers removed, trimmed, line breaks kept. */
export function cleanTermExplanation(text: string): string {
  return plain(text);
}

const runes = (text: string) => Array.from(text);

/** What stops a save before it is sent, the server's refusals in its order; null when it may go. */
export type TermInputProblem = { field: "term" | "explanation"; kind: "empty" } | { field: "term" | "explanation"; kind: "tooLong"; max: number };

export function termInputProblem(input: { term: string; explanation: string }, limits: TermLimits = DEFAULT_TERM_LIMITS): TermInputProblem | null {
  const term = cleanTerm(input.term);
  if (normalizeTermKey(term) === "") return { field: "term", kind: "empty" };
  if (runes(term).length > limits.termMaxRunes) return { field: "term", kind: "tooLong", max: limits.termMaxRunes };
  const explanation = cleanTermExplanation(input.explanation);
  if (explanation === "") return { field: "explanation", kind: "empty" };
  if (runes(explanation).length > limits.explanationMaxRunes) return { field: "explanation", kind: "tooLong", max: limits.explanationMaxRunes };
  return null;
}

/** The term a save starts with: the selected words when they fit a term, else the fallback (an aside's purpose), else nothing. */
export function prefillTerm(selection: string, fallback = "", limits: TermLimits = DEFAULT_TERM_LIMITS): string {
  for (const candidate of [selection, fallback]) {
    const term = cleanTerm(candidate);
    if (term !== "" && runes(term).length <= limits.termMaxRunes) return term;
  }
  return "";
}

/** The explanation a save starts with: the start of the answer, cut at a paragraph or sentence end when one is near the limit. */
export function prefillExplanation(text: string, limits: TermLimits = DEFAULT_TERM_LIMITS): string {
  const clean = cleanTermExplanation(text);
  const chars = runes(clean);
  if (chars.length <= limits.explanationMaxRunes) return clean;
  const head = chars.slice(0, limits.explanationMaxRunes).join("");
  // A cut in mid-sentence reads as a mistake: back up to the last paragraph or sentence end in the second half.
  const stop = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("。"), head.lastIndexOf(". "), head.lastIndexOf("！"), head.lastIndexOf("？"));
  return (stop > head.length / 2 ? head.slice(0, stop + 1) : head).trim();
}

/** The paragraph of `text` that first mentions `words` (whatever their case), "" without one. */
export function paragraphWith(text: string, words: string): string {
  const needle = words.trim().toLowerCase();
  if (needle === "") return "";
  return text.split(/\n{2,}/).find((paragraph) => paragraph.toLowerCase().includes(needle))?.trim() ?? "";
}

/** What 存進名詞表 was asked about. */
export interface TermPrefillInput {
  /** The selected words (the selection toolbar); none from a message's menu or an aside's own action. */
  selection?: string | undefined;
  /** The message the selection or the menu belongs to. */
  messageId?: string | undefined;
  /** The line's branch when it is one: an aside's words (or its purpose) name its term. */
  branch?: Pick<BranchView, "kind" | "excerpt" | "purpose"> | null | undefined;
  /** The line's messages. */
  messages: readonly Message[];
}

export interface TermPrefill {
  term: string;
  explanation: string;
  /** The message the term is saved from; "" without one. */
  sourceMessageId: string;
}

/**
 * What the save dialog starts with (F19 §2.1). An answered aside: the words
 * it was asked about (else its purpose) and the start of its answer. A short
 * selection: the words as the term, the paragraph around them as the
 * explanation. A long selection or a whole message: its start as the
 * explanation, the term left to write.
 */
export function termPrefill(input: TermPrefillInput, limits: TermLimits = DEFAULT_TERM_LIMITS): TermPrefill {
  const aside = input.branch?.kind === "aside" ? input.branch : null;
  const asideTerm = aside ? prefillTerm(aside.excerpt, aside.purpose, limits) : "";
  const message = input.messageId ? input.messages.find((item) => item.id === input.messageId) : undefined;
  const selection = input.selection?.trim() ?? "";
  if (selection !== "") {
    const sourceMessageId = message?.id ?? "";
    if (!isTermLookup(selection)) return { term: asideTerm, explanation: prefillExplanation(selection, limits), sourceMessageId };
    const around = message && message.role === "assistant" ? paragraphWith(message.content, selection) : "";
    return { term: prefillTerm(selection, "", limits), explanation: prefillExplanation(around, limits), sourceMessageId };
  }
  if (message) return { term: asideTerm, explanation: prefillExplanation(message.content, limits), sourceMessageId: message.id };
  const answer = aside ? asideAnswer(input.messages) : null;
  return { term: asideTerm, explanation: prefillExplanation(answer?.content ?? "", limits), sourceMessageId: answer?.id ?? "" };
}

/** Why a glossary write was refused, as the screens word it. */
export type TermFailure =
  /** The conversation already has this term: `existing` is the stored one (send again with `replace`, or cancel). */
  | { kind: "exists"; existing: Term | null }
  | { kind: "limit"; limit: number }
  /** The term itself is gone (deleted elsewhere). */
  | { kind: "gone" }
  /** The line or message it is saved from is gone. */
  | { kind: "sourceGone" }
  | { kind: "empty"; field: "term" | "explanation" }
  | { kind: "tooLong"; field: "term" | "explanation"; max: number }
  | { kind: "archived" }
  | { kind: "featureOff" }
  | { kind: "other" };

const fieldOf = (error: TangentError): "term" | "explanation" => (error.extra.field === "explanation" ? "explanation" : "term");

export function classifyTermError(error: unknown): TermFailure {
  if (!(error instanceof TangentError)) return { kind: "other" };
  switch (error.code) {
    case "term_exists":
      return { kind: "exists", existing: isObject(error.extra.term) ? normalizeTerm(error.extra.term) : null };
    case "term_limit":
      return { kind: "limit", limit: extraNumber(error, "limit", DEFAULT_TERM_LIMITS.maxTotal) };
    case "term_not_found":
      return { kind: "gone" };
    case "line_not_found":
    case "message_not_found":
      return { kind: "sourceGone" };
    case "invalid_input":
      return error.extra.field === "term" || error.extra.field === "explanation" ? { kind: "empty", field: fieldOf(error) } : { kind: "other" };
    case "too_long": {
      const field = fieldOf(error);
      return { kind: "tooLong", field, max: extraNumber(error, "max", field === "term" ? DEFAULT_TERM_LIMITS.termMaxRunes : DEFAULT_TERM_LIMITS.explanationMaxRunes) };
    }
    case "archived":
      return { kind: "archived" };
    case "feature_disabled":
      return { kind: "featureOff" };
    default:
      return { kind: "other" };
  }
}

/** The terms a filter keeps: the ones whose name holds the query first (in the list's order), then the ones whose explanation does. */
export function filterTerms<T extends Pick<Term, "termKey" | "explanation">>(terms: readonly T[], query: string): T[] {
  const key = normalizeTermKey(query);
  if (key === "") return [...terms];
  const lower = query.trim().toLowerCase();
  const byName = terms.filter((term) => term.termKey.includes(key));
  const byText = terms.filter((term) => !term.termKey.includes(key) && term.explanation.toLowerCase().includes(lower));
  return [...byName, ...byText];
}

/** The search's order (store.SearchTerms): terms that start with the key, then the ones that contain it, each by key. */
export function rankTerms<T extends Pick<Term, "termKey" | "id">>(terms: readonly T[], query: string): T[] {
  const key = normalizeTermKey(query);
  const rank = (term: T) => (term.termKey.startsWith(key) ? 0 : 1);
  return terms
    .filter((term) => key === "" || term.termKey.includes(key))
    .sort((a, b) => rank(a) - rank(b) || (a.termKey < b.termKey ? -1 : a.termKey > b.termKey ? 1 : a.id < b.id ? -1 : 1));
}

/** How long a selection may be for the cross-conversation lookup (F19 §2.4) and for a term's prefill. */
export const TERM_LOOKUP_MAX_RUNES = 60;

/** Whether a selection is worth looking up as a term: not empty, one line, at most 60 characters. */
export function isTermLookup(selection: string): boolean {
  const text = selection.trim();
  return text !== "" && !text.includes("\n") && runes(text).length <= TERM_LOOKUP_MAX_RUNES && normalizeTermKey(text) !== "";
}

/** A term of another conversation that is the selection itself (same key), the newest first; null without one. */
export function askedBefore<T extends Pick<Term, "termKey" | "rootLineId" | "updatedAt">>(hits: readonly T[], selection: string, currentRootLineId: string): T | null {
  const key = normalizeTermKey(selection);
  if (key === "") return null;
  const same = hits.filter((hit) => hit.termKey === key && hit.rootLineId !== currentRootLineId);
  return [...same].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}
