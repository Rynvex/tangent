import { SummaryDueHint } from "@tangent/react";

/** The summary-due offer, loaded only once a line is due (B8.2): the main bundle carries just the flag. */
export function SummaryDue({ lineId }: { lineId: string }) {
  return <SummaryDueHint lineId={lineId} className="mx-auto mb-2 max-w-tg-reading" />;
}
