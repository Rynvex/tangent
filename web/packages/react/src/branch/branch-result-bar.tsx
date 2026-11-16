import { asideDaysLeft, type BranchView } from "@tangent/client";
import { Ban, BookmarkCheck, Combine, GitMerge, Hourglass, Lock, Star } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

export interface BranchResultBarProps {
  branch: BranchView;
  /** The tree is archived (the branch may still be open). */
  archived?: boolean;
  now?: number;
  /** Merged: go to the card in the parent line. */
  onShowCard?: () => void;
  /** Combined into another branch (B9 phase C `mergedIntoLineId`): its name, and going there. */
  mergedIntoTitle?: string;
  onShowMerged?: () => void;
  /** F18: the branch it was combined into is no longer in this tree (deleted, or moved out): said, with no way there. */
  mergedIntoGone?: boolean;
  className?: string;
}

const LINK =
  "text-tg-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11";

function outcome(branch: BranchView, archived: boolean, now: number, t: ReturnType<typeof useUiT>): { icon: ReactNode; text: string } {
  if (archived && branch.status === "open") return { icon: <Lock aria-hidden className="size-4 text-tg-muted" />, text: t("result.archived") };
  if (branch.origin === "previous_main_line") return { icon: <Ban aria-hidden className="size-4 text-tg-branch-discarded" />, text: t("result.previousMainLine") };
  if (branch.kind === "aside" && branch.status === "discarded") {
    // B23: a kept aside is not cleared. The same mark as everywhere else that says 已保留 (the outline, the card, the menu).
    if (branch.keptAt) return { icon: <BookmarkCheck aria-hidden data-tg-kept="" className="size-4 text-tg-muted" />, text: t("result.asideKept") };
    return { icon: <Hourglass aria-hidden className="size-4 text-tg-muted" />, text: t("result.asideAnswered", { days: asideDaysLeft(branch.closedAt, now) }) };
  }
  switch (branch.status) {
    case "merged":
      return { icon: <GitMerge aria-hidden className="size-4 text-tg-branch-merged" />, text: t("result.merged") };
    case "promoted":
      return { icon: <Star aria-hidden className="size-4 text-tg-branch-promoted" />, text: t("result.promoted") };
    default:
      return { icon: <Ban aria-hidden className="size-4 text-tg-branch-discarded" />, text: t("result.discarded") };
  }
}

/**
 * What replaces the composer of a branch that ended (A4 "結束後唯讀"): the
 * outcome — brought back (with a link to the card), not brought back,
 * promoted, an answered aside with its retention — and that it is read-only.
 */
export function BranchResultBar({ branch, archived = false, now = Date.now(), onShowCard, mergedIntoTitle, onShowMerged, mergedIntoGone = false, className }: BranchResultBarProps) {
  const t = useUiT();
  const combined = branch.mergedIntoLineId !== "" && mergedIntoTitle !== undefined;
  const gone = branch.mergedIntoLineId !== "" && !combined && mergedIntoGone;
  const merged = combined ? t("result.mergedInto", { title: mergedIntoTitle }) : gone ? t("branch.mergedIntoGone") : null;
  const { icon, text } = merged !== null ? { icon: <Combine aria-hidden className="size-4 text-tg-muted" />, text: merged } : outcome(branch, archived, now, t);
  return (
    <div role="status" className={cx("flex flex-wrap items-center justify-center gap-2.5 border-t border-tg-border bg-tg-surface-sunken px-4 py-3.5 text-tg-sm text-tg-foreground", className)}>
      {icon}
      <span>{text}</span>
      {combined && onShowMerged && (
        <button type="button" onClick={onShowMerged} className={LINK}>
          {t("result.mergedIntoLink", { title: mergedIntoTitle })}
        </button>
      )}
      {branch.status === "merged" && onShowCard && (
        <button type="button" onClick={onShowCard} className={LINK}>
          {t("result.mergedLink")}
        </button>
      )}
      <span className="text-tg-xs text-tg-subtle">{t("result.readOnly")}</span>
    </div>
  );
}
