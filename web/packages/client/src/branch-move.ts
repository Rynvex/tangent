import type { MovableBranchKind, MoveBranchInput } from "./api-types";
import { sortBySeq } from "./text";
import type { Message, MessageKind } from "./types";
import { BRANCH_MOVE_MAX } from "./branch-move-limit";

export { BRANCH_MOVE_MAX } from "./branch-move-limit";

/** Characters of each message shown in the move preview. */
export const MOVE_PREVIEW_CHARS = 80;

export type MoveProblem = "notFound" | "mustStartWithUser" | "tooMany" | "notDone" | "protectedMessage" | "noAnchor";

export interface MovePlan {
  /** The messages that would move, oldest first. */
  messages: Message[];
  /** Why the move is not possible; null when it is. */
  problem: MoveProblem | null;
}

/**
 * The tail of the transcript (by seq) from `startId`, and whether the server
 * would accept moving it. `max` is the server's `MoveMaxMessages`.
 */
export function planMove(messages: readonly Message[], startId: string, max = BRANCH_MOVE_MAX): MovePlan {
  const ordered = sortBySeq(messages);
  const index = ordered.findIndex((message) => message.id === startId);
  if (index < 0) return { messages: [], problem: "notFound" };
  const moved = ordered.slice(index);
  return { messages: moved, problem: moveProblem(ordered.slice(0, index), moved, max) };
}

function moveProblem(kept: readonly Message[], moved: readonly Message[], max: number): MoveProblem | null {
  if (moved[0]?.role !== "user") return "mustStartWithUser";
  if (moved.length > max) return "tooMany";
  if (moved.some((message) => message.status !== "done")) return "notDone";
  if (moved.some((message) => isProtectedKind(message.kind))) return "protectedMessage";
  // The branch forks from the last user or assistant message that stays behind.
  if (!kept.some((message) => message.role === "user" || message.role === "assistant")) return "noAnchor";
  return null;
}

function isProtectedKind(kind: MessageKind): boolean {
  return kind === "branch_card" || kind === "branch_marker";
}

/** One-line preview of a message for the move list. */
export function previewLine(message: Pick<Message, "content">): string {
  const flat = message.content.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > MOVE_PREVIEW_CHARS ? `${chars.slice(0, MOVE_PREVIEW_CHARS).join("")}…` : flat;
}

export interface MoveFormState {
  purpose: string;
  count: number;
  kind: MovableBranchKind;
  /** The provider picked for the branch; "" keeps the source's. */
  provider: string;
  /** The source line's provider. */
  mainProvider: string;
  model: string;
}

/** Builds the `POST /branches/move` body: the provider is sent only when it differs from the source's. */
export function buildMoveInput(form: MoveFormState): MoveBranchInput {
  const model = form.model.trim();
  return {
    purpose: form.purpose.trim(),
    count: form.count,
    kind: form.kind,
    ...(form.provider && form.provider !== form.mainProvider ? { provider: form.provider } : {}),
    ...(model ? { model } : {}),
  };
}
