import { NOTE_SECTIONS, type Memo, type NoteSection } from "@tangent/client";
import { CornerDownLeft, Ellipsis, EyeOff, GitBranchPlus, GraduationCap, NotebookPen, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { SECTION_KEYS } from "../branch/note-sections";
import { Button } from "../components/button";
import { Skeleton } from "../components/display";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/menu";
import { SegmentedControl } from "../components/segmented-control";
import { describeError } from "../conversation/error-text";
import { useCreateMemo, useDeleteMemo, useMemos, useUpdateMemo } from "../data/memo-hooks";
import { useCreateNote } from "../data/note-mutations";
import { useF8T } from "../i18n/f8-messages";
import { useFocusT } from "../i18n/focus-messages";
import { NoteEditor } from "../notes/note-editor";
import { useTangent } from "../provider";

/** How long a deleted memo can be brought back (interactions: 5 秒內可復原). */
export const MEMO_UNDO_MS = 5000;

export interface NodeMemosHandle {
  /** N on the map: open the new-memo box (nothing for a viewer or when full). */
  add: () => void;
}

export interface NodeMemosProps {
  rootLineId: string;
  /** The node's line: its memos are those written on it. */
  lineId: string;
  nodeTitle: string;
  readOnly: boolean;
  /** 轉成紀要 is offered while the notes feature is on. */
  notesOn: boolean;
  onBringIn?: (text: string) => void;
  onContinue?: (text: string) => void;
  /** 請 AI 檢驗理解… (F8 S10, the Feynman check): the host opens an investigate branch with the check in its composer, unsent. */
  onCheckUnderstanding?: (memo: Memo) => void;
  ref?: Ref<NodeMemosHandle>;
}

const ROW = "group flex items-start gap-2 rounded-tg-sm border border-tg-border bg-tg-surface-raised px-2.5 py-2";

/** 轉成紀要: pick the section, then the note is written with the node as its source; the memo stays. */
function ToNoteForm({ rootLineId, lineId, text, onDone }: { rootLineId: string; lineId: string; text: string; onDone: (converted: boolean) => void }) {
  const t = useFocusT();
  const { hostErrorText } = useTangent();
  const create = useCreateNote(rootLineId);
  const [section, setSection] = useState<NoteSection>("to_confirm");
  return (
    <div className="flex flex-col gap-1.5 rounded-tg-sm border border-tg-ring p-2">
      <SegmentedControl label={t("notes.section")} options={NOTE_SECTIONS.map((value) => ({ value, label: t(SECTION_KEYS[value]) }))} value={section} onValueChange={setSection} />
      {create.error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {t("notes.failed", { reason: describeError(create.error, t, hostErrorText) })}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => onDone(false)}>
          {t("memo.cancel")}
        </Button>
        <Button size="sm" variant="primary" loading={create.isPending} onClick={() => create.mutate({ section, text, sourceLineId: lineId }, { onSuccess: () => onDone(true) })}>
          {t("memo.toNoteSubmit")}
        </Button>
      </div>
    </div>
  );
}

interface MemoItemProps {
  memo: Memo;
  rootLineId: string;
  nodeTitle: string;
  readOnly: boolean;
  notesOn: boolean;
  converted: boolean;
  onConverted: () => void;
  onDelete: (memo: Memo) => void;
  onBringIn?: ((text: string) => void) | undefined;
  onContinue?: ((text: string) => void) | undefined;
  onCheckUnderstanding?: ((memo: Memo) => void) | undefined;
}

/** One memo: click the text to edit (Enter saves, ⇧Enter breaks the line, Esc gives up); a refusal keeps what was typed. */
function MemoItem({ memo, rootLineId, nodeTitle, readOnly, notesOn, converted, onConverted, onDelete, onBringIn, onContinue, onCheckUnderstanding }: MemoItemProps) {
  const t = useFocusT();
  const f8 = useF8T();
  const { hostErrorText } = useTangent();
  const update = useUpdateMemo(rootLineId);
  const [editing, setEditing] = useState<{ draft: string; error: string | null } | null>(null);
  const [toNote, setToNote] = useState(false);
  const textButton = useRef<HTMLButtonElement>(null);
  const save = (text: string) => {
    setEditing(null);
    if (text === memo.text) return;
    update.mutateAsync({ memoId: memo.id, text }).catch((error: unknown) => setEditing({ draft: text, error: t("memo.failed", { reason: describeError(error, t, hostErrorText) }) }));
  };
  const actions = [
    ...(onBringIn ? [{ id: "bringIn", label: t("note.bringIn"), icon: <CornerDownLeft aria-hidden />, run: () => onBringIn(t("note.bringInText", { title: nodeTitle, text: memo.text })) }] : []),
    ...(onContinue ? [{ id: "continue", label: t("note.continue"), icon: <GitBranchPlus aria-hidden />, run: () => onContinue(memo.text) }] : []),
    ...(onCheckUnderstanding ? [{ id: "feynman", label: f8("memo.feynman"), icon: <GraduationCap aria-hidden />, run: () => onCheckUnderstanding(memo) }] : []),
    ...(notesOn && !converted ? [{ id: "toNote", label: t("memo.toNote"), icon: <NotebookPen aria-hidden />, run: () => setToNote(true) }] : []),
    { id: "delete", label: t("memo.delete"), icon: <Trash2 aria-hidden />, run: () => onDelete(memo) },
  ];
  return (
    <li className={ROW}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {editing ? (
          <NoteEditor label={t("memo.label")} initial={editing.draft} error={editing.error} submitOnBlur onSubmit={save} onCancel={() => setEditing(null)} />
        ) : readOnly ? (
          <span className="text-tg-sm break-words whitespace-pre-wrap text-tg-foreground">{memo.text}</span>
        ) : (
          <button
            ref={textButton}
            type="button"
            title={t("memo.editHint")}
            onClick={() => setEditing({ draft: memo.text, error: null })}
            className="cursor-text self-start rounded-tg-sm text-left text-tg-sm break-words whitespace-pre-wrap text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
          >
            {memo.text}
          </button>
        )}
        {converted && <span className="text-tg-xs font-medium text-tg-primary-text">{t("memo.converted")}</span>}
        {toNote && (
          <ToNoteForm
            rootLineId={rootLineId}
            lineId={memo.lineId}
            text={memo.text}
            onDone={(done) => {
              setToNote(false);
              if (done) onConverted();
            }}
          />
        )}
      </div>
      {!readOnly && !editing && (
        <Menu>
          <MenuTrigger render={<IconButton label={t("memo.menu")} size="sm" icon={<Ellipsis aria-hidden />} tooltip={false} className="-my-1 text-tg-muted" />} />
          <MenuContent align="end">
            {actions.map((action) => (
              <MenuItem key={action.id} icon={action.icon} destructive={action.id === "delete"} onSelect={action.run}>
                {action.label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </li>
  );
}

/** A deleted memo, kept for MEMO_UNDO_MS so 復原 can write it again. */
function useUndoableDelete(rootLineId: string, onError: (message: string | null) => void) {
  const t = useFocusT();
  const { hostErrorText } = useTangent();
  const remove = useDeleteMemo(rootLineId);
  const create = useCreateMemo(rootLineId);
  const [deleted, setDeleted] = useState<Memo | null>(null);
  useEffect(() => {
    if (!deleted) return;
    const timer = setTimeout(() => setDeleted(null), MEMO_UNDO_MS);
    return () => clearTimeout(timer);
  }, [deleted]);
  const failed = (error: unknown) => onError(t("memo.failed", { reason: describeError(error, t, hostErrorText) }));
  return {
    deleted,
    remove: (memo: Memo) => {
      onError(null);
      return remove.mutateAsync(memo.id).then(() => setDeleted(memo), failed);
    },
    undo: () => {
      if (!deleted) return;
      const memo = deleted;
      onError(null);
      setDeleted(null);
      // A refused undo (the cap, a network error) keeps 復原 on offer instead of losing the memo.
      create.mutateAsync({ lineId: memo.lineId, text: memo.text }).catch((error: unknown) => {
        setDeleted(memo);
        failed(error);
      });
    },
  };
}

/**
 * The node panel's 備忘 (FOCUS_MODE.md §8, B13): notes on this node that
 * never go to the AI, oldest first. Edited in place, deleted with five
 * seconds to undo, turned into a note (the memo stays, marked), or brought
 * into the turn or a new branch like a note.
 */
export function NodeMemos({ rootLineId, lineId, nodeTitle, readOnly, notesOn, onBringIn, onContinue, onCheckUnderstanding, ref }: NodeMemosProps) {
  const t = useFocusT();
  const { hostErrorText } = useTangent();
  const headingId = useId();
  const memos = useMemos(rootLineId);
  const create = useCreateMemo(rootLineId);
  const [adding, setAdding] = useState(false);
  const [converted, setConverted] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const undoable = useUndoableDelete(rootLineId, setError);
  const addButton = useRef<HTMLButtonElement>(null);
  const was = useRef(adding);
  useLayoutEffect(() => {
    if (was.current && !adding) addButton.current?.focus();
    was.current = adding;
  }, [adding]);
  const all = memos.data?.memos;
  const mine = useMemo(() => (all ?? []).filter((memo) => memo.lineId === lineId), [all, lineId]);
  const full = memos.data ? memos.data.memos.length >= memos.data.limits.maxTotal : false;
  useImperativeHandle(ref, () => ({ add: () => !readOnly && !full && memos.data && setAdding(true) }));

  if (memos.isPending) return <Skeleton className="h-16 w-full" />;
  if (!memos.data) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-tg-sm text-tg-muted">
        {t("notes.loadFailed")}
        <Button size="sm" onClick={() => void memos.refetch()}>
          {t("notes.retry")}
        </Button>
      </div>
    );
  }
  const add = (text: string) => {
    if (create.isPending) return;
    setError(null);
    create.mutate({ lineId, text }, { onSuccess: () => setAdding(false) });
  };
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-tg-xs font-semibold text-tg-muted">
        {t("memo.title")}
        <span className="font-normal text-tg-subtle">{mine.length}</span>
      </h3>
      <p className="m-0 flex items-center gap-1.5 rounded-tg-sm bg-tg-surface-sunken px-2.5 py-2 text-tg-xs text-tg-muted">
        <EyeOff aria-hidden className="size-3.25 shrink-0" />
        {t("memo.head")}
      </p>
      {mine.length === 0 ? (
        <p className="m-0 text-tg-xs text-tg-subtle">{t("memo.empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {mine.map((memo) => (
            <MemoItem
              key={memo.id}
              memo={memo}
              rootLineId={rootLineId}
              nodeTitle={nodeTitle}
              readOnly={readOnly}
              notesOn={notesOn}
              converted={converted.has(memo.id)}
              onConverted={() => setConverted(new Set([...converted, memo.id]))}
              onDelete={(target) => void undoable.remove(target)}
              onBringIn={onBringIn}
              onContinue={onContinue}
              onCheckUnderstanding={onCheckUnderstanding}
            />
          ))}
        </ul>
      )}
      <div role="status" className="text-tg-xs text-tg-muted">
        {undoable.deleted && (
          <span className="flex items-center gap-2">
            {t("memo.deleted")}
            <Button size="sm" variant="ghost" onClick={undoable.undo}>
              {t("memo.undo")}
            </Button>
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
      {!readOnly &&
        (adding ? (
          <NoteEditor
            label={t("memo.label")}
            initial=""
            placeholder={t("memo.placeholder")}
            maxRunes={memos.data.limits.maxRunes}
            error={create.error ? t("memo.failed", { reason: describeError(create.error, t, hostErrorText) }) : null}
            onSubmit={add}
            onCancel={() => setAdding(false)}
            actions={(submit) => (
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  {t("memo.cancel")}
                </Button>
                <Button size="sm" variant="primary" loading={create.isPending} onClick={submit}>
                  {t("memo.save")}
                </Button>
              </div>
            )}
          />
        ) : (
          <Button ref={addButton} size="sm" variant="ghost" icon={<Plus aria-hidden className="size-3" />} aria-disabled={full || undefined} className="self-start" onClick={() => !full && setAdding(true)}>
            {t("memo.add")}
          </Button>
        ))}
      {full && !readOnly && <p className="m-0 text-tg-xs text-tg-subtle">{t("memo.full", { max: memos.data.limits.maxTotal })}</p>}
    </section>
  );
}
