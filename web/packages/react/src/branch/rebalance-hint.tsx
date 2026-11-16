import { rebalanceOf, type Rebalance, type Suggestion } from "@tangent/client";
import { Scale } from "lucide-react";
import { Button } from "../components/button";
import type { BundleTranslate } from "../i18n/bundle";
import { useP1T, type P1MessageKey } from "../i18n/p1-messages";
import { cx } from "../lib/cx";

/** Why the tree looks unbalanced, in a sentence. */
export function rebalanceReason(rebalance: Rebalance, t: BundleTranslate<P1MessageKey>): string {
  if (rebalance.reason === "recent") return t("rebalance.recent", { count: rebalance.branchTurns });
  // B8.2: 主線 when the branch hangs on the main line, else the parent branch's title.
  if (rebalance.parentIsMain || !rebalance.parentTitle) return t("rebalance.share", { branch: rebalance.branchTurns, parent: rebalance.parentTurns });
  return t("rebalance.shareParent", { branch: rebalance.branchTurns, parent: rebalance.parentTurns, parentTitle: rebalance.parentTitle });
}

/** The reason and the question as one sentence, joined per language (R7 D4: a space in English, none in Chinese). */
export function rebalanceSentence(rebalance: Rebalance, canPromote: boolean, t: BundleTranslate<P1MessageKey>): string {
  return t("rebalance.sentence", { reason: rebalanceReason(rebalance, t), ask: canPromote ? t("rebalance.ask") : t("rebalance.askSpinoff") });
}

export interface RebalanceHintProps {
  /** A tree-balance suggestion about this branch (`feature: rebalance`). */
  suggestion: Suggestion;
  onPromote: () => void;
  onSpinoff: () => void;
  /** 維持: dismissed for good for this branch. */
  onKeep: () => void;
  /** The keep or an action is being sent. */
  pending?: boolean;
  error?: string | null;
  className?: string;
}

/**
 * The tree-balance hint on the branch bar (B4): a dashed suggestion row with
 * the reason and 升為主線 / 獨立 / 維持 (only the actions the server lists).
 * It never pops up or takes focus; the same suggestion is in 待處理.
 */
export function RebalanceHint({ suggestion, onPromote, onSpinoff, onKeep, pending = false, error = null, className }: RebalanceHintProps) {
  const t = useP1T();
  const rebalance = rebalanceOf(suggestion);
  if (!rebalance) return null;
  const canSpin = rebalance.actions.includes("spinoff");
  const canPromote = rebalance.actions.includes("promote");
  return (
    <div role="group" aria-label={t("rebalance.label")} className={cx("flex flex-col gap-1.5 rounded-tg-sm border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-2.5 py-2", className)}>
      <span className="inline-flex items-center gap-1.5 text-tg-xs font-semibold text-tg-suggestion">
        <Scale aria-hidden className="size-3.25" />
        {t("rebalance.label")}
      </span>
      <span className="text-tg-sm text-tg-foreground">{rebalanceSentence(rebalance, canPromote, t)}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {canPromote && (
          <Button size="sm" variant="primary" disabled={pending} onClick={onPromote}>
            {t("rebalance.promote")}
          </Button>
        )}
        {canSpin && (
          <Button size="sm" disabled={pending} onClick={onSpinoff}>
            {t("rebalance.spinoff")}
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={pending} title={t("rebalance.keepHelp")} onClick={onKeep}>
          {t("rebalance.keep")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
