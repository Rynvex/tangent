import { Pencil } from "lucide-react";
import { useId, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { INPUT_SURFACE } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useFocusT } from "../i18n/focus-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";
import { isComposing } from "../shortcuts/keys";

export interface NodeTitleHandle {
  /** F2: start editing (nothing when the title cannot be changed). */
  edit: () => void;
}

export interface NodeTitleProps {
  title: string;
  /** Whether this node's title can be changed here (FOCUS_MODE.md §7.2). */
  editable: boolean;
  /** The field's name: the branch's purpose or the conversation's title. */
  label: string;
  maxLength: number;
  onSave: (title: string) => Promise<unknown>;
  /** One line under the box while editing (B13: what renaming an ended branch changes). */
  hint?: string;
  ref?: Ref<NodeTitleHandle>;
}

interface Editing {
  draft: string;
  error: string | null;
  /** The last save was refused: the button says 再儲存一次. */
  failed: boolean;
}

/**
 * The node panel's title (§7.2): double-click, the pencil or F2 edits it;
 * Enter saves, Esc gives up, an empty title is refused. While saving the
 * buttons wait; a refusal keeps what was typed in the box, the node keeps
 * its old title, and the reason is announced.
 */
export function NodeTitle({ title, editable, label, maxLength, onSave, hint, ref }: NodeTitleProps) {
  const t = useFocusT();
  const { hostErrorText } = useTangent();
  const errorId = useId();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const refocus = useRef(false);
  const start = () => editable && setEditing({ draft: title, error: null, failed: false });
  useImperativeHandle(ref, () => ({ edit: start }));
  useLayoutEffect(() => {
    if (editing) return;
    if (refocus.current) heading.current?.focus();
    refocus.current = false;
  }, [editing]);
  // A node that can no longer be renamed (it ended while editing, or became read-only) drops the box.
  if (editing && !editable) setEditing(null);

  const stop = () => {
    refocus.current = true;
    setEditing(null);
  };
  const save = () => {
    if (!editing || saving) return;
    const text = editing.draft.trim();
    if (text === "") {
      setEditing({ ...editing, error: t("panel.titleRequired") });
      return;
    }
    if (text === title) {
      stop();
      return;
    }
    setSaving(true);
    onSave(text).then(
      () => {
        setSaving(false);
        stop();
      },
      (error: unknown) => {
        setSaving(false);
        setEditing({ draft: editing.draft, error: t("panel.saveFailed", { reason: describeError(error, t, hostErrorText) }), failed: true });
        input.current?.focus();
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      // Handled here: the panel (and nav.back) must not take this Esc too.
      event.preventDefault();
      stop();
    }
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <input
          ref={input}
          // The box replaces the title the viewer just chose to edit.
          autoFocus
          aria-label={label}
          aria-invalid={editing.error ? true : undefined}
          aria-describedby={editing.error ? errorId : undefined}
          value={editing.draft}
          maxLength={maxLength}
          disabled={saving}
          onChange={(event) => setEditing({ ...editing, draft: event.target.value, error: editing.failed ? editing.error : null })}
          onKeyDown={onKeyDown}
          className={cx(INPUT_SURFACE, "h-(--tg-control-height) px-2.5 text-tg-sm font-semibold")}
        />
        {hint && <p className="m-0 text-tg-xs text-tg-muted">{hint}</p>}
        {editing.error && (
          <p id={errorId} role="alert" className="m-0 text-tg-xs text-tg-destructive">
            {editing.error}
          </p>
        )}
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" disabled={saving} onClick={stop}>
            {t("panel.cancel")}
          </Button>
          <Button size="sm" variant="primary" loading={saving} onClick={save}>
            {editing.failed ? t("panel.saveAgain") : t("panel.save")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="group/title flex min-w-0 items-start gap-1">
      <h2
        ref={heading}
        tabIndex={-1}
        onDoubleClick={start}
        className={cx("m-0 min-w-0 flex-1 rounded-tg-sm text-tg-md font-semibold break-words text-tg-foreground outline-none", editable && "cursor-text")}
      >
        {title}
      </h2>
      {editable && (
        <IconButton
          label={t("panel.rename")}
          size="sm"
          icon={<Pencil aria-hidden />}
          className="-my-0.5 text-tg-muted opacity-0 transition-opacity duration-(--tg-duration-fast) group-hover/title:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          onClick={start}
        />
      )}
    </div>
  );
}
