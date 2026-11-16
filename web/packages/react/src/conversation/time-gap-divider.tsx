import { clockTime, describeGap } from "@tangent/client";
import { CirclePause } from "lucide-react";
import { useUiLocale, useUiT } from "../provider";

/**
 * F14 S4 TimeGapDivider: a dashed rule before a message that came 30 minutes
 * or more after the one before it on the same line ("間隔 2 小時 37 分・17:35"),
 * so an imported history shows where it paused.
 */
export function TimeGapDivider({ gapMs, at }: { gapMs: number; at: string }) {
  const t = useUiT();
  const { locale } = useUiLocale();
  const label = t("timeGap.label", { gap: describeGap(gapMs, locale), time: clockTime(at) });
  return (
    // Plain text, not role="separator" (its content would be presentational and often not read); the rules are decoration.
    <p data-tg-time-gap="" className="m-0 mb-3 flex h-5 items-center gap-2 text-tg-xs text-tg-muted">
      <span aria-hidden className="h-0 flex-1 border-t border-dashed border-tg-border-strong" />
      <CirclePause aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">{label}</span>
      <span aria-hidden className="h-0 flex-1 border-t border-dashed border-tg-border-strong" />
    </p>
  );
}
