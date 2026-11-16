import { activeCount, chatNumbers, type Note } from "@tangent/client";
import { ArrowRight, CornerDownLeft, Eye, GitBranchPlus, Plus, Quote } from "lucide-react";
import { useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { Button } from "../components/button";
import { Skeleton } from "../components/display";
import { formatTokens } from "../components/usage-meter";
import { useNotes } from "../data/branch-queries";
import { useSupersedeNote, useUpdateNote } from "../data/note-mutations";
import { useNotesBlock } from "../data/note-reads";
import { useBranches, useMessages } from "../data/queries";
import { useFocusT } from "../i18n/focus-messages";
import { NoteAddForm } from "../notes/note-add-form";
import { NoteItem, type NoteItemAction } from "../notes/note-item";
import { noteSourceLink, type NoteSourceContext } from "../notes/note-source";
import { notesOfNode } from "./node-panel-model";

export interface NodeNotesHandle {
  /** N on the map: open the add form (nothing for a viewer or when the notes are full). */
  add: () => void;
}

export interface NodeNotesProps {
  rootLineId: string;
  /** The node's line: its notes are those written from it. */
  lineId: string;
  /** The line on screen: its next turn's notes block gives the token count. */
  currentLineId: string;
  /** The node's title, for 帶進這一輪's wording. */
  nodeTitle: string;
  readOnly: boolean;
  onGoToSource: (lineId: string, messageId?: string) => void;
  /** 帶進這一輪: the host puts the text first in the current line's composer. */
  onBringIn?: (text: string) => void;
  /** 從這裡繼續談: the host opens the open-branch dialog for this note. */
  onContinue?: (note: Note) => void;
  /** 看全部紀要: the host opens the whole notes page. */
  onShowAllNotes?: () => void;
  ref?: Ref<NodeNotesHandle>;
}

/**
 * The node panel's 紀要 (FOCUS_MODE.md §8, phase 1): the notes written from
 * this node, with the reminder that AI reads the whole page every turn and
 * that a node only marks where a note came from. Notes are edited, ticked
 * and replaced as on the notes page; a new one starts in 待確認 with this
 * node as its source.
 */
export function NodeNotes({ rootLineId, lineId, currentLineId, nodeTitle, readOnly, onGoToSource, onBringIn, onContinue, onShowAllNotes, ref }: NodeNotesProps) {
  const t = useFocusT();
  const headingId = useId();
  const notes = useNotes(rootLineId);
  const block = useNotesBlock(currentLineId);
  const branches = useBranches(rootLineId, true);
  const main = useMessages(rootLineId);
  const update = useUpdateNote(rootLineId);
  const supersede = useSupersedeNote(rootLineId);
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const was = useRef(adding);
  useLayoutEffect(() => {
    if (was.current && !adding) addButton.current?.focus();
    was.current = adding;
  }, [adding]);
  const list = notes.data?.notes;
  const mine = useMemo(() => notesOfNode(list ?? [], lineId), [list, lineId]);
  const mainNumbers = useMemo(() => chatNumbers(main.data?.messages ?? []), [main.data]);
  const full = notes.data ? activeCount(notes.data.notes) >= notes.data.limits.maxActive : false;
  useImperativeHandle(ref, () => ({ add: () => !readOnly && !full && notes.data && setAdding(true) }));

  if (notes.isPending) return <Skeleton className="h-20 w-full" />;
  if (!notes.data) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-tg-sm text-tg-muted">
        {t("notes.loadFailed")}
        <Button size="sm" onClick={() => void notes.refetch()}>
          {t("notes.retry")}
        </Button>
      </div>
    );
  }
  const { limits } = notes.data;
  const sourceContext: NoteSourceContext = { rootLineId, branches: branches.data?.branches ?? [], mainNumbers, t };
  const tokens = block.data ? formatTokens(block.data.tokens) : null;
  const everyTurn =
    tokens === null
      ? t("notes.everyTurn")
      : limits.tokenBudget
        ? t("notes.everyTurnBudget", { tokens, budget: formatTokens(limits.tokenBudget) })
        : t("notes.everyTurnTokens", { tokens });
  const actionsOf = (note: Note): NoteItemAction[] => [
    ...(onBringIn && !readOnly
      ? [{ id: "bringIn", label: t("note.bringIn"), icon: <CornerDownLeft aria-hidden />, onSelect: () => onBringIn(t("note.bringInText", { title: nodeTitle, text: note.text })) }]
      : []),
    ...(onContinue && !readOnly ? [{ id: "continue", label: t("note.continue"), icon: <GitBranchPlus aria-hidden />, onSelect: () => onContinue(note) }] : []),
    ...(note.sourceMessageId && note.sourceLineId ? [{ id: "source", label: t("note.toSource"), icon: <Quote aria-hidden />, onSelect: () => onGoToSource(note.sourceLineId, note.sourceMessageId) }] : []),
  ];
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-tg-xs font-semibold text-tg-muted">
        {t("notes.nodeTitle")}
        <span className="font-normal text-tg-subtle">{mine.length}</span>
      </h3>
      <div className="flex flex-col gap-0.5 rounded-tg-sm bg-tg-surface-sunken px-2.5 py-2 text-tg-xs text-tg-muted">
        <span className="flex items-center gap-1.5">
          <Eye aria-hidden className="size-3.25 shrink-0" />
          {everyTurn}
        </span>
        <span className="pl-4.75 text-tg-subtle">{t("notes.scopeHint")}</span>
      </div>
      {mine.length === 0 ? (
        <p className="m-0 text-tg-xs text-tg-subtle">{t("notes.nodeEmpty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {mine.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              source={noteSourceLink(note, sourceContext)}
              readOnly={readOnly}
              maxRunes={limits.maxRunes}
              onSource={onGoToSource}
              onSave={(text) => update.mutateAsync({ noteId: note.id, input: { text } })}
              onToggleDone={(done) => update.mutateAsync({ noteId: note.id, input: { status: done ? "done" : "active" } })}
              onSupersede={(text, section) => supersede.mutateAsync({ noteId: note.id, input: { text, section } })}
              actions={{ label: t("note.menu"), items: actionsOf(note) }}
            />
          ))}
        </ul>
      )}
      {!readOnly &&
        (adding ? (
          <NoteAddForm lineId={rootLineId} maxRunes={limits.maxRunes} sourceLineId={lineId} defaultSection="to_confirm" onDone={() => setAdding(false)} />
        ) : (
          <Button ref={addButton} size="sm" variant="ghost" icon={<Plus aria-hidden className="size-3" />} aria-disabled={full || undefined} className="self-start" onClick={() => !full && setAdding(true)}>
            {t("notes.addHere")}
          </Button>
        ))}
      {full && !readOnly && <p className="m-0 text-tg-xs text-tg-subtle">{t("notes.full", { max: limits.maxActive })}</p>}
      {onShowAllNotes && (
        <Button size="sm" variant="ghost" icon={<ArrowRight aria-hidden className="size-3" />} className="self-start text-tg-primary-text" onClick={onShowAllNotes}>
          {t("notes.showAll", { count: activeCount(notes.data.notes) })}
        </Button>
      )}
    </section>
  );
}
