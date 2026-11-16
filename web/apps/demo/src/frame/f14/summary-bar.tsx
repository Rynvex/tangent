/**
 * F14 AssemblySummaryBar (S4): what the import will make, updated with the
 * mode and the roles ("將建立 1 條主線（3 個章節、2 條支線與結論卡，共 54 則
 * 訊息，跨度 08/12–08/20）・不呼叫模型"), and 上一步, 確認並純匯入,
 * 確認結構並展開拆解建議. While there is a problem both import buttons are
 * off and point at it; while importing, the pressed one counts "(i / n)".
 * Phones stack three full-width buttons, the main one on top.
 */
import type { AssemblyBlueprint } from "@tangent/client";
import { Button } from "@tangent/react";
import { Info, Sparkles } from "lucide-react";
import { cx } from "../cx";
import { useF14T, type F14T } from "./f14-messages";
import { dayToDay } from "./time-format";

export interface SummaryBarProps {
  blueprint: AssemblyBlueprint;
  folder: string;
  tags: number;
  touch: boolean;
  blocked: boolean;
  /** The problems' element, for aria-describedby of the disabled buttons. */
  problemsId: string | undefined;
  /** `waiting`: a request is waiting out the server's rate limit (B21). */
  importing: { decompose: boolean; done: number; total: number; waiting?: boolean } | null;
  /** After a partial failure there is no going back (the lines made stay; 完成 or 只重試這一篇). */
  backDisabled?: boolean;
  onBack: () => void;
  onImport: (decompose: boolean) => void;
}

export function summaryText(blueprint: AssemblyBlueprint, folder: string, tags: number, t: F14T): string {
  const { summary, mode } = blueprint;
  const range = summary.from && summary.to ? dayToDay(Date.parse(summary.from), Date.parse(summary.to)) : t("summary.noRange");
  if (mode === "batch") {
    const detail = [folder ? t("summary.inFolder", { folder }) : "", tags > 0 ? t("summary.withTags", { t: tags }) : "", summary.relations > 0 ? t("summary.relations", { r: summary.relations }) : ""].join("");
    return t("summary.batch", { n: summary.lines, detail, m: summary.messages });
  }
  if (summary.lines > 1) return t("summary.treePlus", { n: summary.lines, c: summary.chapters, b: summary.branches, s: summary.lines - 1, m: summary.messages, range });
  if (mode === "timeline") return t("summary.timeline", { c: summary.chapters, m: summary.messages, range });
  return t("summary.tree", { c: summary.chapters, b: summary.branches, m: summary.messages, range });
}

export function SummaryBar({ blueprint, folder, tags, touch, blocked, problemsId, importing, backDisabled = false, onBack, onImport }: SummaryBarProps) {
  const t = useF14T();
  const off = blocked || importing !== null;
  const step = importing ? { i: Math.min(importing.done + 1, importing.total), n: importing.total } : null;
  const progress = !step ? "" : importing?.waiting ? t("summary.waiting", step) : t("summary.importing", step);
  const describedBy = blocked ? problemsId : undefined;
  return (
    <div role="group" aria-label={t("summary.label")} aria-busy={importing !== null || undefined} className={cx("flex shrink-0 gap-3 border-t border-tg-border bg-tg-surface-sunken", touch ? "flex-col px-4 pt-2.5 pb-4" : "items-center px-5 py-3")}>
      <p className="m-0 flex min-w-0 flex-1 items-start gap-1.5 text-tg-xs text-tg-foreground" role="status">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-tg-muted" />
        {summaryText(blueprint, folder, tags, t)}
      </p>
      <div className={cx("flex gap-2", touch ? "flex-col-reverse" : "shrink-0 items-center")}>
        <Button variant="ghost" disabled={importing !== null || backDisabled} onClick={onBack} className={cx(touch && "h-11")}>
          {t("summary.back")}
        </Button>
        <Button aria-disabled={off || undefined} aria-describedby={describedBy} onClick={() => !off && onImport(false)} className={cx(touch && "h-11")}>
          {importing && !importing.decompose ? progress : t("summary.importPlain")}
        </Button>
        <Button variant="primary" icon={<Sparkles aria-hidden className="size-3.5" />} aria-disabled={off || undefined} aria-describedby={describedBy} onClick={() => !off && onImport(true)} className={cx(touch && "h-11")}>
          {importing?.decompose ? progress : t("summary.importDecompose")}
        </Button>
      </div>
    </div>
  );
}
