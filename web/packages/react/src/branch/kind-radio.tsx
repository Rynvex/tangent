import type { BranchKind } from "@tangent/client";
import { useRef, type KeyboardEvent } from "react";
import { KIND_ICONS, KIND_KEYS } from "../conversation/branch-suggestions";
import type { MessageKey } from "../i18n";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

const HELP_KEYS: Record<BranchKind, MessageKey> = {
  aside: "branch.kindAsideHelp",
  investigate: "branch.kindInvestigateHelp",
  alternative: "branch.kindAlternativeHelp",
};

export interface KindRadioProps<K extends BranchKind = BranchKind> {
  value: K;
  onValueChange: (kind: K) => void;
  /** The kinds to offer, in order; leave `aside` out when that feature is off (not greyed out). */
  kinds: readonly K[];
  /** The group's name; defaults to 種類 / Kind. */
  label?: string;
  className?: string;
}

/** Arrow keys move and select (radio semantics); Home and End jump to the ends. */
function nextIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * The branch kind choice (A3; components.md min w 150, p 10/12): one card per
 * kind with its icon, name and one line of help. A radio group with a single
 * tab stop; selection follows focus.
 */
export function KindRadio<K extends BranchKind>({ value, onValueChange, kinds, label, className }: KindRadioProps<K>) {
  const t = useUiT();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextIndex(event.key, index, kinds.length);
    if (next === null) return;
    event.preventDefault();
    const kind = kinds[next];
    if (kind === undefined) return;
    onValueChange(kind);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label ?? t("branch.kindLabel")} className={cx("grid grid-cols-[repeat(auto-fit,minmax(9.375rem,1fr))] gap-2", className)}>
      {kinds.map((kind, index) => {
        const checked = kind === value;
        return (
          <button
            key={kind}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onValueChange(kind)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              "flex min-h-(--tg-hit-target) flex-col items-start gap-1 rounded-tg border px-3 py-2.5 text-left text-tg-foreground transition-colors duration-(--tg-duration-fast)",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring",
              checked ? "border-tg-primary bg-tg-primary-soft" : "border-tg-border-input bg-tg-surface hover:bg-tg-surface-raised",
            )}
          >
            <span className="inline-flex items-center gap-1.5 text-tg-sm font-semibold [&_svg]:size-3.5 [&_svg]:text-tg-primary-text">
              {KIND_ICONS[kind]}
              {t(KIND_KEYS[kind])}
            </span>
            <span className="text-tg-xs leading-snug text-tg-muted">{t(HELP_KEYS[kind])}</span>
          </button>
        );
      })}
    </div>
  );
}
