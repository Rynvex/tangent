import { LEAF_LINE_MAX, describeBranchError, discardLeafBody, isFeatureOn, validateLeafLine, type BranchView, type DiscardBranchResult } from "@tangent/client";
import { Ban } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { TextArea } from "../components/text-field";
import { useDiscardBranch } from "../data/branch-mutations";
import { useCapabilities } from "../data/queries";
import { useTangent } from "../provider";
import { useP1T } from "../i18n/p1-messages";
import { ErrorAlert } from "./error-alert";

export interface DiscardBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: BranchView;
  onDiscarded: (result: DiscardBranchResult) => void;
}

function DiscardBody({ branch, onOpenChange, onDiscarded }: Omit<DiscardBranchDialogProps, "open">) {
  const t = useP1T();
  const { hostErrorText } = useTangent();
  const discard = useDiscardBranch(branch.lineId);
  const capabilities = useCapabilities();
  // The reason becomes the dead-end leaf (B1), so it exists only with the leaf feature (off = not rendered, nothing sent).
  const leafOn = isFeatureOn(capabilities.data, "leaf");
  const [reason, setReason] = useState("");
  const tooLong = leafOn && validateLeafLine(reason) === "tooLong";
  const confirm = () => {
    if (tooLong || capabilities.isPending) return;
    discard.mutate(leafOn ? discardLeafBody(reason) : undefined, {
      onSuccess: (result) => {
        onOpenChange(false);
        onDiscarded(result);
      },
    });
  };
  return (
    <DialogContent
      width="md"
      title={t("discard.title")}
      description={t("discard.body")}
      footer={
        <>
          <DialogClose render={<Button>{t("branch.cancel")}</Button>} />
          <Button variant="primary" loading={discard.isPending} onClick={confirm}>
            {t("discard.confirm")}
          </Button>
        </>
      }
    >
      <p className="m-0 text-tg-sm font-medium text-tg-foreground-strong">{branch.purpose}</p>
      {leafOn && (
        <TextArea
          label={t("discard.reasonLabel")}
          rows={3}
          value={reason}
          placeholder={t("discard.reasonPlaceholder")}
          error={tooLong ? t("discard.reasonTooLong", { limit: LEAF_LINE_MAX }) : null}
          description={
            <span className="inline-flex items-center gap-1.5">
              <Ban aria-hidden className="size-3 text-tg-leaf-deadend" />
              {t("discard.reasonLeaf")}
            </span>
          }
          onChange={(event) => setReason(event.target.value)}
        />
      )}
      {discard.error && <ErrorAlert>{describeBranchError(discard.error, t, hostErrorText).message}</ErrorAlert>}
    </DialogContent>
  );
}

/**
 * Don't bring back (A6): the branch ends, stays greyed out in the outline and
 * the map, and the parent gets no card. With the leaf feature (B1) an
 * optional reason becomes the branch's dead-end leaf, in the same write; left
 * blank, suggest / auto modes draft a leaf instead.
 */
export function DiscardBranchDialog({ open, onOpenChange, ...rest }: DiscardBranchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <DiscardBody onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}
