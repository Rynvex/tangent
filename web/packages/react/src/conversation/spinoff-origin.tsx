import type { SpinoffRef } from "@tangent/client";
import { CornerUpLeft } from "lucide-react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

export interface SpinoffOriginProps {
  /** `LineView.spunOffFrom`. */
  origin: SpinoffRef;
  /** Goes to the source line, at the message it forked from. */
  onGo: (lineId: string, messageId: string) => void;
  className?: string;
}

/** 「來自：…」 at the top of a conversation made by a spinoff (B2); goes back to where it forked, while that conversation exists. */
export function SpinoffOrigin({ origin, onGo, className }: SpinoffOriginProps) {
  const t = useUiT();
  const bar = cx("flex shrink-0 items-center border-b border-tg-border bg-tg-surface-sunken px-4 py-1.5", className);
  // B8.2: the source conversation may be gone; then it is named, not linked.
  if (!origin.available) {
    return (
      <div className={bar}>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-tg-xs text-tg-muted">
          <CornerUpLeft aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{t("spinoff.fromGone", { title: origin.title })}</span>
        </span>
      </div>
    );
  }
  return (
    <div className={bar}>
      <button
        type="button"
        onClick={() => onGo(origin.lineId, origin.messageId)}
        className="inline-flex min-w-0 items-center gap-1.5 text-tg-xs text-tg-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
      >
        <CornerUpLeft aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{t("spinoff.from", { title: origin.title })}</span>
      </button>
    </div>
  );
}
