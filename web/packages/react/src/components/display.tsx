import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../lib/cx";

export interface KbdProps extends ComponentPropsWithRef<"kbd"> {
  /** Adds `tg-kbd-hint`, which hides the key on touch screens (review §2 #3). */
  hint?: boolean;
}

/** One key or key combination, e.g. `<Kbd>⌘ K</Kbd>`. */
export function Kbd({ hint = false, className, ...rest }: KbdProps) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[0.25rem] border border-tg-border px-1 font-tg-mono text-tg-xs leading-none font-normal text-tg-subtle",
        hint && "tg-kbd-hint",
        className,
      )}
      {...rest}
    />
  );
}

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "destructive" | "suggestion";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-tg-accent text-tg-foreground",
  primary: "bg-tg-primary-soft text-tg-primary-text",
  success: "bg-tg-success-soft text-tg-success",
  warning: "bg-tg-warning-soft text-tg-warning",
  destructive: "bg-tg-destructive-soft text-tg-destructive",
  suggestion: "border border-dashed border-tg-suggestion bg-tg-suggestion-soft text-tg-suggestion",
};

export interface BadgeProps extends ComponentPropsWithRef<"span"> {
  tone?: BadgeTone;
  children: ReactNode;
}

/** A small status or count pill (e.g. the inbox count, "AI 草稿"). */
export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex h-4.5 min-w-4.5 items-center justify-center gap-1 rounded-tg-full px-1.5 text-tg-xs leading-none font-medium tabular-nums",
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}

export interface SkeletonProps {
  className?: string;
}

/** A loading placeholder block; pulses with `tg-shimmer`, holds still with reduced motion. */
export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden className={cx("tg-shimmer rounded-tg-sm bg-tg-accent", className)} />;
}

/** Visually hidden text for screen readers. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
