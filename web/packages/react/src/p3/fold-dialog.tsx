import { DEFAULT_FOLD_LIMITS, foldEndOptions, type Message } from "@tangent/client";
import { useId, useState } from "react";
import { Button } from "../components/button";
import { Dialog, DialogContent } from "../components/dialog";
import { INPUT_SURFACE, TextArea } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useCreateFold } from "../data/p3-hooks";
import { useP3T } from "../i18n/p3-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";

export interface FoldDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lineId: string;
  /** The message the fold starts at. */
  start: Message;
  /** The line's messages (the end is one of the later finished ones). */
  messages: readonly Message[];
  /** The "#n" of each chat message. */
  numbers: ReadonlyMap<string, number>;
  onDone?: () => void;
}

const EXCERPT = 40;
const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return Array.from(flat).length > EXCERPT ? `${Array.from(flat).slice(0, EXCERPT).join("")}…` : flat;
};

/**
 * 折疊成摘要 (D4): from a message to a later one the user picks; the summary
 * is the user's, or empty for AI to draft. The messages stay on screen. The
 * choice and the draft belong to one start in one line (R9).
 */
export default function FoldDialog(props: FoldDialogProps) {
  return <StartFoldDialog key={`${props.lineId}:${props.start.id}`} {...props} />;
}

function StartFoldDialog({ open, onOpenChange, lineId, start, messages, numbers, onDone }: FoldDialogProps) {
  const t = useP3T();
  const { hostErrorText } = useTangent();
  const create = useCreateFold(lineId);
  const endId = useId();
  const options = foldEndOptions(messages, start.id);
  const [end, setEnd] = useState<string>(options[0]?.id ?? "");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tooLong = Array.from(summary.trim()).length > DEFAULT_FOLD_LIMITS.summaryMaxRunes;
  const ready = end !== "" && options.some((option) => option.id === end) && !tooLong;
  const submit = () => {
    if (!ready || create.isPending) return;
    setError(null);
    const text = summary.trim();
    create.mutateAsync({ fromMessageId: start.id, toMessageId: end, ...(text ? { summary: text } : {}) }).then(
      () => {
        onDone?.();
        onOpenChange(false);
      },
      (failure: unknown) => setError(t("fold.createFailed", { reason: describeError(failure, t, hostErrorText) })),
    );
  };
  const who = (message: Message) => (message.role === "user" ? t("fold.you") : t("fold.ai"));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("fold.dialogTitle")}
        description={t("fold.dialogDescription", { from: numbers.get(start.id) ?? "" })}
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("fold.cancel")}
            </Button>
            <Button variant="primary" loading={create.isPending} aria-disabled={!ready || undefined} onClick={submit}>
              {t("fold.submit")}
            </Button>
          </>
        }
      >
        {options.length === 0 ? (
          <p className="m-0 text-tg-sm text-tg-muted">{t("fold.noEnd")}</p>
        ) : (
          <label htmlFor={endId} className="flex flex-col gap-1.5 text-tg-sm font-medium text-tg-foreground">
            {t("fold.end")}
            <select id={endId} value={end} onChange={(event) => setEnd(event.currentTarget.value)} className={cx(INPUT_SURFACE, "h-9 px-2 font-normal")}>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {t("fold.endOption", { n: numbers.get(option.id) ?? "", who: who(option), text: excerpt(option.content) })}
                </option>
              ))}
            </select>
          </label>
        )}
        <TextArea label={t("fold.summaryField")} value={summary} rows={3} onChange={(event) => setSummary(event.currentTarget.value)} error={tooLong ? t("fold.summaryTooLong", { limit: DEFAULT_FOLD_LIMITS.summaryMaxRunes }) : undefined} />
        {error && (
          <p role="alert" className="m-0 text-tg-sm text-tg-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export { FoldDialog };
