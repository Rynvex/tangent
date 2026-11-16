import { CARD_FIELD_MAX, CARD_TOTAL_MAX, type BranchCard, type CardProblem } from "@tangent/client";
import type { BundleTranslate } from "../../i18n/bundle";
import type { DialogMessageKey } from "../../i18n/dialog-messages";

type Translate = BundleTranslate<DialogMessageKey>;

function message(problem: CardProblem, t: Translate): string {
  switch (problem.code) {
    case "required":
      if (problem.field === "conclusion") return t("review.conclusionMissing");
      if (problem.field === "question") return t("review.questionMissing");
      return t("branch.purposeRequired");
    case "claim":
      return t("review.claim");
    case "total":
      return t("review.totalTooLong", { limit: CARD_TOTAL_MAX });
    default:
      return t("review.tooLong", { limit: CARD_FIELD_MAX });
  }
}

/**
 * Error text per field path: local problems (missing text only after the
 * first attempt, length problems at once) plus what the server refused.
 */
export function fieldErrors(problems: readonly CardProblem[], attempted: boolean, server: Readonly<Record<string, string[]>>, t: Translate): Record<string, string> {
  const out: Record<string, string[]> = {};
  for (const problem of problems) {
    if (!attempted && (problem.code === "required" || problem.code === "claim")) continue;
    out[problem.field] = [...(out[problem.field] ?? []), message(problem, t)];
  }
  for (const [field, list] of Object.entries(server)) out[field] = [...(out[field] ?? []), ...list];
  return Object.fromEntries(Object.entries(out).map(([field, list]) => [field, list.join(" ")]));
}

/** The card's lists, in form order; a path `section[i]…` lands on row i of that list. */
export const CARD_LISTS = ["evidence", "openItems", "needsDecision", "excerpts"] as const;
export type CardList = (typeof CARD_LISTS)[number];
const SINGLE_FIELDS: ReadonlySet<string> = new Set(["question", "conclusion", "impact", "card"]);
const ROW_PATH = /^(evidence|openItems|needsDecision|excerpts)\[(\d+)\](?:\.(\w+))?$/;

/**
 * The errors of row `index` that none of its inputs shows: the row itself
 * (e.g. "repeats an earlier entry") and sub-fields without an input of their
 * own (`messageId`, `mainLineMessageId`). `shown` names the sub-fields an
 * input renders ("" for the row key when the row is one input).
 */
export function rowError(errors: Readonly<Record<string, string>>, list: CardList, index: number, shown: readonly string[]): string | undefined {
  const texts = Object.entries(errors).flatMap(([field, text]) => {
    const match = ROW_PATH.exec(field);
    if (!match || match[1] !== list || Number(match[2]) !== index) return [];
    return shown.includes(match[3] ?? "") ? [] : [text];
  });
  return texts.length > 0 ? texts.join(" ") : undefined;
}

/** Errors no slot of the form shows (an unknown path, a row the card does not have), as [field, text], for the catch-all list. */
export function strayErrors(errors: Readonly<Record<string, string>>, card: BranchCard): Array<[string, string]> {
  return Object.entries(errors).filter(([field]) => {
    if (SINGLE_FIELDS.has(field) || (CARD_LISTS as readonly string[]).includes(field)) return false;
    const match = ROW_PATH.exec(field);
    return !match || Number(match[2]) >= card[match[1] as CardList].length;
  });
}
