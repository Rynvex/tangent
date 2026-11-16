import { Loader2 } from "lucide-react";
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "md" | "sm";

/** Focus, disabled and motion rules shared by every pressable control (components.md 通用狀態). */
export const PRESSABLE =
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-(--tg-duration-fast) " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring " +
  "disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:not-aria-busy:cursor-not-allowed aria-disabled:not-aria-busy:opacity-45 aria-busy:cursor-progress";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-tg-primary text-tg-primary-foreground enabled:not-aria-disabled:hover:bg-tg-primary-hover",
  secondary:
    "border border-tg-border-strong bg-tg-surface text-tg-foreground enabled:not-aria-disabled:hover:bg-tg-surface-raised",
  ghost: "bg-transparent text-tg-muted enabled:not-aria-disabled:hover:bg-tg-accent enabled:not-aria-disabled:hover:text-tg-foreground",
  destructive:
    "border border-tg-destructive bg-tg-destructive-soft text-tg-destructive enabled:not-aria-disabled:hover:bg-tg-destructive enabled:not-aria-disabled:hover:text-tg-destructive-soft",
};

const SIZES: Record<ButtonSize, string> = {
  md: "h-(--tg-control-height) min-w-(--tg-hit-target) rounded-tg-sm px-3 text-tg-sm",
  sm: "h-(--tg-control-height-sm) min-w-(--tg-hit-target) rounded-tg-sm px-2.5 text-tg-xs",
};

/** Class names of a button; for links or Base UI parts that should look like one. */
export function buttonClasses(variant: ButtonVariant = "secondary", size: ButtonSize = "md"): string {
  return cx(PRESSABLE, VARIANTS[variant], SIZES[size]);
}

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keeps the button's width, shows a spinner and "Working…", and ignores presses. */
  loading?: boolean;
  /** Replaces "Working…" while loading. */
  loadingText?: string;
  /** An icon before the label. */
  icon?: ReactNode;
}

/**
 * A button in one of four variants. While `loading`, it stays focusable but
 * is `aria-disabled` and `aria-busy`; the label is kept (invisible) so the
 * width does not jump.
 */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingText,
  icon,
  type = "button",
  className,
  children,
  onClick,
  "aria-disabled": ariaDisabled,
  ...rest
}: ButtonProps) {
  const t = useUiT();
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      type={type}
      className={cx(buttonClasses(variant, size), "relative", className)}
      {...rest}
      aria-busy={loading || undefined}
      aria-disabled={loading || ariaDisabled || undefined}
      onClick={handleClick}
    >
      <span aria-hidden={loading || undefined} className={cx("inline-flex items-center gap-1.5", loading && "invisible")}>
        {icon}
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 inline-flex items-center justify-center gap-1.5">
          <Loader2 aria-hidden className="size-3.5 motion-safe:animate-[tg-spin_1s_linear_infinite]" />
          {loadingText ?? t("ui.loading")}
        </span>
      )}
    </button>
  );
}
