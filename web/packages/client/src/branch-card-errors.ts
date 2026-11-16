import { TangentError } from "./errors";
import type { BranchCardProblem } from "./types";

export type ReturnStateCode = "branch_busy" | "branch_closed" | "parent_closed" | "archived";

export type ReturnFailure =
  | { kind: "invalid_card"; problems: BranchCardProblem[] }
  | { kind: "invalid_parent_tip" }
  | { kind: "parent_busy" }
  | { kind: "parent_moved"; movedMessages: number; movedCards: number }
  | { kind: "payload_too_large" }
  | { kind: "state"; code: ReturnStateCode }
  | { kind: "other"; message: string };

const STATE_CODES: readonly ReturnStateCode[] = ["branch_busy", "branch_closed", "parent_closed", "archived"];
const HTTP_TOO_LARGE = 413;

function positive(extra: Readonly<Record<string, unknown>>, key: string): number {
  const value = extra[key];
  return typeof value === "number" && value > 0 ? value : 0;
}

function readProblems(extra: Readonly<Record<string, unknown>>): BranchCardProblem[] {
  const raw = extra.problems;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const entry = item as { field?: unknown; message?: unknown };
    return typeof entry.field === "string" && typeof entry.message === "string" ? [{ field: entry.field, message: entry.message }] : [];
  });
}

/**
 * Sorts a failed `POST /branch/merge` into what the dialog must show or offer.
 * The code decides; only a 413 (no envelope from the body limit) goes by status.
 */
export function classifyReturnError(error: unknown): ReturnFailure {
  if (!(error instanceof TangentError)) return { kind: "other", message: error instanceof Error ? error.message : "" };
  if (error.status === HTTP_TOO_LARGE) return { kind: "payload_too_large" };
  switch (error.code) {
    case "invalid_card":
      return { kind: "invalid_card", problems: readProblems(error.extra) };
    case "invalid_parent_tip":
      return { kind: "invalid_parent_tip" };
    case "parent_busy":
      return { kind: "parent_busy" };
    case "parent_moved":
      return { kind: "parent_moved", movedMessages: positive(error.extra, "movedMessages"), movedCards: positive(error.extra, "movedCards") };
  }
  const state = STATE_CODES.find((value) => value === error.code);
  if (state) return { kind: "state", code: state };
  return { kind: "other", message: error.message };
}

/** Groups the server's problems by the field path the form marks (`card` for whole-card problems). */
export function problemsByField(problems: readonly BranchCardProblem[]): Record<string, string[]> {
  return problems.reduce<Record<string, string[]>>(
    (grouped, problem) => ({ ...grouped, [problem.field]: [...(grouped[problem.field] ?? []), problem.message] }),
    {},
  );
}

/** The field to scroll to first: problems come in card order, `card` itself last. */
export function firstProblemField(problems: readonly BranchCardProblem[]): string | null {
  return (problems.find((item) => item.field !== "card") ?? problems[0])?.field ?? null;
}
