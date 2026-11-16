import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../lib/cx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Shown at 45% and skipped by the arrows (say why next to the control). */
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** The group's accessible name. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Monospace labels (amounts). */
  mono?: boolean;
  className?: string;
}

const STEP: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * A small single-choice switch (the prototype's sunken pill): radio
 * semantics, one tab stop on the chosen option; arrows, Home and End move
 * and select at once.
 */
export function SegmentedControl<T extends string>({ label, options, value, onValueChange, mono = false, className }: SegmentedControlProps<T>) {
  const group = useRef<HTMLDivElement>(null);
  const select = (index: number, step = 1) => {
    let option = options[(index + options.length) % options.length];
    for (let tries = 0; option?.disabled && tries < options.length; tries += 1) option = options[(((index + step * (tries + 1)) % options.length) + options.length) % options.length];
    if (!option || option.disabled) return;
    onValueChange(option.value);
    group.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(option.value)}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = options.findIndex((option) => option.value === value);
    const step = STEP[event.key];
    if (step !== undefined) select(current + step, step);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(options.length - 1);
    else return;
    event.preventDefault();
  };
  return (
    <div ref={group} role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={cx("inline-flex flex-wrap gap-0.5 self-start rounded-tg-sm bg-tg-surface-sunken p-0.5", className)}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={checked}
            aria-disabled={option.disabled || undefined}
            tabIndex={checked ? 0 : -1}
            onClick={() => !option.disabled && onValueChange(option.value)}
            className={cx(
              "flex h-6.5 items-center rounded-tg-sm px-2.5 text-tg-xs transition-colors duration-(--tg-duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11",
              mono && "font-tg-mono",
              checked ? "bg-tg-surface-raised text-tg-foreground-strong shadow-tg" : "text-tg-muted hover:text-tg-foreground",
              option.disabled && "cursor-not-allowed opacity-45 hover:text-tg-muted",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
