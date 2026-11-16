/**
 * The wire shapes of the routes B23 added for an aside's fate
 * (docs/devlog/B23-aside-keep-continue-delete.md): `PUT /lines/{id}/branch/keep`,
 * `POST /lines/{id}/branch/continue` and `DELETE /lines/{id}/branch`.
 * Only what the client itself needs lives here (it is in every bundle that
 * builds a client); the rules the screens ask about are in `aside-rules.ts`.
 * Responses are untrusted JSON; the reader fills the defaults.
 */
import { normalizeBranchView } from "./branch-normalize";
import { normalizeLine } from "./line-normalize";
import type { DeleteLineResult } from "./api-types";
import type { BranchView, LineView } from "./types";
import { obj, str } from "./wire";

/** `PUT /lines/{id}/branch/keep`: the aside as it is now (`keptAt` set or gone). */
export interface KeepBranchResult {
  branch: BranchView;
}

/** `POST /lines/{id}/branch/continue` body; all of it may be left out. */
export interface ContinueAsideInput {
  /** The new branch's purpose; the aside's by default. */
  purpose?: string;
  /** `investigate` by default; anything else but `alternative` is `400 kind_unsupported`. */
  kind?: "investigate" | "alternative";
  /** Accepts a branch past the soft depth (`409 depth_soft_limit` otherwise). */
  confirmDeeper?: boolean;
}

/** The branch the aside became, its (new) line, and the aside's line, which no longer exists. */
export interface ContinueAsideResult {
  branch: BranchView;
  line: LineView;
  replacedLineId: string;
}

/** `DELETE /lines/{id}/branch`: the main line that is left and the deleted lines, the branch itself first. */
export type DeleteBranchResult = DeleteLineResult;

export function normalizeContinueAsideResult(raw: unknown): ContinueAsideResult {
  const body = obj(raw);
  return { branch: normalizeBranchView(body.branch), line: normalizeLine(body.line), replacedLineId: str(body.replacedLineId) };
}
