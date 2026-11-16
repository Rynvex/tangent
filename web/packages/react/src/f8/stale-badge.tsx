import { cardEditReasons, isFeatureOn, staleBranchIds, staleReasons, type BranchView, type Link, type Note, type StaleReason } from "@tangent/client";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Button } from "../components/button";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../components/popover";
import { useNotes } from "../data/branch-queries";
import { useReadOnly } from "../data/live-hooks";
import { useRelations } from "../data/p2-hooks";
import { useBranches, useCapabilities } from "../data/queries";
import { useF8T } from "../i18n/f8-messages";
import { cx } from "../lib/cx";
import { dismissStale as dismiss, useDismissedStale as useDismissed } from "./stale-dismissed";

/** The tree's notes and relations while their features are on (both feed 前提已更新). */
function useStaleSources(rootLineId: string): { notes: readonly Note[]; relations: readonly Link[]; on: boolean } {
  const capabilities = useCapabilities();
  const notesOn = isFeatureOn(capabilities.data, "notes");
  const relationsOn = isFeatureOn(capabilities.data, "relations");
  const notes = useNotes(rootLineId, notesOn);
  const relations = useRelations(rootLineId, relationsOn);
  return { notes: notes.data?.notes ?? [], relations: relations.data?.relations ?? [], on: notesOn || relationsOn };
}

/**
 * Why a branch's premise changed (S12), the reasons set aside left out: for a
 * returned branch its notes and relations; (B17, decision #6) for a branch
 * opened from a conclusion card, an edit of that card made after it opened.
 */
export function useStaleReasons(rootLineId: string, branch: BranchView | null): StaleReason[] {
  const { notes, relations, on } = useStaleSources(rootLineId);
  const dismissed = useDismissed();
  const outline = useBranches(rootLineId, true).data?.branches;
  return useMemo(() => {
    if (!branch) return [];
    const premise = on ? staleReasons(branch, notes, relations, dismissed) : [];
    return [...premise, ...cardEditReasons(branch, outline ?? [], dismissed)];
  }, [on, branch, notes, relations, dismissed, outline]);
}

/** The outline's branches with a reason (their mark in the outline and the map): returned ones, and follow-ups of an edited card. */
export function useStaleBranches(rootLineId: string, branches: readonly BranchView[]): ReadonlySet<string> {
  const { notes, relations, on } = useStaleSources(rootLineId);
  const dismissed = useDismissed();
  return useMemo(() => {
    const ids = on ? staleBranchIds(branches, notes, relations, dismissed) : new Set<string>();
    for (const branch of branches) if (cardEditReasons(branch, branches, dismissed).length > 0) ids.add(branch.lineId);
    return ids;
  }, [on, branches, notes, relations, dismissed]);
}

export interface StaleReasonsProps {
  reasons: readonly StaleReason[];
  /** 看紀要: the host opens the notes and shows the note. */
  onGoToNote?: (note: Note) => void;
  /** 到那裡: the relation's other end. */
  onGoToRelation?: (relation: Link) => void;
  /** B17 看結論卡: the edited card a follow-up was opened from (its line and message). */
  onGoToCard?: (lineId: string, messageId: string) => void;
  className?: string;
}

function reasonText(reason: StaleReason, t: ReturnType<typeof useF8T>): string {
  switch (reason.kind) {
    case "noteSuperseded":
      return reason.replacement ? t("stale.noteSuperseded", { old: reason.note.text, new: reason.replacement.text }) : t("stale.noteRemoved", { old: reason.note.text });
    case "contradicts":
      return t("stale.contradicts", { title: reason.relation.fromTitle || reason.relation.label });
    case "cardEdited":
      return t("stale.cardEdited", { title: reason.title });
  }
}

/** The reasons, each with the way to it, then 結論卡不會自動改 and (writers) 知道了 (the node panel shows it inline; the badge in its popover). */
export function StaleReasons({ reasons, onGoToNote, onGoToRelation, onGoToCard, className }: StaleReasonsProps) {
  const t = useF8T();
  const readOnly = useReadOnly();
  if (reasons.length === 0) return null;
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {reasons.map((reason) => (
          <li key={reason.id} className="flex flex-col gap-1 text-tg-sm text-tg-foreground">
            <span className="break-words">{reasonText(reason, t)}</span>
            {reason.kind === "noteSuperseded" && onGoToNote && (
              <Button size="sm" variant="ghost" className="self-start text-tg-primary-text" icon={<ArrowRight aria-hidden className="size-3" />} onClick={() => onGoToNote(reason.replacement ?? reason.note)}>
                {t("stale.goToNote")}
              </Button>
            )}
            {reason.kind === "cardEdited" && onGoToCard && (
              <Button size="sm" variant="ghost" className="self-start text-tg-primary-text" icon={<ArrowRight aria-hidden className="size-3" />} onClick={() => onGoToCard(reason.cardLineId, reason.cardMessageId)}>
                {t("stale.goToCard")}
              </Button>
            )}
            {reason.kind === "contradicts" && onGoToRelation && (
              <Button size="sm" variant="ghost" className="self-start text-tg-primary-text" icon={<ArrowRight aria-hidden className="size-3" />} onClick={() => onGoToRelation(reason.relation)}>
                {t("stale.goToRelation")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="m-0 text-tg-xs text-tg-muted">{t("stale.cardStays")}</p>
      {!readOnly && (
        <Button size="sm" className="self-start" onClick={() => dismiss(reasons.map((reason) => reason.id))}>
          {t("stale.dismiss")}
        </Button>
      )}
    </div>
  );
}

const BADGE =
  "inline-flex h-5.5 items-center gap-1 rounded-tg-sm border border-tg-warning bg-tg-warning-soft px-1.75 text-[0.6875rem] font-medium text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11";

export interface StaleBadgeProps extends Omit<StaleReasonsProps, "reasons"> {
  rootLineId: string;
  /** A returned branch (its card); nothing shows for one without a reason. */
  branch: BranchView;
}

/**
 * 前提已更新 (S12, decision #5; components.md `StaleBadge` / `StalePopover`):
 * Lucide TriangleAlert with the --tg-warning solid edge on --tg-warning-soft
 * (no emoji, never dashed — dashes mean an unconfirmed AI draft). It opens
 * the reasons (w360); the card itself never changes on its own.
 */
export function StaleBadge({ rootLineId, branch, className, ...rest }: StaleBadgeProps) {
  const t = useF8T();
  const reasons = useStaleReasons(rootLineId, branch);
  if (reasons.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger className={cx(BADGE, className)} aria-label={t("stale.label", { title: branch.purpose })}>
        <TriangleAlert aria-hidden className="size-3 shrink-0 text-tg-warning" />
        {t("stale.badge")}
      </PopoverTrigger>
      <PopoverContent title={t("stale.title")} className="w-90">
        <StaleReasons reasons={reasons} {...rest} />
        <PopoverClose className="sr-only">{t("search.close")}</PopoverClose>
      </PopoverContent>
    </Popover>
  );
}

/** The 20px round mark the outline and the map put left of a stale branch's status. */
export function StaleMark({ className }: { className?: string }) {
  const t = useF8T();
  return (
    <span role="img" aria-label={t("stale.badge")} title={t("stale.badge")} className={cx("inline-flex size-5 shrink-0 items-center justify-center rounded-tg-full border border-tg-warning bg-tg-warning-soft", className)}>
      <TriangleAlert aria-hidden className="size-3 text-tg-warning" />
    </span>
  );
}
