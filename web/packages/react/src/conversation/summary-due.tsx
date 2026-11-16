import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/button";
import { useSummaryDue } from "../data/live-hooks";
import { useCompact } from "../data/mutations";
import { cx } from "../lib/cx";
import { useP1T } from "../i18n/p1-messages";
import { useTangent } from "../provider";
import { describeError } from "./error-text";

export interface SummaryDueHintProps {
  lineId: string;
  className?: string;
}

/**
 * The summary-due offer (B8.2 `summary.due`, the summary feature in suggest
 * mode): a dashed suggestion row above the composer with 整理摘要 (`POST
 * /compact`) and 稍後. It never takes focus; a newer summary or an answer
 * clears it, and the server asks again after a later turn while it is due.
 */
export function SummaryDueHint({ lineId, className }: SummaryDueHintProps) {
  const t = useP1T();
  const { live, hostErrorText } = useTangent();
  const due = useSummaryDue(lineId);
  const compact = useCompact(lineId);
  const [failure, setFailure] = useState<string | null>(null);
  if (!due && !failure) return null;
  const close = () => {
    setFailure(null);
    live.setSummaryDue(lineId, false);
  };
  const start = () =>
    void compact.mutateAsync().then(close, (error: unknown) => setFailure(t("summaryDue.failed", { reason: describeError(error, t, hostErrorText) })));
  return (
    <div role="group" aria-label={t("summaryDue.label")} className={cx("flex flex-wrap items-center gap-2 rounded-tg-sm border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-2.5 py-1.5", className)}>
      <Sparkles aria-hidden className="size-3.5 shrink-0 text-tg-suggestion" />
      <span className="min-w-0 flex-[1_1_12rem] text-tg-xs text-tg-foreground">{t("summaryDue.text")}</span>
      <Button size="sm" variant="primary" loading={compact.isPending} onClick={start}>
        {t("summaryDue.compact")}
      </Button>
      <Button size="sm" variant="ghost" onClick={close}>
        {t("summaryDue.later")}
      </Button>
      {failure && (
        <p role="alert" className="m-0 w-full text-tg-xs text-tg-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
