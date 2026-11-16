import { branchTitle, noteSource, type BranchView, type Note } from "@tangent/client";
import { KIND_KEYS } from "../conversation/branch-suggestions";
import type { Translate } from "../i18n";

/** A note's source as the page shows it; `lineId` is null when there is nothing to go to any more. */
export interface NoteSourceLink {
  label: string;
  lineId: string | null;
  messageId?: string;
}

export interface NoteSourceContext {
  rootLineId: string;
  /** The tree's outline, asides included. */
  branches: readonly BranchView[];
  /** "#n" of the main line's chat messages. */
  mainNumbers: ReadonlyMap<string, number>;
  t: Translate;
}

/**
 * Where a note came from (A9): a main-line message ("主線 #n"), a branch
 * ("查證・purpose"), or a conclusion card (linked to the card on the
 * branch's parent). The label the server stored with the note (B8
 * `sourceLabel`) wins over the one worked out here; the link is the same.
 * A source that is gone (a cleared aside) shows the stored label, or says it
 * was cleared, without a link.
 */
export function noteSourceLink(note: Note, context: NoteSourceContext): NoteSourceLink | null {
  const link = computedSourceLink(note, context);
  return link && note.sourceLabel ? { ...link, label: note.sourceLabel } : link;
}

function computedSourceLink(note: Note, { rootLineId, branches, mainNumbers, t }: NoteSourceContext): NoteSourceLink | null {
  const source = noteSource(note);
  if (!source) return null;
  const at = (lineId: string, messageId?: string): Pick<NoteSourceLink, "lineId" | "messageId"> => ({ lineId, ...(messageId ? { messageId } : {}) });
  if (source.lineId === rootLineId && source.kind !== "card") {
    const n = source.kind === "message" ? mainNumbers.get(source.messageId) : undefined;
    return { label: n ? t("notes.sourceMain", { n }) : t("notes.sourceMainLine"), ...at(rootLineId, source.kind === "message" ? source.messageId : undefined) };
  }
  const branch = branches.find((item) => item.lineId === source.lineId);
  if (!branch) return { label: note.sourceLabel ?? t("notes.sourceGone"), lineId: null };
  const title = branchTitle(branch, t);
  if (source.kind === "card") return { label: t("notes.sourceCard", { title }), ...at(branch.parentLineId, source.messageId) };
  return { label: t("notes.sourceBranch", { kind: t(KIND_KEYS[branch.kind]), title }), ...at(branch.lineId, source.kind === "message" ? source.messageId : undefined) };
}
