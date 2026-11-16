import { branchTitle, idleDays, type StaleBranch } from "@tangent/client";
import { Hourglass } from "lucide-react";
import { Button } from "../components/button";
import { useOpenLoops } from "../data/p2-hooks";
import { useP1T } from "../i18n/p1-messages";
import { useP2T } from "../i18n/p2-messages";
import { ListState, Section } from "./inbox-section";
import { INBOX_CARD } from "./seed-card";

export interface StaleSectionProps {
  rootLineId: string;
  readOnly: boolean;
  /** 繼續: go to the branch. */
  onContinue?: ((lineId: string) => void) | undefined;
  /** 結束並帶回: the host starts its conclusion card. */
  onEnd?: ((lineId: string) => void) | undefined;
}

function StaleCard({ branch, readOnly, onContinue, onEnd }: { branch: StaleBranch } & Omit<StaleSectionProps, "rootLineId">) {
  const t = useP2T();
  const p1 = useP1T();
  const title = branchTitle(branch, p1);
  return (
    <article aria-label={title} className={INBOX_CARD}>
      <span className="text-tg-sm break-words text-tg-foreground">{title}</span>
      <span className="text-tg-xs text-tg-muted">{t("stale.meta", { count: branch.messageCount, days: idleDays(branch.lastActivityAt) })}</span>
      {!readOnly && (onContinue || onEnd) && (
        <div className="flex flex-wrap gap-1.5">
          {onContinue && (
            <Button size="sm" variant="primary" onClick={() => onContinue(branch.lineId)}>
              {t("stale.continue")}
            </Button>
          )}
          {onEnd && (
            <Button size="sm" onClick={() => onEnd(branch.lineId)}>
              {t("stale.end")}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * 待處理's 開太久的支線 (B9 open_loops): open branches of this tree idle for
 * longer than the server's threshold, the longest-idle first. Continue goes
 * there; end-and-bring-back starts the conclusion card (the host's flow).
 */
export function StaleSection({ rootLineId, readOnly, onContinue, onEnd }: StaleSectionProps) {
  const t = useP2T();
  const loops = useOpenLoops(rootLineId);
  const items = loops.data?.staleBranches.items ?? [];
  return (
    <Section icon={<Hourglass aria-hidden className="size-3.25" />} title={t("stale.title")} count={t("stale.count", { count: loops.data?.staleBranches.total ?? 0 })}>
      <ListState query={{ isPending: loops.isPending, isError: loops.isError, refetch: loops.refetch, items }} empty={t("stale.empty")}>
        {items.map((branch) => (
          <StaleCard key={branch.lineId} branch={branch} readOnly={readOnly} onContinue={onContinue} onEnd={onEnd} />
        ))}
      </ListState>
    </Section>
  );
}
