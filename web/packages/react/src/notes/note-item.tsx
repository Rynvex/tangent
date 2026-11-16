import { NOTE_SECTIONS, replacementSection, type Note, type NoteSection } from "@tangent/client";
import { Check, Ellipsis, Replace } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SECTION_KEYS } from "../branch/note-sections";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/menu";
import { SegmentedControl } from "../components/segmented-control";
import { describeError } from "../conversation/error-text";
import { cx } from "../lib/cx";
import { useTangent, useUiT } from "../provider";
import { NoteEditor } from "./note-editor";
import type { NoteSourceLink } from "./note-source";

export interface NoteItemProps {
  note: Note;
  /** Written since the viewer's last visit (「新」). */
  isNew?: boolean;
  /** The prompt's notes block leaves it out this turn (over the budget). */
  leftOut?: boolean;
  source?: NoteSourceLink | null;
  onSource?: (lineId: string, messageId?: string) => void;
  readOnly?: boolean;
  maxRunes?: number;
  /** Edits the text in place; a rejection reopens the box with the reason. */
  onSave?: (text: string) => Promise<unknown> | void;
  /** To-dos only; a rejection shows the reason under the note. */
  onToggleDone?: (done: boolean) => Promise<unknown> | void;
  /** Replaces the note with a new one in `section`; a rejection reopens the form with the reason. */
  onSupersede?: (text: string, section: NoteSection) => Promise<unknown> | void;
  /** More actions in a ⋯ menu named `label` (focus mode: bring into this turn, continue from here, go to the source). */
  actions?: { label: string; items: readonly NoteItemAction[] };
}

export interface NoteItemAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
}

/** `section` is where a replacement goes (the edit box ignores it). */
type Editing = { mode: "edit" | "supersede"; draft: string; section: NoteSection; error: string | null } | null;

const ROW = "group flex items-start gap-2 rounded-tg-sm border border-tg-border bg-tg-surface-raised px-2.5 py-2";
const LINK =
  "self-start rounded-tg-sm text-left text-tg-xs text-tg-subtle hover:text-tg-primary-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11";

/** The to-do box: a native-feeling checkbox; read-only identities see it but cannot change it. */
function DoneBox({ note, readOnly, onToggle }: { note: Note; readOnly: boolean; onToggle?: ((done: boolean) => void) | undefined }) {
  const t = useUiT();
  const done = note.status === "done";
  const inert = readOnly || !onToggle;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-disabled={inert ? true : undefined}
      aria-label={t("notes.markDone", { text: note.text })}
      onClick={() => !inert && onToggle?.(!done)}
      className={cx(
        "relative mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[0.25rem] border border-tg-border-input",
        "before:absolute before:top-1/2 before:left-1/2 before:size-(--tg-hit-target) before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring",
        done && "border-tg-primary bg-tg-primary text-tg-primary-foreground",
        inert && "cursor-default",
      )}
    >
      {done && <Check aria-hidden className="size-3" strokeWidth={3} />}
    </button>
  );
}

function SourceLine({ source, onSource }: { source: NoteSourceLink; onSource?: ((lineId: string, messageId?: string) => void) | undefined }) {
  const t = useUiT();
  const target = source.lineId;
  if (target === null || !onSource) return <span className="text-tg-xs text-tg-subtle">{source.label}</span>;
  return (
    <button type="button" aria-label={t("notes.sourceGo", { label: source.label })} onClick={() => onSource(target, source.messageId)} className={LINK}>
      {source.label}
    </button>
  );
}

/**
 * One note (components.md NoteItem: p 8/10, gap 4). States: active, done
 * (struck through, to-dos tick a box), new (「新」), editing (click the text;
 * Enter saves, Esc cancels, leaving the box saves), and replacing (a form
 * that writes a new note, in this section or another, and keeps this one
 * struck through; a to-confirm note is replaced by a confirmed fact unless
 * another section is chosen).
 */
export function NoteItem({ note, isNew = false, leftOut = false, source, onSource, readOnly = false, maxRunes, onSave, onToggleDone, onSupersede, actions }: NoteItemProps) {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const [editing, setEditing] = useState<Editing>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const textButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const done = note.status === "done";
  // Cancelling unmounts the box that had focus; the note's text takes it back.
  useLayoutEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    // Only when focus went nowhere: leaving the box for another control must keep it there.
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) textButton.current?.focus();
  }, [editing]);

  const close = () => {
    refocus.current = true;
    setEditing(null);
  };
  const failed = (error: unknown) => t("notes.failed", { reason: describeError(error, t, hostErrorText) });
  const open = (mode: "edit" | "supersede") => setEditing({ mode, draft: note.text, section: mode === "supersede" ? replacementSection(note.section) : note.section, error: null });
  const run = (mode: "edit" | "supersede", section: NoteSection, action: ((text: string) => Promise<unknown> | void) | undefined) => (text: string) => {
    if (!action) return;
    refocus.current = mode === "edit";
    setEditing(null);
    // Shown at once (the edit is optimistic); a refusal brings the box back with the text, the section and the reason.
    Promise.resolve(action(text)).catch((error: unknown) => setEditing({ mode, draft: text, section, error: failed(error) }));
  };
  // The tick is optimistic and rolled back by the write; the reason stays under the note until the next tick.
  const toggle = onToggleDone
    ? (next: boolean) => {
        setToggleError(null);
        Promise.resolve(onToggleDone(next)).catch((error: unknown) => setToggleError(failed(error)));
      }
    : undefined;

  const text = done ? <s className="text-tg-subtle">{note.text}</s> : note.text;
  return (
    <li data-status={note.status} className={ROW}>
      {note.section === "todo" && <DoneBox note={note} readOnly={readOnly} onToggle={toggle} />}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {editing?.mode === "edit" ? (
          <NoteEditor key="edit" label={t("notes.editLabel")} initial={editing.draft} maxRunes={maxRunes} error={editing.error} submitOnBlur onSubmit={run("edit", editing.section, onSave)} onCancel={close} />
        ) : readOnly || !onSave ? (
          <span className="text-tg-sm break-words text-tg-foreground">{text}</span>
        ) : (
          <button
            ref={textButton}
            type="button"
            title={t("notes.editHint")}
            onClick={() => open("edit")}
            className="cursor-text self-start rounded-tg-sm text-left text-tg-sm break-words text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
          >
            {text}
          </button>
        )}
        {editing?.mode === "supersede" && (
          <div className="flex flex-col gap-1.5">
            <SegmentedControl
              label={t("notes.section")}
              options={NOTE_SECTIONS.map((value) => ({ value, label: t(SECTION_KEYS[value]) }))}
              value={editing.section}
              onValueChange={(section) => setEditing({ ...editing, section })}
            />
            <NoteEditor
              key="supersede"
              label={t("notes.supersedeLabel")}
              initial={editing.draft}
              maxRunes={maxRunes}
              error={editing.error}
              onSubmit={run("supersede", editing.section, onSupersede && ((text) => onSupersede(text, editing.section)))}
              onCancel={close}
              actions={(submit) => (
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" onClick={close}>
                    {t("notes.cancel")}
                  </Button>
                  <Button size="sm" variant="primary" onClick={submit}>
                    {t("notes.save")}
                  </Button>
                </div>
              )}
            />
          </div>
        )}
        {toggleError && (
          <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
            {toggleError}
          </p>
        )}
        {(isNew || leftOut || source) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {isNew && <span className="text-tg-xs font-medium text-tg-primary-text">{t("notes.new")}</span>}
            {leftOut && <span className="rounded-tg-sm border border-dashed border-tg-border-strong px-1.5 text-tg-xs text-tg-muted">{t("notes.leftOutTag")}</span>}
            {source && <SourceLine source={source} onSource={onSource} />}
          </div>
        )}
      </div>
      {!readOnly && onSupersede && !editing && !done && (
        <IconButton
          label={t("notes.supersede")}
          size="sm"
          icon={<Replace aria-hidden />}
          className="-my-1 text-tg-muted opacity-0 transition-opacity duration-(--tg-duration-fast) group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
          onClick={() => open("supersede")}
        />
      )}
      {actions && actions.items.length > 0 && !editing && (
        <Menu>
          <MenuTrigger render={<IconButton label={actions.label} size="sm" icon={<Ellipsis aria-hidden />} tooltip={false} className="-my-1 text-tg-muted" />} />
          <MenuContent align="end">
            {actions.items.map((action) => (
              <MenuItem key={action.id} icon={action.icon} onSelect={action.onSelect}>
                {action.label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </li>
  );
}

/** A replaced note: struck through, naming the note that replaced it; shown when the section's replaced notes are expanded. */
export function SupersededNoteItem({ note, replacement, source, onSource }: { note: Note; replacement?: Note | undefined; source?: NoteSourceLink | null; onSource?: (lineId: string, messageId?: string) => void }) {
  const t = useUiT();
  return (
    <li data-status="superseded" className="flex flex-col gap-0.5 px-2.5 py-1.5 text-tg-xs text-tg-subtle">
      <s className="break-words">{note.text}</s>
      {replacement && <span>{t("notes.replacedBy", { text: replacement.text })}</span>}
      {source && <SourceLine source={source} onSource={onSource} />}
    </li>
  );
}
