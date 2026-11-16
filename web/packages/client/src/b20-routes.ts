/**
 * The route B20 added (docs/devlog/B20-attach-line-and-f14-1-polish.md):
 * `POST /lines/{id}/attach`, the inverse of a detach. Another main line of
 * the tenant, with its whole tree, becomes a branch of the line: its
 * messages and their seq stay, its branches go one level deeper, its notes,
 * memos, seeds, leaves, chapter cuts, suggestions and groups move to the
 * line's conversation, and its folder and tags go. Responses are untrusted
 * JSON; the reader fills the defaults.
 */
import { normalizeBranchView } from "./branch-normalize";
import { TangentError } from "./errors";
import { normalizeLine, normalizeMessage } from "./line-normalize";
import type { BranchCard, BranchView, LineView, Message } from "./types";
import { obj, strings } from "./wire";

/** `POST /lines/{id}/attach` body. */
export interface AttachLineInput {
  /** A main line of the tenant (not a branch, not this conversation's main line). */
  sourceLineId: string;
  /** A finished message of the line (or a card on it); left out, the server picks the newest one not after the source started, else the newest. */
  anchorMessageId?: string;
  /** Left out: the source's title, else its first question. */
  purpose?: string;
  /** `investigate` by default; `aside` is `400 kind_unsupported`. */
  kind?: "investigate" | "alternative";
  /** `open` by default; `merged` must carry `card` (an empty question takes the purpose) and leaves it on the line, already delivered. */
  status?: "open" | "merged";
  card?: Partial<BranchCard>;
  /** Accepts a source tree that would go past the soft depth. */
  confirmDeeper?: boolean;
}

/** The line it now hangs on, the new branch, the source as a branch line, the card left on the line (merged) and the source's branches that came along. */
export interface AttachLineResult {
  targetLine: LineView;
  branch: BranchView;
  branchLine: LineView;
  cardMessage: Message | null;
  reparented: string[];
}

export function normalizeAttachResult(raw: unknown): AttachLineResult {
  const body = obj(raw);
  const card = body.cardMessage;
  return {
    branch: normalizeBranchView(body.branch),
    branchLine: normalizeLine(body.branchLine),
    cardMessage: card && typeof card === "object" ? normalizeMessage(card) : null,
    reparented: strings(body.reparented),
    targetLine: normalizeLine(body.targetLine),
  };
}

/** Why an attach was refused, as the dialog words it. */
export type AttachFailure =
  | { kind: "notMainLine" }
  | { kind: "busy" }
  | { kind: "archived" }
  | { kind: "closed" }
  | { kind: "limit" }
  | { kind: "deeper"; depth: number }
  | { kind: "noAnchor" }
  | { kind: "invalidCard" }
  | { kind: "gone" }
  | { kind: "other"; error: unknown };

export function classifyAttachError(error: unknown): AttachFailure {
  if (!(error instanceof TangentError)) return { kind: "other", error };
  switch (error.code) {
    case "invalid_input":
      return error.extra.field === "sourceLineId" ? { kind: "notMainLine" } : { kind: "other", error };
    case "source_busy":
    case "branch_busy":
    case "branch_drafting":
      return { kind: "busy" };
    case "archived":
      return { kind: "archived" };
    case "parent_closed":
      return { kind: "closed" };
    case "branch_limit":
    case "tree_limit":
    case "depth_hard_limit":
      return { kind: "limit" };
    case "depth_soft_limit":
      return { kind: "deeper", depth: typeof error.extra.depth === "number" ? error.extra.depth : 0 };
    case "move_no_anchor":
    case "anchor_not_found":
      return { kind: "noAnchor" };
    case "invalid_card":
      return { kind: "invalidCard" };
    case "line_not_found":
      return { kind: "gone" };
    default:
      return { kind: "other", error };
  }
}
