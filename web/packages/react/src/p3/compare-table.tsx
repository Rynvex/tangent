import { Working } from "../components/working";
import { cellOf, optionLabel, type Comparison, type ComparisonMatrix } from "@tangent/client";
import { Gavel } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../components/button";
import { describeError } from "../conversation/error-text";
import { useDecide } from "../data/diverge-hooks";
import { useReadOnly } from "../data/live-hooks";
import { useP3T } from "../i18n/p3-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";

export interface CompareTableProps {
  /** The line the compared branches hang on. */
  lineId: string;
  comparison: Comparison;
}

function Table({ matrix }: { matrix: ComparisonMatrix }) {
  const t = useP3T();
  return (
    <div className="overflow-x-auto rounded-tg-sm border border-tg-border bg-tg-surface-raised">
      <table className="w-full border-collapse text-tg-sm">
        <caption className="sr-only">{t("compare.caption")}</caption>
        <thead>
          <tr>
            <th scope="col" className="bg-tg-surface-sunken px-3 py-2 text-left font-medium text-tg-muted">
              {t("compare.criterion")}
            </th>
            {matrix.options.map((option) => (
              <th key={option.lineId} scope="col" className="min-w-30 bg-tg-surface-sunken px-3 py-2 text-left font-medium text-tg-foreground">
                {option.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.criteria.map((criterion, row) => (
            <tr key={`${criterion}-${row}`}>
              <th scope="row" className="border-t border-tg-border px-3 py-2 text-left font-normal whitespace-nowrap text-tg-muted">
                {criterion}
              </th>
              {matrix.options.map((option, column) => {
                const cell = cellOf(matrix, row, column);
                const recommended = option.lineId === matrix.recommendation.lineId;
                return (
                  <td key={option.lineId} className={cx("border-t border-tg-border px-3 py-2 align-top", recommended && "bg-tg-success-soft")}>
                    <span className="font-tg-mono font-semibold" aria-label={cell.score > 0 ? t("compare.scoreLabel", { score: cell.score }) : undefined}>
                      {cell.score > 0 ? cell.score : t("compare.noScore")}
                    </span>
                    {cell.why && <span className="block text-tg-xs text-tg-muted">{cell.why}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Choose (the recommendation first), say it in one line if wanted, and write
 * the decision. Its state belongs to one comparison (keyed by its id); once
 * written, the button stays locked until the decided view replaces this.
 */
function Decide({ lineId, comparison, matrix }: { lineId: string; comparison: Comparison; matrix: ComparisonMatrix }) {
  const t = useP3T();
  const { hostErrorText } = useTangent();
  const decide = useDecide(lineId);
  const name = useId();
  const labelId = useId();
  const lineFieldId = useId();
  const [chosen, setChosen] = useState(matrix.recommendation.lineId || matrix.options[0]?.lineId || "");
  const [line, setLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState(false);
  const busy = decide.isPending || written;
  const submit = () => {
    if (busy || !chosen) return;
    setError(null);
    decide.mutateAsync({ comparisonId: comparison.id, input: { lineId: chosen, ...(line.trim() ? { line: line.trim() } : {}) } }).then(
      () => setWritten(true),
      (failure: unknown) => setError(t("compare.decideFailed", { reason: describeError(failure, t, hostErrorText) })),
    );
  };
  return (
    <div className="flex flex-col gap-2.5">
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-1.5">
        <span id={labelId} className="text-tg-xs font-semibold text-tg-muted">
          {t("compare.choose")}
        </span>
        {matrix.options.map((option) => (
          <label key={option.lineId} className="flex cursor-pointer items-center gap-2 text-tg-sm text-tg-foreground pointer-coarse:min-h-11">
            <input type="radio" name={name} value={option.lineId} checked={chosen === option.lineId} onChange={() => setChosen(option.lineId)} className="accent-(--tg-primary)" />
            {option.lineId === matrix.recommendation.lineId ? t("compare.recommended", { title: option.label }) : option.label}
          </label>
        ))}
      </div>
      <label htmlFor={lineFieldId} className="flex flex-col gap-1 text-tg-xs text-tg-muted">
        {t("compare.decisionLine")}
        <input id={lineFieldId} value={line} maxLength={300} onChange={(event) => setLine(event.currentTarget.value)} className="h-8 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 text-tg-sm text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring" />
      </label>
      <Button variant="primary" size="sm" className="self-start" loading={busy} icon={<Gavel aria-hidden className="size-3.5" />} onClick={submit}>
        {t("compare.decide")}
      </Button>
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A comparison of directions (D3; components.md `CompareTable`: min column
 * 120, cells p 8/10; draft, decision, confirmed): criteria × options with
 * each score and its reason, AI's recommendation, and one press to write the
 * decision (the others end, not brought back). Scores are AI's (not editable).
 */
export default function CompareTable({ lineId, comparison }: CompareTableProps) {
  const t = useP3T();
  const readOnly = useReadOnly();
  const matrix = comparison.matrix;
  if (comparison.status === "drafting") return <Working className="text-tg-sm">{t("compare.drafting")}</Working>;
  if (comparison.status === "failed" || !matrix) return <p className="m-0 text-tg-sm text-tg-warning">{t("compare.failed")}</p>;
  const decided = comparison.status === "decided";
  const recommended = optionLabel(matrix, matrix.recommendation.lineId);
  return (
    <div className="flex flex-col gap-2.5">
      <Table matrix={matrix} />
      {decided ? (
        <p className="m-0 flex flex-wrap items-center gap-x-2 rounded-tg-sm border border-dashed border-tg-leaf-decision px-2.5 py-2 text-tg-sm text-tg-foreground">
          <Gavel aria-hidden className="size-3.5 text-tg-leaf-decision" />
          <span>{t("compare.decided", { title: optionLabel(matrix, comparison.decidedLineId) })}</span>
          <span className="text-tg-muted">{t("compare.decidedOthers", { count: comparison.lineIds.length - 1 })}</span>
        </p>
      ) : (
        <div className="flex flex-col gap-2.5 rounded-tg-sm bg-tg-success-soft px-3 py-2.5">
          <p className="m-0 text-tg-sm text-tg-foreground">
            <span className="font-semibold">{t("compare.recommend", { title: recommended })}</span>
            {matrix.recommendation.reason && <span className="ml-1.5">{matrix.recommendation.reason}</span>}
          </p>
          {!readOnly && <Decide key={comparison.id} lineId={lineId} comparison={comparison} matrix={matrix} />}
        </div>
      )}
    </div>
  );
}

export { CompareTable };
