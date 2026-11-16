import { branchTitle, idleDays, rebalanceOf, type OpenNote, type OpenSeed, type OpenSuggestion, type StaleBranch } from "@tangent/client";
import { Button, describeError, useAcceptSuggestion, useDismissSuggestion, useDropSeed, useTangent, useUpdateNote, useUiT } from "@tangent/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useReviewT } from "./review-messages";

export interface CardAction {
  label: string;
  run: () => Promise<unknown> | void;
  primary?: boolean;
}

export interface ReviewCardProps {
  title: string;
  meta: string;
  end?: CardAction;
  cont?: CardAction;
  snoozed: boolean;
  onSnooze: () => void;
  onUnsnooze: () => void;
  readOnly: boolean;
}

/** One unfinished item (C5): what it is, then 結束 / 暫存 / 繼續 (a snoozed one only comes back). */
export function ReviewCard({ title, meta, end, cont, snoozed, onSnooze, onUnsnooze, readOnly }: ReviewCardProps) {
  const t = useReviewT();
  const { hostErrorText } = useTangent();
  const queryClient = useQueryClient();
  const { keys } = useTangent();
  const [pending, setPending] = useState<"end" | "cont" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each card awaits its own write (R7: one shared mutation's per-call callbacks only fire for its last call).
  const run = (which: "end" | "cont", action: CardAction) => {
    const result = action.run();
    if (!result) return;
    setPending(which);
    setError(null);
    result
      .then(() => queryClient.invalidateQueries({ queryKey: keys.openLoopsAll() }))
      .catch((failure: unknown) => setError(t("review.failed", { reason: describeError(failure, t, hostErrorText) })))
      .finally(() => setPending(null));
  };
  return (
    <article aria-label={title} data-snoozed={snoozed || undefined} className="flex flex-col gap-1.5 rounded-tg border border-tg-border bg-tg-surface p-2.5 shadow-tg data-snoozed:opacity-70">
      <span className="text-tg-sm break-words text-tg-foreground">{title}</span>
      {meta && <span className="text-tg-xs text-tg-muted">{meta}</span>}
      {!readOnly && (
        <div className="flex flex-wrap gap-1.5">
          {snoozed ? (
            <Button size="sm" onClick={onUnsnooze}>
              {t("review.unsnooze")}
            </Button>
          ) : (
            <>
              {end && (
                <Button size="sm" loading={pending === "end"} disabled={pending === "cont"} onClick={() => run("end", end)}>
                  {end.label}
                </Button>
              )}
              <Button size="sm" title={t("review.snoozeHelp")} disabled={pending !== null} onClick={onSnooze}>
                {t("review.snooze")}
              </Button>
              {cont && (
                <Button size="sm" variant="primary" loading={pending === "cont"} disabled={pending === "end"} onClick={() => run("cont", cont)}>
                  {cont.label}
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </article>
  );
}

export type SnoozeProps = Pick<ReviewCardProps, "snoozed" | "onSnooze" | "onUnsnooze" | "readOnly">;

/** The conversation's title first when the review spans every conversation. */
function inScope(all: boolean, rootTitle: string, meta: string, t: ReturnType<typeof useReviewT>): string {
  return all && rootTitle ? t("review.inConversation", { title: rootTitle, meta }) : meta;
}

export function StaleCard({ item, all, onContinue, onEnd, ...snooze }: { item: StaleBranch; all: boolean; onContinue: () => void; onEnd: () => void } & SnoozeProps) {
  const t = useReviewT();
  const ui = useUiT();
  const meta = t("review.staleMeta", { days: idleDays(item.lastActivityAt), count: item.messageCount });
  return (
    <ReviewCard
      title={branchTitle(item, ui)}
      meta={inScope(all, item.rootTitle, meta, t)}
      end={{ label: t("review.end"), run: onEnd }}
      cont={{ label: t("review.continue"), run: onContinue, primary: true }}
      {...snooze}
    />
  );
}

/** 已確認 moves the note to 已確認的事實; 繼續 goes to where it came from. */
export function NoteCard({ item, all, onContinue, ...snooze }: { item: OpenNote; all: boolean; onContinue: () => void } & SnoozeProps) {
  const t = useReviewT();
  const update = useUpdateNote(item.rootLineId);
  const meta = item.sourceLabel ? t("review.from", { source: item.sourceLabel }) : "";
  return (
    <ReviewCard
      title={item.text}
      meta={inScope(all, item.rootTitle, meta, t)}
      end={{ label: t("review.confirmed"), run: () => update.mutateAsync({ noteId: item.id, input: { section: "fact" } }) }}
      cont={{ label: t("review.continue"), run: onContinue }}
      {...snooze}
    />
  );
}

export function SeedCardItem({ item, all, onExpand, ...snooze }: { item: OpenSeed; all: boolean; onExpand: () => void } & SnoozeProps) {
  const t = useReviewT();
  const drop = useDropSeed(item.rootLineId);
  const meta = item.sourceLabel ? t("review.from", { source: item.sourceLabel }) : "";
  return (
    <ReviewCard
      title={item.text}
      meta={inScope(all, item.rootTitle, meta, t)}
      end={{ label: t("review.drop"), run: () => drop.mutateAsync({ seedId: item.id }) }}
      cont={{ label: t("review.expand"), run: onExpand }}
      {...snooze}
    />
  );
}

/** 繼續 accepts it; a tree-balance one needs its choice, so it goes to that branch instead. */
export function SuggestionItem({ item, all, kindName, detail, onGo, ...snooze }: { item: OpenSuggestion; all: boolean; kindName: string; detail: string; onGo: () => void } & SnoozeProps) {
  const t = useReviewT();
  const accept = useAcceptSuggestion(item.rootLineId);
  const dismiss = useDismissSuggestion(item.rootLineId);
  const needsChoice = rebalanceOf(item) !== null;
  return (
    <ReviewCard
      title={detail ? `${kindName}：${detail}` : kindName}
      meta={inScope(all, item.rootTitle, "", t)}
      end={{ label: t("review.dismiss"), run: () => dismiss.mutateAsync({ suggestionId: item.id }) }}
      cont={needsChoice ? { label: t("review.continue"), run: onGo } : { label: t("review.accept"), run: () => accept.mutateAsync({ suggestionId: item.id }) }}
      {...snooze}
    />
  );
}
