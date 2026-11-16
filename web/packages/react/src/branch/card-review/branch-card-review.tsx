import { useDialogT } from "../../i18n/dialog-messages";
import type { MergeBranchResult } from "@tangent/client";
import { CheckCheck, GitMerge, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { Button } from "../../components/button";
import { Badge, Skeleton } from "../../components/display";
import { Dialog, DialogClose, DialogContent } from "../../components/dialog";
import { useNotes } from "../../data/branch-queries";
import { ErrorAlert } from "../error-alert";
import { CardForm } from "./card-form";
import { fieldErrors } from "./card-errors";
import { NoteProposals } from "./note-proposals";
import { ReviewNotices } from "./review-notices";
import { useCardReview, type CardReviewState } from "./use-card-review";

export interface BranchCardReviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The branch line whose card is reviewed. */
  lineId: string;
  /** The card is in the parent line now (switch there and highlight `result.message.id`). */
  onMerged: (result: MergeBranchResult) => void;
  /** "Don't bring back instead…": the host opens the discard dialog. */
  onDiscard: () => void;
}

/** While the AI drafts over the card (asked for, or still running from before): what is happening, and a way out. */
function DraftingBar({ onWriteOwn }: { onWriteOwn: () => void }) {
  const t = useDialogT();
  return (
    <div role="status" className="flex flex-wrap items-center gap-2.5 rounded-tg-sm bg-tg-primary-soft px-3 py-2.5 text-tg-sm text-tg-foreground">
      <Loader2 aria-hidden className="size-4 shrink-0 text-tg-primary-text motion-safe:animate-[tg-spin_1s_linear_infinite]" />
      <span className="flex flex-[1_1_16rem] flex-col gap-0.5">
        <span>{t("review.drafting")}</span>
        <span className="text-tg-xs text-tg-muted">{t("review.draftingHelp")}</span>
      </span>
      <Button size="sm" onClick={onWriteOwn}>
        {t("review.writeOwn")}
      </Button>
    </div>
  );
}

/** F10 §4.1: the AI draft only when asked for (card_draft not off); it replaces the card when it arrives. */
function AskAi({ review }: { review: CardReviewState }) {
  const t = useDialogT();
  if (!review.aiDraftOn) return null;
  return (
    <div className="flex flex-col gap-2">
      <Button className="self-start" loading={review.aiBusy} onClick={review.askAi}>
        {t("review.askAi")}
      </Button>
      {review.flow.phase === "drafting" && <DraftingBar onWriteOwn={review.abandon} />}
    </div>
  );
}

/** After a failed bring-back, focuses the first field with a problem, or scrolls to the first problem shown. */
function useShowFirstProblem(form: RefObject<HTMLDivElement | null>, failures: number): void {
  useEffect(() => {
    if (failures === 0) return;
    const root = form.current;
    const field = root?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid] input, [data-invalid] textarea');
    if (field) {
      field.focus();
      return;
    }
    root?.querySelector<HTMLElement>("[data-card-error]")?.scrollIntoView?.({ block: "center" });
  }, [form, failures]);
}

function Footer({ review, onDiscard }: { review: CardReviewState; onDiscard: () => void }) {
  const t = useDialogT();
  const canTick = review.notesOn && review.rows.length > 0;
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Button variant="ghost" onClick={onDiscard}>
        {t("review.discardInstead")}
      </Button>
      <span className="min-w-2 flex-1 text-right text-tg-xs text-tg-subtle">{t("review.hint")}</span>
      <DialogClose render={<Button>{t("review.later")}</Button>} />
      {canTick && (
        <Button loading={review.pending} disabled={review.aiBusy} onClick={() => review.submit("ticked")}>
          {t("review.bringBackTicked")}
        </Button>
      )}
      <Button variant="primary" loading={review.pending} disabled={review.aiBusy} icon={<CheckCheck aria-hidden className="size-3.5" />} onClick={() => review.submit("all")}>
        {t("review.acceptAll")}
      </Button>
    </div>
  );
}

function ReviewBody({ lineId, onMerged, onDiscard }: Omit<BranchCardReviewProps, "open" | "onOpenChange">) {
  const t = useDialogT();
  const review = useCardReview(lineId, onMerged);
  const { flow, detail } = review;
  const notes = useNotes(detail?.branch.rootLineId ?? null, review.notesOn);
  const errors = useMemo(() => fieldErrors(review.problems, review.attempted, review.serverErrors, t), [review.problems, review.attempted, review.serverErrors, t]);
  const inReview = flow.phase === "review";
  const withForm = inReview || flow.phase === "drafting";
  const form = useRef<HTMLDivElement>(null);
  useShowFirstProblem(form, review.fieldFailures);
  const purpose = detail?.branch.purpose ?? "";
  return (
    <DialogContent
      width="xl"
      title={
        <span className="inline-flex items-center gap-2">
          <GitMerge aria-hidden className="size-4.5 text-tg-branch-merged" />
          {t("message.card")}
        </span>
      }
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          {purpose && t("review.branch", { purpose })}
          {inReview && flow.source === "ai" && <Badge tone="suggestion">{t("review.aiDraft")}</Badge>}
        </span>
      }
      footer={withForm ? <Footer review={review} onDiscard={onDiscard} /> : undefined}
    >
      {flow.phase === "starting" && (
        <div role="status" aria-label={t("ui.loading")} className="flex flex-col gap-3">
          <Skeleton className="h-9" />
          <Skeleton className="h-20" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      )}
      {flow.phase === "blocked" && <ErrorAlert>{t("review.blocked", { reason: flow.notice?.text || flow.notice?.code || "" })}</ErrorAlert>}
      {withForm && (
        <>
          <AskAi review={review} />
          {inReview && (
            <ReviewNotices
              flow={flow}
              movedSinceDraft={review.movedSinceDraft}
              failure={review.failure}
              onRedraft={review.askAi}
              onDismissMoved={review.dismissMoved}
              onBringBackAnyway={review.bringBackAnyway}
            />
          )}
          {/* The AI writes over the card: nothing in it changes until the draft arrives or fails. */}
          <fieldset disabled={review.aiBusy} aria-busy={review.aiBusy || undefined} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
            <div ref={form}>
              <CardForm card={flow.card} edit={review.edit} errors={errors} branchMessages={review.branchMessages} parentMessages={review.parentMessages} />
            </div>
            {review.notesOn && <NoteProposals rows={review.rows} onChange={review.setRows} notes={notes.data?.notes ?? []} />}
          </fieldset>
        </>
      )}
    </DialogContent>
  );
}

/**
 * Bring a branch back (A5; components.md w 760, full screen on phones;
 * F10 §4.1): the review opens at once with the question and conclusion
 * prefilled from the branch (or its ready AI draft), the AI draft on request
 * (cancellable, keeping the card if it fails) — every field editable, the
 * optional ones under a disclosure, evidence opens its original (part of which can be
 * quoted), what needs a decision, the note proposals (notes feature), "the
 * main line moved on" with redraft or bring back anyway. The main button
 * accepts everything; the second applies only the ticked note changes. A
 * card without a conclusion never goes back.
 */
export function BranchCardReview({ open, onOpenChange, ...rest }: BranchCardReviewProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <ReviewBody key={rest.lineId} {...rest} />}
    </Dialog>
  );
}
