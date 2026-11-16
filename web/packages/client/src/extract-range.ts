/**
 * What `POST /branches/extract` (B18) would accept, worked out before the
 * dialog opens (F13 S3, coordinator decision #4):
 * - the start is a finished user message with something before it to hang
 *   the branch on (a finished user / assistant message or a conclusion
 *   card); opened from a reply, the start moves up to that turn's question;
 * - the end is any finished message after it, up to 40 in all, stopping
 *   before the next conclusion card, move marker, failed or unfinished
 *   message, host system message or chapter cut, and before a message a
 *   merged branch hangs on whose card stays on this line (the server's
 *   `move_protected_message`).
 */
import { EXTRACT_MAX_MESSAGES } from "./b18-routes";
import { canAnchorBranch } from "./b17-card-state";
import { sortBySeq } from "./text";
import type { BranchView, Message } from "./types";

export type ExtractStartProblem =
  /** Nothing before the start to hang the branch on (the first turn). */
  | "noAnchor"
  /** The start is not a finished user / assistant message, or its turn has no question. */
  | "notExtractable"
  /** A branch brought back from the start keeps its card on this line. */
  | "protected";

export interface ExtractStart {
  /** The message the range starts at (the trigger, or its turn's question). */
  startId: string | null;
  /** The trigger was a reply and the start moved up to its question. */
  aligned: boolean;
  problem: ExtractStartProblem | null;
}

export const isExtractable = (message: Pick<Message, "role" | "kind" | "status">) =>
  message.status === "done" && message.kind === "chat" && (message.role === "user" || message.role === "assistant");

/** Messages that hold a merged branch whose card is on this line (moving them would leave the card behind). */
export function protectedAnchors(messages: readonly Message[], branches: readonly BranchView[]): Set<string> {
  const cards = new Set(messages.filter((message) => message.kind === "branch_card").map((message) => message.id));
  return new Set(branches.filter((branch) => branch.cardMessageId && cards.has(branch.cardMessageId)).map((branch) => branch.anchorMessageId));
}

/** Where a range opened from `triggerId` starts, and whether it can. */
export function extractStart(messages: readonly Message[], triggerId: string, branches: readonly BranchView[] = []): ExtractStart {
  const ordered = sortBySeq(messages);
  let index = ordered.findIndex((message) => message.id === triggerId);
  if (index < 0 || !isExtractable(ordered[index]!)) return { startId: null, aligned: false, problem: "notExtractable" };
  let aligned = false;
  if (ordered[index]!.role === "assistant") {
    // The reply's turn starts at the newest user message before it, with only finished replies in between.
    let at = index - 1;
    while (at >= 0 && isExtractable(ordered[at]!) && ordered[at]!.role === "assistant") at -= 1;
    if (at < 0 || !isExtractable(ordered[at]!) || ordered[at]!.role !== "user") return { startId: null, aligned: true, problem: "notExtractable" };
    index = at;
    aligned = true;
  }
  const start = ordered[index]!;
  if (!ordered.slice(0, index).some(canAnchorBranch)) return { startId: start.id, aligned, problem: "noAnchor" };
  if (protectedAnchors(ordered, branches).has(start.id)) return { startId: start.id, aligned, problem: "protected" };
  return { startId: start.id, aligned, problem: null };
}

/**
 * The messages the range may end at, oldest first (the start itself
 * included): every one up to the first boundary, at most 40 in all.
 * `cutMessageIds` are the messages that start a chapter.
 */
export function extractEndChoices(messages: readonly Message[], startId: string, branches: readonly BranchView[] = [], cutMessageIds: ReadonlySet<string> = new Set(), max = EXTRACT_MAX_MESSAGES): Message[] {
  const ordered = sortBySeq(messages);
  const index = ordered.findIndex((message) => message.id === startId);
  if (index < 0) return [];
  const guarded = protectedAnchors(ordered, branches);
  const out: Message[] = [];
  for (let i = index; i < ordered.length && out.length < max; i += 1) {
    const message = ordered[i]!;
    if (!isExtractable(message) || guarded.has(message.id)) break;
    if (i > index && cutMessageIds.has(message.id)) break;
    out.push(message);
  }
  return out;
}

/** The default end: the last reply before the first boundary (the start when the range has no reply). */
export function defaultExtractEnd(choices: readonly Message[]): Message | null {
  return [...choices].reverse().find((message) => message.role === "assistant") ?? choices.at(-1) ?? null;
}

/** The newest message before the start a branch can hang on (the server picks the same one). */
export function extractAnchor(messages: readonly Message[], startId: string): Message | null {
  const ordered = sortBySeq(messages);
  const index = ordered.findIndex((message) => message.id === startId);
  return index <= 0 ? null : ([...ordered.slice(0, index)].reverse().find(canAnchorBranch) ?? null);
}

/** A reply's first sentence on one line (as the server's decompose prefills a conclusion), cut to `max` characters. */
export function firstSentence(text: string, max = 200): string {
  const chars = Array.from(text.trim());
  let end = chars.length;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!;
    if (char === "\n" || char === "。" || char === "！" || char === "？") {
      end = i + 1;
      break;
    }
    if ((char === "." || char === "!" || char === "?") && (i + 1 === chars.length || /\s/.test(chars[i + 1]!))) {
      end = i + 1;
      break;
    }
  }
  const flat = chars.slice(0, end).join("").replace(/\s+/g, " ").trim();
  return Array.from(flat).length <= max ? flat : `${Array.from(flat).slice(0, max - 1).join("").trim()}…`;
}
