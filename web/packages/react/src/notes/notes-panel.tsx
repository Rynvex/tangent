import { activeCount, chatNumbers, isNewNote, noteSectionGroups, notesLeftOut, replacementOf, type Note, type NoteSectionGroup } from "@tangent/client";
import { Eye, Plus } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/button";
import { Skeleton } from "../components/display";
import { SECTION_KEYS } from "../branch/note-sections";
import { formatTokens } from "../components/usage-meter";
import { useNotes } from "../data/branch-queries";
import { useSupersedeNote, useUpdateNote } from "../data/note-mutations";
import { useNotesBlock, useNotesSeen, type NotesSeenStore } from "../data/note-reads";
import { useBranches, useMessages } from "../data/queries";
import { useReadOnly } from "../data/live-hooks";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { NoteAddForm } from "./note-add-form";
import { NoteItem, SupersededNoteItem } from "./note-item";
import { noteSourceLink, type NoteSourceContext } from "./note-source";

export interface NotesPanelProps {
  rootLineId: string;
  /** The line on screen: its next turn's notes block gives the token count and what is left out. */
  lineId: string;
  /** A note's source was chosen: show that line, at that message when given. */
  onGoToSource?: (lineId: string, messageId?: string) => void;
  /** Where the last visit is kept (default: localStorage). */
  seenStore?: NotesSeenStore;
  className?: string;
}

interface SectionProps {
  group: NoteSectionGroup;
  all: readonly Note[];
  seenAt: string | null;
  leftOut: ReadonlySet<string>;
  sourceContext: NoteSourceContext;
  readOnly: boolean;
  maxRunes: number;
  rootLineId: string;
  onGoToSource?: ((lineId: string, messageId?: string) => void) | undefined;
}

function NotesSection({ group, all, seenAt, leftOut, sourceContext, readOnly, maxRunes, rootLineId, onGoToSource }: SectionProps) {
  const t = useUiT();
  const headingId = useId();
  const [showReplaced, setShowReplaced] = useState(false);
  const update = useUpdateNote(rootLineId);
  const supersede = useSupersedeNote(rootLineId);
  const replaced = group.superseded.length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h3 id={headingId} className="m-0 mb-0.5 flex items-center gap-1.5 text-tg-xs font-semibold text-tg-muted">
        {t(SECTION_KEYS[group.section])}
        <span className="font-normal text-tg-subtle">{group.activeCount}</span>
      </h3>
      {group.items.length === 0 ? (
        <p className="m-0 px-2.5 text-tg-xs text-tg-subtle">{t("notes.sectionEmpty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {group.items.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              isNew={isNewNote(note, seenAt)}
              leftOut={leftOut.has(note.id)}
              source={noteSourceLink(note, sourceContext)}
              readOnly={readOnly}
              maxRunes={maxRunes}
              {...(onGoToSource ? { onSource: onGoToSource } : {})}
              onSave={(text) => update.mutateAsync({ noteId: note.id, input: { text } })}
              onToggleDone={(done) => update.mutateAsync({ noteId: note.id, input: { status: done ? "done" : "active" } })}
              onSupersede={(text, section) => supersede.mutateAsync({ noteId: note.id, input: { text, section } })}
            />
          ))}
        </ul>
      )}
      {replaced > 0 && (
        <>
          <Button size="sm" variant="ghost" aria-expanded={showReplaced} className="self-start text-tg-subtle" onClick={() => setShowReplaced(!showReplaced)}>
            {t(showReplaced ? "notes.hideSuperseded" : "notes.showSuperseded", { count: replaced })}
          </Button>
          {showReplaced && (
            <ul className="m-0 flex list-none flex-col p-0">
              {group.superseded.map((note) => (
                <SupersededNoteItem
                  key={note.id}
                  note={note}
                  replacement={replacementOf(note, all)}
                  source={noteSourceLink(note, sourceContext)}
                  {...(onGoToSource ? { onSource: onGoToSource } : {})}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Focus goes back to the 新增 button when the add form closes. */
function useAddButtonFocus(adding: boolean) {
  const button = useRef<HTMLButtonElement>(null);
  const was = useRef(adding);
  useLayoutEffect(() => {
    if (was.current && !adding) button.current?.focus();
    was.current = adding;
  }, [adding]);
  return button;
}

/**
 * The side panel's 紀要 (A9): one page of key points for the whole tree in
 * four sections, that goes to the AI every turn. The strip on top says so,
 * with the notes block's tokens; over the block's budget it names the notes
 * left out this turn. Notes are added, edited in place, replaced (the old one
 * struck through and collapsed) and to-dos ticked; read-only identities only
 * read. The server's active limit stops adding.
 */
export function NotesPanel({ rootLineId, lineId, onGoToSource, seenStore, className }: NotesPanelProps) {
  const t = useUiT();
  const readOnly = useReadOnly();
  const notes = useNotes(rootLineId);
  const block = useNotesBlock(lineId);
  const branches = useBranches(rootLineId, true);
  const main = useMessages(rootLineId);
  const seenAt = useNotesSeen(rootLineId, seenStore ? { store: seenStore } : {});
  const [adding, setAdding] = useState(false);
  const addButton = useAddButtonFocus(adding);
  const list = notes.data?.notes;
  const groups = useMemo(() => noteSectionGroups(list ?? []), [list]);
  const leftOut = useMemo(() => notesLeftOut(list ?? [], block.data?.content), [list, block.data]);
  const mainNumbers = useMemo(() => chatNumbers(main.data?.messages ?? []), [main.data]);
  const sourceContext: NoteSourceContext = { rootLineId, branches: branches.data?.branches ?? [], mainNumbers, t };

  if (notes.isPending) {
    return (
      <div role="status" aria-label={t("ui.loading")} className="flex flex-col gap-3 p-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-[80%]" />
      </div>
    );
  }
  if (!notes.data) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-3 text-tg-sm text-tg-muted">
        {t("notes.loadFailed")}
        <Button size="sm" onClick={() => void notes.refetch()}>
          {t("notes.retry")}
        </Button>
      </div>
    );
  }
  const { limits } = notes.data;
  const active = activeCount(notes.data.notes);
  const full = active >= limits.maxActive;
  // The notes block's tokens from the next turn's preview, against the budget when the server sends it (B5).
  const tokens = block.data ? formatTokens(block.data.tokens) : null;
  const everyTurn =
    tokens === null
      ? t("notes.everyTurn")
      : limits.tokenBudget
        ? t("notes.everyTurnBudget", { tokens, budget: formatTokens(limits.tokenBudget) })
        : t("notes.everyTurnTokens", { tokens });
  return (
    <div className={cx("flex flex-col gap-3 px-3 pt-2.5 pb-4", className)}>
      <div className="flex items-center gap-1.5 rounded-tg-sm bg-tg-surface-sunken px-2.5 py-2 text-tg-xs text-tg-muted">
        <Eye aria-hidden className="size-3.25 shrink-0" />
        <span className="flex-1">{everyTurn}</span>
        {!readOnly && (
          <Button
            ref={addButton}
            size="sm"
            variant="ghost"
            icon={<Plus aria-hidden className="size-3" />}
            aria-disabled={full || undefined}
            className="bg-tg-surface text-tg-foreground"
            onClick={() => !full && setAdding(true)}
          >
            {t("notes.add")}
          </Button>
        )}
      </div>
      {leftOut.size > 0 && <p className="m-0 rounded-tg-sm bg-tg-warning-soft px-2.5 py-2 text-tg-xs text-tg-foreground">{t("notes.leftOut", { count: leftOut.size })}</p>}
      {adding && !readOnly && <NoteAddForm lineId={rootLineId} maxRunes={limits.maxRunes} onDone={() => setAdding(false)} />}
      {groups.map((group) => (
        <NotesSection
          key={group.section}
          group={group}
          all={notes.data.notes}
          seenAt={seenAt}
          leftOut={leftOut}
          sourceContext={sourceContext}
          readOnly={readOnly}
          maxRunes={limits.maxRunes}
          rootLineId={rootLineId}
          onGoToSource={onGoToSource}
        />
      ))}
      <p className="m-0 text-tg-xs text-tg-subtle">{full ? t("notes.full", { max: limits.maxActive }) : t("notes.count", { active, max: limits.maxActive })}</p>
    </div>
  );
}
