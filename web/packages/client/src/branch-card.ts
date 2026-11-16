import type { MergeBranchBody } from "./api-types";
import { cleanCardText } from "./card-text";
import { charCount } from "./text";
import type { BranchCard, Message, NoteChange } from "./types";

/** Server limits (domain/branch_card.go). */
export const CARD_FIELD_MAX = 2000;
export const CARD_TOTAL_MAX = 12000;
export const CARD_EVIDENCE_MAX = 12;
export const CARD_OPEN_ITEMS_MAX = 10;
export const CARD_DECISIONS_MAX = 8;
export const CARD_EXCERPTS_MAX = 3;
export const CARD_EXCERPT_CHARS_MAX = 1500;

export function emptyCard(): BranchCard {
  return { question: "", conclusion: "", evidence: [], impact: "", openItems: [], needsDecision: [], excerpts: [] };
}

type Decision = BranchCard["needsDecision"][number];

export type CardAction =
  | { type: "setText"; field: "question" | "conclusion" | "impact"; value: string }
  | { type: "addEvidence"; messageId?: string }
  | { type: "setEvidence"; index: number; patch: Partial<BranchCard["evidence"][number]> }
  | { type: "removeEvidence"; index: number }
  | { type: "addOpenItem" }
  | { type: "setOpenItem"; index: number; value: string }
  | { type: "removeOpenItem"; index: number }
  | { type: "addDecision" }
  | { type: "setDecision"; index: number; patch: Partial<Decision> }
  | { type: "removeDecision"; index: number }
  | { type: "addExcerpt"; excerpt: BranchCard["excerpts"][number] }
  | { type: "removeExcerpt"; index: number }
  | { type: "replace"; card: BranchCard };

function setAt<T>(items: readonly T[], index: number, update: (item: T) => T): T[] {
  return items.map((item, i) => (i === index ? update(item) : item));
}

function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}

function appendCapped<T>(items: readonly T[], item: T, max: number): T[] {
  return items.length >= max ? [...items] : [...items, item];
}

/** Pure card editor; list limits are enforced here so the form cannot exceed them. */
export function cardReducer(card: BranchCard, action: CardAction): BranchCard {
  switch (action.type) {
    case "setText":
      return { ...card, [action.field]: action.value };
    case "addEvidence":
      return { ...card, evidence: appendCapped(card.evidence, { messageId: action.messageId ?? "", note: "" }, CARD_EVIDENCE_MAX) };
    case "setEvidence":
      return { ...card, evidence: setAt(card.evidence, action.index, (item) => ({ ...item, ...action.patch })) };
    case "removeEvidence":
      return { ...card, evidence: removeAt(card.evidence, action.index) };
    case "addOpenItem":
      return { ...card, openItems: appendCapped(card.openItems, "", CARD_OPEN_ITEMS_MAX) };
    case "setOpenItem":
      return { ...card, openItems: setAt(card.openItems, action.index, () => action.value) };
    case "removeOpenItem":
      return { ...card, openItems: removeAt(card.openItems, action.index) };
    case "addDecision":
      return { ...card, needsDecision: appendCapped(card.needsDecision, { branchClaim: "", mainLineClaim: "" }, CARD_DECISIONS_MAX) };
    case "setDecision":
      return { ...card, needsDecision: setAt(card.needsDecision, action.index, (item) => ({ ...item, ...action.patch })) };
    case "removeDecision":
      return { ...card, needsDecision: removeAt(card.needsDecision, action.index) };
    case "addExcerpt":
      return { ...card, excerpts: appendCapped(card.excerpts, action.excerpt, CARD_EXCERPTS_MAX) };
    case "removeExcerpt":
      return { ...card, excerpts: removeAt(card.excerpts, action.index) };
    case "replace":
      return action.card;
  }
}

/** Every free-text value of the card, which is what the 12000-character total counts. */
function cardTexts(card: BranchCard): string[] {
  return [
    card.question,
    card.conclusion,
    card.impact,
    ...card.evidence.map((item) => item.note),
    ...card.openItems,
    ...card.needsDecision.flatMap((item) => [item.branchClaim, item.mainLineClaim]),
    ...card.excerpts.map((item) => item.text),
  ];
}

export function cardUsage(card: BranchCard): number {
  return cardTexts(card).reduce((sum, text) => sum + charCount(text), 0);
}

export interface CardProblem {
  field: string;
  /** A translation key suffix: `required`, `tooLong`, `total`, `claim`. */
  code: "required" | "tooLong" | "total" | "claim";
}

/** Checks the card before sending; each problem names the field the form marks. */
export function validateCard(card: BranchCard): CardProblem[] {
  const problems: CardProblem[] = [];
  const text = (field: string, value: string, required = false): void => {
    const length = charCount(value.trim());
    if (required && length === 0) problems.push({ field, code: "required" });
    else if (charCount(value) > CARD_FIELD_MAX) problems.push({ field, code: "tooLong" });
  };
  text("question", card.question, true);
  text("conclusion", card.conclusion, true);
  text("impact", card.impact);
  card.evidence.forEach((item, i) => text(`evidence[${i}].note`, item.note));
  card.openItems.forEach((item, i) => text(`openItems[${i}]`, item, true));
  card.needsDecision.forEach((item, i) => {
    if (!item.branchClaim.trim() && !item.mainLineClaim.trim()) problems.push({ field: `needsDecision[${i}]`, code: "claim" });
    text(`needsDecision[${i}].branchClaim`, item.branchClaim);
    text(`needsDecision[${i}].mainLineClaim`, item.mainLineClaim);
  });
  if (cardUsage(card) > CARD_TOTAL_MAX) problems.push({ field: "card", code: "total" });
  return problems;
}

function nonEmpty(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value !== "");
}

/**
 * A card as a request sends it (merge and B17's edit): empty fields and rows
 * are left out (the server decodes strictly), text trimmed, excerpt text
 * sent as selected.
 */
export function cardRequestBody(card: BranchCard): Partial<BranchCard> {
  const evidence = card.evidence
    .map((item) => ({ messageId: item.messageId.trim(), note: item.note.trim() }))
    .filter((item) => item.messageId !== "");
  const needsDecision = card.needsDecision
    .map((item) => ({
      branchClaim: item.branchClaim.trim(),
      mainLineClaim: item.mainLineClaim.trim(),
      ...(item.mainLineMessageId?.trim() ? { mainLineMessageId: item.mainLineMessageId.trim() } : {}),
    }))
    .filter((item) => item.branchClaim !== "" || item.mainLineClaim !== "");
  const openItems = nonEmpty(card.openItems);
  const impact = card.impact.trim();
  return {
    question: card.question.trim(),
    conclusion: card.conclusion.trim(),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(impact ? { impact } : {}),
    ...(openItems.length > 0 ? { openItems } : {}),
    ...(needsDecision.length > 0 ? { needsDecision } : {}),
    ...(card.excerpts.length > 0 ? { excerpts: card.excerpts.map((item) => ({ messageId: item.messageId, text: item.text })) } : {}),
  };
}

/**
 * The merge request body: the card as `cardRequestBody` sends it, and
 * `parentTipMessageId` is the value seen when the review opened. Note
 * changes ride along only when there are any.
 */
export function buildMergeBody(
  card: BranchCard,
  parentTipMessageId: string,
  confirmParentMoved = false,
  noteChanges: readonly NoteChange[] = [],
): MergeBranchBody {
  return {
    card: cardRequestBody(card),
    parentTipMessageId,
    ...(confirmParentMoved ? { confirmParentMoved: true as const } : {}),
    ...(noteChanges.length > 0 ? { noteChanges: [...noteChanges] } : {}),
  };
}

/** `unclean`: the server would clean it (fence, protocol marker, control character) and then refuse it as not verbatim. */
export type ExcerptRejection = "unknownMessage" | "empty" | "tooLong" | "limit" | "duplicate" | "notVerbatim" | "unclean";

export type ExcerptCheck =
  | { ok: true; excerpt: BranchCard["excerpts"][number] }
  | { ok: false; reason: ExcerptRejection };

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Accepts a selection as an excerpt only when it is a verbatim substring of that
 * message's raw content (CRLF counts as LF), within the length and count limits.
 * The text is kept as selected, newlines included.
 */
export function checkExcerptSelection(
  card: BranchCard,
  messages: readonly Pick<Message, "id" | "role" | "content">[],
  selection: { messageId: string; text: string },
): ExcerptCheck {
  const message = messages.find((item) => item.id === selection.messageId && (item.role === "user" || item.role === "assistant"));
  if (!message) return { ok: false, reason: "unknownMessage" };
  const text = lf(selection.text).trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (card.excerpts.length >= CARD_EXCERPTS_MAX) return { ok: false, reason: "limit" };
  if (charCount(text) > CARD_EXCERPT_CHARS_MAX) return { ok: false, reason: "tooLong" };
  if (card.excerpts.some((item) => item.messageId === message.id && item.text === text)) return { ok: false, reason: "duplicate" };
  if (cleanCardText(text) !== text) return { ok: false, reason: "unclean" };
  if (!lf(message.content).includes(text)) return { ok: false, reason: "notVerbatim" };
  return { ok: true, excerpt: { messageId: message.id, text } };
}
