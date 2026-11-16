import { branchTitle, convergeProblem, isFeatureOn, type BranchView } from "@tangent/client";
import { ArrowRight, Split } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../components/button";
import { describeError } from "../conversation/error-text";
import { STATUS_KEYS } from "../conversation/models";
import { useComparisons, useConverge } from "../data/diverge-hooks";
import { useReadOnly } from "../data/live-hooks";
import { useCapabilities } from "../data/queries";
import { useP3T } from "../i18n/p3-messages";
import { INPUT_SURFACE } from "../components/text-field";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";
import CompareTable from "./compare-table";

export interface DivergeMarkerProps {
  /** The line the directions hang on. */
  lineId: string;
  /** The directions one diverge opened from this message (origin `diverge`). */
  branches: readonly BranchView[];
  onEnter: (lineId: string) => void;
}

/**
 * Where a reply diverged (D3; components.md `DivergeMarker`: dashed
 * `--tg-primary`, p 12; its directions, ready to converge): each direction to
 * go to, and a choice of 2–5 open ones to compare (criteria optional). The
 * newest comparison of them shows below as a table with a one-press decision.
 */
export default function DivergeMarker({ lineId, branches, onEnter }: DivergeMarkerProps) {
  const t = useP3T();
  const { hostErrorText } = useTangent();
  const readOnly = useReadOnly();
  const capabilities = useCapabilities();
  const on = isFeatureOn(capabilities.data, "diverge");
  const comparisons = useComparisons(lineId, on);
  const converge = useConverge(lineId);
  const criteriaId = useId();
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [criteria, setCriteria] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ids = new Set(branches.map((branch) => branch.lineId));
  const latest = (comparisons.data?.comparisons ?? []).find((comparison) => comparison.lineIds.every((id) => ids.has(id)));
  const selected = branches.filter((branch) => picked.includes(branch.lineId));
  const problem = convergeProblem(selected);
  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  const compare = () => {
    if (problem || converge.isPending) return;
    setError(null);
    const list = criteria
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    converge.mutateAsync({ lineIds: selected.map((branch) => branch.lineId), ...(list.length > 0 ? { criteria: list } : {}) }).then(
      () => setPicked([]),
      (failure: unknown) => setError(t("diverge.compareFailed", { reason: describeError(failure, t, hostErrorText) })),
    );
  };
  const writable = !readOnly && on;
  // F8 S8: directions opened across models say which model answers each.
  const byModel = new Set(branches.map((branch) => `${branch.provider}/${branch.model}`)).size > 1;
  return (
    <section aria-label={t("diverge.title", { count: branches.length })} className="flex flex-col gap-3 rounded-tg border border-dashed border-tg-primary bg-tg-surface px-3 py-3 font-tg-sans">
      <span className="flex items-center gap-1.5 text-tg-xs font-semibold text-tg-primary-text">
        <Split aria-hidden className="size-3.5" />
        {t("diverge.title", { count: branches.length })}
      </span>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-2.5 p-0">
        {branches.map((branch) => {
          const title = branchTitle(branch, t);
          const open = branch.status === "open";
          return (
            <li key={branch.lineId} className={cx("flex flex-col gap-1 rounded-tg border border-tg-border-strong bg-tg-surface-raised px-3 py-2.5", picked.includes(branch.lineId) && "border-tg-primary")}>
              <span className="text-tg-xs text-tg-primary-text">{t("diverge.messages", { count: branch.messageCount })}</span>
              <span className="text-tg-sm font-semibold break-words text-tg-foreground">{title}</span>
              {byModel && branch.model && <span className="font-tg-mono text-tg-xs text-tg-muted">{branch.model}</span>}
              <span className="text-tg-xs text-tg-muted">{branch.leaf?.line || t(STATUS_KEYS[branch.status])}</span>
              <span className="flex flex-wrap items-center gap-2 pt-1">
                {writable && open && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-tg-xs text-tg-foreground pointer-coarse:min-h-11">
                    <input type="checkbox" aria-label={t("diverge.pick", { title })} checked={picked.includes(branch.lineId)} onChange={() => toggle(branch.lineId)} className="accent-(--tg-primary)" />
                    <span aria-hidden>{t("diverge.pickShort")}</span>
                  </label>
                )}
                <button
                  type="button"
                  aria-label={t("diverge.go", { title })}
                  onClick={() => onEnter(branch.lineId)}
                  className="ml-auto inline-flex h-7 items-center gap-1 rounded-tg-sm px-2 text-tg-xs text-tg-primary-text hover:bg-tg-primary-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11"
                >
                  <ArrowRight aria-hidden className="size-3.5" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {writable && (
        <div className="flex flex-col gap-2">
          <label htmlFor={criteriaId} className="flex flex-col gap-1 text-tg-xs text-tg-muted">
            {t("diverge.criteria")}
            <textarea id={criteriaId} rows={2} value={criteria} onChange={(event) => setCriteria(event.currentTarget.value)} className={cx(INPUT_SURFACE, "resize-y px-2 py-1.5 text-tg-sm")} />
          </label>
          <span className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" aria-disabled={problem !== null || undefined} loading={converge.isPending} onClick={compare}>
              {t("diverge.compare", { count: selected.length })}
            </Button>
            {problem && <span className="text-tg-xs text-tg-muted">{t("diverge.compareHint")}</span>}
          </span>
          {error && (
            <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
              {error}
            </p>
          )}
        </div>
      )}
      {latest && <CompareTable lineId={lineId} comparison={latest} />}
    </section>
  );
}

export { DivergeMarker };
