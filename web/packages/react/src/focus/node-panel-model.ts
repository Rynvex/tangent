/**
 * The node panel's rules as pure functions (FOCUS_MODE.md §7, §8), so they
 * are tested without rendering: where a node forks from, which notes it is
 * the source of, what 帶進這一輪 writes, and where 從這裡繼續談 forks.
 */
import { chatMessages, isHostNotice, noteSectionGroups, type BranchView, type Message, type Note } from "@tangent/client";

/** The panel's purpose limit (`PATCH /lines/{id}/branch`, ≤ 200 characters). */
export const PANEL_PURPOSE_MAX = 200;

export type ForkPlace = { kind: "main"; n: number | null } | { kind: "parent"; title: string; n: number | null };

/** Where a branch forks: the main line's #n, or #n of its parent branch (n unknown while the parent's messages load). */
export function forkPlace(branch: BranchView, branches: readonly BranchView[], parentNumbers: ReadonlyMap<string, number>): ForkPlace {
  const n = parentNumbers.get(branch.anchorMessageId) ?? null;
  if (branch.parentLineId === branch.rootLineId) return { kind: "main", n };
  const parent = branches.find((item) => item.lineId === branch.parentLineId);
  return { kind: "parent", title: parent?.purpose ?? "", n };
}

/** The notes written on this node (source line), in the notes page's section order; replaced ones are left out. */
export function notesOfNode(notes: readonly Note[], lineId: string): Note[] {
  return noteSectionGroups(notes.filter((note) => note.sourceLineId === lineId)).flatMap((group) => group.items);
}

/** 帶進這一輪 (§8.3): the note goes first in the draft, a blank line before what was there. */
export function prependToDraft(draft: string, block: string): string {
  return draft.trim() === "" ? block : `${block}\n\n${draft}`;
}

/** The line's last finished chat message, a host's notice aside: where 開支線 and 從這裡繼續談 fork. */
export function lastForkableId(messages: readonly Message[]): string | null {
  return (
    chatMessages(messages)
      .filter((message) => message.status === "done" && message.role !== "system" && !isHostNotice(message))
      .at(-1)?.id ?? null
  );
}

/** A note's first line, cut to the purpose limit (§8.3). */
export function purposeFromNote(text: string): string {
  const first = text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  return Array.from(first).slice(0, PANEL_PURPOSE_MAX).join("");
}

export interface ContinuePlace {
  /** The line the new branch hangs from. */
  lineId: string;
  anchorMessageId: string;
  /** The node has ended: the branch forks where the node did, from its parent (the dialog says so). */
  fromParent: boolean;
}

/**
 * Where 從這裡繼續談 forks: the node's last message while it is open (or the
 * main line); an ended branch's own fork point on its parent otherwise.
 * Null when the line has no message to fork from yet.
 */
export function continuePlace(branch: BranchView | null, lineId: string, lastMessageId: string | null): ContinuePlace | null {
  if (branch && branch.status !== "open") return { lineId: branch.parentLineId, anchorMessageId: branch.anchorMessageId, fromParent: true };
  return lastMessageId ? { lineId, anchorMessageId: lastMessageId, fromParent: false } : null;
}
