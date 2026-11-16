import { useDialogT } from "../../i18n/dialog-messages";
import { describeBranchError, TangentError, type DraftFlowState, type ReturnFailure } from "@tangent/client";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/button";
import type { BundleTranslate } from "../../i18n/bundle";
import type { DialogMessageKey } from "../../i18n/dialog-messages";

type Translate = BundleTranslate<DialogMessageKey>;
import { useTangent } from "../../provider";
import { ErrorAlert } from "../error-alert";

/** Why the card is a blank one the user writes; null when nothing needs saying. */
export function noticeText(flow: DraftFlowState, t: Translate): string | null {
  const notice = flow.notice;
  if (!notice) return null;
  switch (notice.code) {
    case "draft_failed":
      return notice.text ? t("review.noticeFailed", { reason: notice.text }) : t("review.noticeFailedNoReason");
    case "draft_timeout":
      return t("review.noticeTimeout");
    case "no_messages":
      return t("review.noticeNoMessages");
    case "abandoned":
    case "feature_disabled":
      return null;
    default:
      return t("review.noticeStartFailed", { reason: notice.text || notice.code });
  }
}

function MovedNotice({ text, onRedraft, onAnyway }: { text: string; onRedraft: () => void; onAnyway: () => void }) {
  const t = useDialogT();
  return (
    <div role="status" className="flex flex-wrap items-center gap-2.5 rounded-tg-sm bg-tg-warning-soft px-3 py-2.5 text-tg-sm text-tg-foreground">
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-tg-warning" />
      <span className="flex-[1_1_16rem]">{text}</span>
      <Button size="sm" onClick={onRedraft}>
        {t("review.redraft")}
      </Button>
      <Button size="sm" variant="ghost" onClick={onAnyway}>
        {t("review.bringBackAnyway")}
      </Button>
    </div>
  );
}

function failureText(failure: ReturnFailure, error: unknown, t: Translate, describe: (error: unknown) => string): string {
  switch (failure.kind) {
    case "parent_busy":
      return t("review.errorParentBusy");
    case "invalid_parent_tip":
      return t("review.errorTip");
    case "payload_too_large":
      return t("review.errorTooLarge");
    case "invalid_card":
      return t("review.invalidCard");
    case "state":
      return describe(new TangentError(409, "", failure.code));
    case "other":
      return t("review.errorOther", { reason: failure.message || describe(error) });
    default:
      return "";
  }
}

export interface ReviewNoticesProps {
  flow: DraftFlowState;
  movedSinceDraft: number;
  failure: ReturnFailure | null;
  onRedraft: () => void;
  onDismissMoved: () => void;
  onBringBackAnyway: () => void;
}

/** What the review says above the form: why the card is blank, that the main line moved on, why bringing it back failed. */
export function ReviewNotices({ flow, movedSinceDraft, failure, onRedraft, onDismissMoved, onBringBackAnyway }: ReviewNoticesProps): ReactNode {
  const t = useDialogT();
  const { hostErrorText } = useTangent();
  const describe = (error: unknown) => describeBranchError(error, t, hostErrorText).message;
  const blank = noticeText(flow, t);
  return (
    <>
      {blank && <ErrorAlert>{blank}</ErrorAlert>}
      {movedSinceDraft > 0 && <MovedNotice text={t("review.mainMoved", { count: movedSinceDraft })} onRedraft={onRedraft} onAnyway={onDismissMoved} />}
      {failure?.kind === "parent_moved" && <MovedNotice text={t("review.mainMovedSend", { count: failure.movedMessages })} onRedraft={onRedraft} onAnyway={onBringBackAnyway} />}
      {failure && failure.kind !== "parent_moved" && <ErrorAlert>{failureText(failure, null, t, describe)}</ErrorAlert>}
    </>
  );
}
