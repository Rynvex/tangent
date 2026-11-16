import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";

/**
 * "AI is writing…" text with a turning spinner (still when motion is
 * reduced). The text itself never fades: a pulsing muted text drops below
 * 4.5:1 contrast mid-pulse.
 */
export function Working({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-tg-muted", className)}>
      <Loader2 aria-hidden data-tg-working="" className="size-3.5 shrink-0 motion-safe:animate-[tg-spin_1s_linear_infinite]" />
      {children}
    </span>
  );
}
