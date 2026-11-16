import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export interface CheckboxProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  indeterminate?: boolean;
  disabled?: boolean;
  /** Visible label; clicking it toggles the box. Without it, pass `aria-label`. */
  children?: ReactNode;
  "aria-label"?: string;
  name?: string;
  className?: string;
}

/** A checkbox (Base UI) with an optional label; the box edge uses `--tg-border-input` and the hit area is `--tg-hit-target`. */
export function Checkbox({ children, className, onCheckedChange, ...rest }: CheckboxProps) {
  const box = (
    <CheckboxPrimitive.Root
      {...rest}
      onCheckedChange={(checked) => onCheckedChange?.(checked)}
      className={cx(
        "relative inline-flex size-4 shrink-0 items-center justify-center rounded-[0.25rem] border border-tg-border-input bg-tg-surface text-tg-primary-foreground",
        // An invisible hit area of --tg-hit-target (44px on touch) around the 16px box.
        "before:absolute before:top-1/2 before:left-1/2 before:size-(--tg-hit-target) before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring",
        "data-checked:border-tg-primary data-checked:bg-tg-primary data-indeterminate:border-tg-primary data-indeterminate:bg-tg-primary",
        "data-disabled:cursor-not-allowed data-disabled:opacity-45",
        !children && className,
      )}
    >
      <CheckboxPrimitive.Indicator className="flex data-unchecked:hidden">
        {rest.indeterminate ? <Minus aria-hidden className="size-3" /> : <Check aria-hidden className="size-3" strokeWidth={3} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!children) return box;
  return (
    // The label wraps the box, so clicking the text toggles it and names it.
    <label className={cx("inline-flex min-h-(--tg-hit-target) cursor-pointer items-center gap-2 text-tg-sm text-tg-foreground", className)}>
      {box}
      <span>{children}</span>
    </label>
  );
}
