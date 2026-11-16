import { NOTE_TEXT_MAX, validateNote } from "@tangent/client";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { INPUT_SURFACE } from "../components/text-field";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { isComposing } from "../shortcuts/keys";

export interface NoteEditorProps {
  label: string;
  initial: string;
  maxRunes?: number;
  /** Called with the trimmed, valid text. */
  onSubmit: (text: string) => void;
  onCancel: () => void;
  /** Leaving the box saves (an in-place edit) or does nothing (an explicit form with buttons). */
  submitOnBlur?: boolean;
  /** A refusal from the server, shown under the box and read with it. */
  error?: string | null;
  placeholder?: string;
  /** Buttons under the box (an explicit form). */
  actions?: (submit: () => void) => ReactNode;
}

/**
 * One note's text box: Enter submits (never while an input method composes),
 * Esc cancels without letting the side panel see it, empty or too long text
 * is refused with a message. Focus starts in the box with the caret at the end.
 */
export function NoteEditor({ label, initial, maxRunes = NOTE_TEXT_MAX, onSubmit, onCancel, submitOnBlur = false, error, placeholder, actions }: NoteEditorProps) {
  const t = useUiT();
  const [text, setText] = useState(initial);
  const [tried, setTried] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const messageId = useId();
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const problem = validateNote(text, maxRunes);
  const shown = problem === "tooLong" ? t("notes.errorTooLong", { max: maxRunes }) : tried && problem === "empty" ? t("notes.errorEmpty") : (error ?? null);

  const submit = () => {
    setTried(true);
    if (!problem) onSubmit(text.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  const onBlur = () => {
    if (!submitOnBlur) return;
    if (problem || text.trim() === initial.trim()) onCancel();
    else onSubmit(text.trim());
  };
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={box}
        aria-label={label}
        aria-invalid={shown && problem ? true : undefined}
        aria-describedby={shown ? messageId : undefined}
        value={text}
        rows={1}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className={cx(INPUT_SURFACE, "min-h-(--tg-control-height) resize-none px-2.5 py-1.5 leading-normal [field-sizing:content]")}
      />
      {shown && (
        <p id={messageId} className="m-0 text-tg-xs text-tg-destructive">
          {shown}
        </p>
      )}
      {actions?.(submit)}
    </div>
  );
}
