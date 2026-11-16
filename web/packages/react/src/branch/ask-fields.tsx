import { Pencil } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

export interface AskChip {
  /** A template's id, or the host's own (F12: a card's open question). */
  id: string;
  label: string;
}

const STEP: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * The question templates over the first question (F10 §2): one choice or
 * none (the user wrote their own), radio semantics, wrapping on narrow
 * screens; with nothing chosen the first chip takes the tab stop.
 */
export function AskChips({ chips, value, onValueChange }: { chips: readonly AskChip[]; value: string | null; onValueChange: (id: string) => void }) {
  const t = useUiT();
  const group = useRef<HTMLDivElement>(null);
  const at = chips.findIndex((chip) => chip.id === value);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = chips[(Math.max(at, 0) + step + chips.length) % chips.length];
    if (!next) return;
    onValueChange(next.id);
    group.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.id)}"]`)?.focus();
  };
  return (
    <div ref={group} role="radiogroup" aria-label={t("branch.askLabel")} onKeyDown={onKeyDown} className="flex flex-wrap gap-1.5">
      {chips.map((chip, index) => {
        const checked = chip.id === value;
        return (
          <button
            key={chip.id}
            type="button"
            role="radio"
            data-value={chip.id}
            aria-checked={checked}
            tabIndex={checked || (at < 0 && index === 0) ? 0 : -1}
            onClick={() => onValueChange(chip.id)}
            className={cx(
              "inline-flex h-7 items-center rounded-tg-full border px-3 text-tg-xs transition-colors duration-(--tg-duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11",
              checked ? "border-tg-primary bg-tg-primary-soft font-medium text-tg-foreground-strong" : "border-tg-border-strong text-tg-muted hover:border-tg-foreground hover:text-tg-foreground",
            )}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

/** The purpose as it will be written, small, with the way to change it (it follows the chosen template or the question until then). */
export function PurposeSummary({ purpose, onEdit }: { purpose: string; onEdit: () => void }) {
  const t = useUiT();
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-tg-xs text-tg-muted">
      <span className="shrink-0">{t("branch.purposeLabel")}</span>
      <span className="min-w-0 flex-1 truncate text-tg-foreground">{purpose}</span>
      <button
        type="button"
        onClick={onEdit}
        className="inline-flex shrink-0 items-center gap-1 rounded-tg-sm px-1 text-tg-primary-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
      >
        <Pencil aria-hidden className="size-3" />
        {t("branch.purposeEdit")}
      </button>
    </div>
  );
}
