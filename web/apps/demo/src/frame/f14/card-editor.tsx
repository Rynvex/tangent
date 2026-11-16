/**
 * F14 BlueprintCardEditor: the card a merged branch leaves on the main line,
 * prefilled with its ending (decision #6, no model). Pressing 改結論 (or the
 * text) edits it in place; an empty conclusion says 結論不能空白 and keeps
 * the import buttons off.
 */
import { Flag } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";

export interface CardEditorProps {
  title: string;
  question: string;
  conclusion: string;
  touch: boolean;
  onChange: (conclusion: string) => void;
}

export function CardEditor({ title, question, conclusion, touch, onChange }: CardEditorProps) {
  const t = useF14T();
  const [editing, setEditing] = useState(false);
  const errorId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // Leaving the editor (完成, Esc) puts focus back on 改結論 instead of losing it with the textarea.
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const empty = conclusion.trim() === "";
  return (
    <div data-tg-card-editor="" className={cx("flex flex-col gap-1 rounded-tg-sm border bg-tg-card px-2 py-1.5 text-tg-xs", editing ? "border-tg-ring outline-2 outline-tg-ring" : empty ? "border-tg-destructive" : "border-tg-card-border")}>
      <span className="flex items-center gap-1.5 text-tg-muted">
        <Flag aria-hidden className="size-3.5 shrink-0 text-tg-primary-text" />
        <span className="min-w-0 flex-1 truncate">{t("assembly.cardLabel")}</span>
        {editing ? (
          <span className="font-medium text-tg-primary-text">{t("assembly.editing")}</span>
        ) : (
          <button ref={editButton} type="button" onClick={() => setEditing(true)} className={cx("rounded-tg-sm px-1 font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11", touch && "min-h-8")}>
            {t("assembly.editCard")}
          </button>
        )}
      </span>
      {editing ? (
        <>
          <textarea
            autoFocus
            aria-label={t("assembly.cardField", { title })}
            aria-invalid={empty || undefined}
            aria-describedby={empty ? errorId : undefined}
            value={conclusion}
            rows={2}
            maxLength={2000}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(false);
              }
            }}
            className="w-full resize-y rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 py-1 text-tg-sm text-tg-foreground outline-none focus-visible:outline-2 focus-visible:outline-tg-ring"
          />
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-tg-muted">{t("assembly.cardHint")}</span>
            <button type="button" onClick={() => setEditing(false)} className="rounded-tg-sm px-1.5 font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11">
              {t("assembly.cardDone")}
            </button>
          </span>
        </>
      ) : (
        <button type="button" onClick={() => setEditing(true)} title={question} aria-label={conclusion.trim() ? undefined : t("assembly.cardField", { title })} className="text-left text-tg-sm text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring">
          {conclusion || " "}
        </button>
      )}
      {empty && (
        <span id={errorId} className="text-tg-destructive">
          {t("assembly.cardEmpty")}
        </span>
      )}
    </div>
  );
}
