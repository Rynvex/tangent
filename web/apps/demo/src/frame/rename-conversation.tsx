import type { LineView } from "@tangent/client";
import { Button, describeError, Dialog, DialogContent, useTangent, useUpdateLine } from "@tangent/react";
import { useId, useState, type KeyboardEvent } from "react";
import { useShellT } from "./f8-shell-messages";

/** `domain.TextLimits.TitleMaxRunes`: a conversation's title is at most this many characters. */
export const TITLE_MAX = 200;

const runes = (text: string) => Array.from(text).length;

export interface RenameFieldProps {
  line: LineView;
  /** Saved (the new line) or given up (null). */
  onDone: (saved: LineView | null) => void;
  /** Classes of the input (its place: a list row or a dialog). */
  className?: string;
  /** Inside a dialog the buttons save; a list row saves on Enter only. */
  formId?: string;
}

/**
 * The title field of 重新命名 (S5): Enter saves, Esc gives up, an empty title
 * is refused here, and a refused rename keeps what was typed with the reason.
 */
export function RenameField({ line, onDone, className, formId }: RenameFieldProps) {
  const t = useShellT();
  const { hostErrorText } = useTangent();
  const update = useUpdateLine();
  const errorId = useId();
  const hintId = useId();
  const [value, setValue] = useState(line.title);
  const [error, setError] = useState<string | null>(null);
  const title = line.title || t("shell.untitled");
  const save = () => {
    if (update.isPending) return;
    const next = value.trim();
    if (next === "") return setError(t("conv.renameEmpty"));
    // Over the limit: the hint under the field already says so; nothing is sent.
    if (runes(next) > TITLE_MAX) return;
    if (next === line.title) return onDone(null);
    setError(null);
    update.mutateAsync({ lineId: line.id, input: { title: next } }).then(onDone, (failure: unknown) => setError(t("conv.renameFailed", { reason: describeError(failure, t, hostErrorText) })));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      // The field's own Esc: the list (or dialog) around it stays.
      event.preventDefault();
      event.stopPropagation();
      onDone(null);
    }
  };
  return (
    <form
      id={formId}
      className="flex min-w-0 flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <input
        // A rename starts where the user is looking.
        autoFocus
        value={value}
        maxLength={TITLE_MAX * 2}
        aria-label={t("conv.renameField", { title })}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
        aria-busy={update.isPending || undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        className={
          className ??
          "h-8 w-full min-w-0 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 text-tg-sm text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring aria-invalid:border-tg-destructive pointer-coarse:h-11"
        }
      />
      <span id={hintId} className={runes(value) > TITLE_MAX ? "text-tg-xs text-tg-destructive" : "text-tg-xs text-tg-subtle"}>
        {t("conv.renameHint", { count: runes(value), max: TITLE_MAX })}
      </span>
      {error && (
        <span id={errorId} role="alert" className="text-tg-xs text-tg-destructive">
          {error}
        </span>
      )}
    </form>
  );
}

export interface RenameConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  line: LineView;
}

/** 重新命名… from the header's menu, where there is no list row to edit in place. */
export function RenameConversationDialog({ open, onOpenChange, line }: RenameConversationDialogProps) {
  const t = useShellT();
  const formId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("conv.renameTitle")}
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("conv.renameCancel")}
            </Button>
            <Button variant="primary" type="submit" form={formId}>
              {t("conv.renameSave")}
            </Button>
          </>
        }
      >
        {/* Keyed by the line: a reopened dialog starts from the current title. */}
        {open && <RenameField key={line.id} line={line} formId={formId} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
