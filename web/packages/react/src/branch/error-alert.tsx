import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";

/** A refusal shown inside a dialog: `--tg-destructive-soft`, announced as an alert. */
export function ErrorAlert({ children, tone = "destructive", className }: { children: ReactNode; tone?: "destructive" | "warning"; className?: string }) {
  return (
    <div
      role="alert"
      className={cx(
        "flex flex-wrap items-start gap-2 rounded-tg-sm px-3 py-2.5 text-tg-sm text-tg-foreground",
        tone === "destructive" ? "bg-tg-destructive-soft" : "bg-tg-warning-soft",
        className,
      )}
    >
      <TriangleAlert aria-hidden className={cx("mt-0.5 size-4 shrink-0", tone === "destructive" ? "text-tg-destructive" : "text-tg-warning")} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}
