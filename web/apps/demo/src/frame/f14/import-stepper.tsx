/** F14 ImportStepper: 1 選擇對話 — 2 時間序與結構; a finished step can be pressed to go back to it. */
import { Check } from "lucide-react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";

export function ImportStepper({ step, touch, onBack }: { step: 1 | 2; touch: boolean; onBack: () => void }) {
  const t = useF14T();
  const steps = [
    { n: 1, label: t("import.step1") },
    { n: 2, label: touch ? t("import.step2Short") : t("import.step2") },
  ];
  return (
    <ol aria-label={t("import.stepper")} className="m-0 flex list-none items-center gap-1.5 p-0 text-tg-xs">
      {steps.map(({ n, label }) => {
        const current = n === step;
        const done = n < step;
        const dot = (
          <span
            aria-hidden
            className={cx(
              "grid size-4.5 place-items-center rounded-tg-full border font-tg-mono text-[0.6875rem]",
              current ? "border-tg-primary bg-tg-primary text-tg-primary-foreground" : done ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border-strong text-tg-muted",
            )}
          >
            {done ? <Check className="size-3" /> : n}
          </span>
        );
        return (
          <li key={n} className="flex items-center gap-1.5">
            {n > 1 && <span aria-hidden className="h-px w-6 bg-tg-border-strong" />}
            {done ? (
              <button type="button" onClick={onBack} aria-label={t("import.stepDone", { label })} className="inline-flex items-center gap-1.5 rounded-tg-sm text-tg-muted hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11">
                {dot}
                {label}
              </button>
            ) : (
              <span aria-current={current ? "step" : undefined} className={cx("inline-flex items-center gap-1.5", current ? "font-semibold text-tg-foreground-strong" : "text-tg-muted")}>
                {dot}
                {label}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
