import { useDialogT } from "../i18n/dialog-messages";
import { blockingBranches, branchTitle, describeBranchError, promotePlan, type BranchView, type Message, type PromoteBranchResult, type PromotePlan } from "@tangent/client";
import { useId, useRef, type ReactNode } from "react";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { usePromoteBranch } from "../data/branch-mutations";
import { useAcceptRebalance } from "../data/p1-hooks";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";
import { ErrorAlert } from "./error-alert";

export interface PromoteBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An open branch directly on the main line. */
  branch: BranchView;
  /** The main line's messages (the before / after picture). */
  mainMessages: readonly Message[];
  /** The tree's outline (what blocks the promotion, what moves up). */
  branches: readonly BranchView[];
  onPromoted: (result: PromoteBranchResult) => void;
  /** Opens a blocking branch so the user can end it. */
  onOpenBranch?: (lineId: string) => void;
  /** Accepting a tree-balance suggestion (B4): promotes through `POST /suggestions/{id}/accept`. */
  suggestionId?: string;
}

function Chip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "branch" | "previous" }) {
  return (
    <span
      className={cx(
        "rounded-tg-sm px-2 py-0.75 whitespace-nowrap",
        tone === "plain" && "bg-tg-accent text-tg-foreground",
        tone === "branch" && "border border-tg-primary text-tg-primary-text",
        tone === "previous" && "border border-dashed border-tg-border-strong text-tg-muted",
      )}
    >
      {children}
    </span>
  );
}

const Arrow = () => <span aria-hidden>→</span>;

function Figure({ caption, emphasis, children }: { caption: string; emphasis?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <figure aria-labelledby={id} className={cx("m-0 flex flex-col gap-2 rounded-tg p-3", emphasis ? "border-2 border-tg-branch-promoted" : "border border-tg-border")}>
      <figcaption id={id} className={cx("text-tg-xs", emphasis ? "text-tg-branch-promoted" : "text-tg-muted")}>
        {caption}
      </figcaption>
      {children}
    </figure>
  );
}

function Diagram({ plan }: { plan: PromotePlan }) {
  const t = useDialogT();
  const anchor = plan.anchorNumber ?? 0;
  const lastTail = plan.firstTailNumber === null ? null : plan.firstTailNumber + plan.tailCount - 1;
  const row = "flex flex-wrap items-center gap-1 text-tg-xs";
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(12.5rem,1fr))] gap-3">
      <Figure caption={t("promote.now")}>
        <div className={row}>
          {anchor > 1 && (
            <>
              <Chip>{anchor > 2 ? t("promote.mainRange", { n: anchor - 1 }) : t("promote.mainOne")}</Chip>
              <Arrow />
            </>
          )}
          <Chip>{t("promote.forkPoint", { n: anchor })}</Chip>
          {plan.firstTailNumber !== null && lastTail !== null && (
            <>
              <Arrow />
              <Chip>{lastTail > plan.firstTailNumber ? t("promote.tail", { from: plan.firstTailNumber, to: lastTail }) : t("promote.message", { n: plan.firstTailNumber })}</Chip>
            </>
          )}
        </div>
        <div className={cx(row, "pl-6 text-tg-primary-text")}>
          <span aria-hidden>↳</span>
          <Chip tone="branch">{t("promote.branch", { count: plan.branchMessages })}</Chip>
        </div>
      </Figure>
      <Figure caption={t("promote.after")} emphasis>
        <div className={row}>
          {anchor > 1 && (
            <>
              <Chip>{anchor > 2 ? t("promote.mainRange", { n: anchor - 1 }) : t("promote.mainOne")}</Chip>
              <Arrow />
            </>
          )}
          <Chip>{t("promote.message", { n: anchor })}</Chip>
          <Arrow />
          <Chip tone="branch">{t("promote.branchAfter", { count: plan.branchMessages })}</Chip>
        </div>
        <div className={cx(row, "pl-6 text-tg-subtle")}>
          <span aria-hidden>↳</span>
          {plan.firstTailNumber === null ? <span>{t("promote.noTail")}</span> : <Chip tone="previous">{t("promote.previous", { n: plan.firstTailNumber })}</Chip>}
        </div>
      </Figure>
    </div>
  );
}

function BranchLinks({ branches, onOpenBranch }: { branches: readonly BranchView[]; onOpenBranch: PromoteBranchDialogProps["onOpenBranch"] }) {
  const t = useDialogT();
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {branches.map((branch) => (
        <li key={branch.lineId}>
          {onOpenBranch ? (
            <button type="button" onClick={() => onOpenBranch(branch.lineId)} className="max-w-full truncate text-left text-tg-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
              {branchTitle(branch, t)}
            </button>
          ) : (
            branchTitle(branch, t)
          )}
        </li>
      ))}
    </ul>
  );
}

function PromoteBody({ branch, mainMessages, branches, onOpenChange, onPromoted, onOpenBranch, suggestionId }: Omit<PromoteBranchDialogProps, "open">) {
  const t = useDialogT();
  const { hostErrorText } = useTangent();
  const direct = usePromoteBranch(branch.lineId);
  const accept = useAcceptRebalance(branch.rootLineId);
  const promote = suggestionId ? accept : direct;
  const cancel = useRef<HTMLButtonElement>(null);
  const plan = promotePlan(branch, mainMessages, branches);
  const named = blockingBranches(promote.error, branches);
  const done = (result: PromoteBranchResult) => {
    onOpenChange(false);
    onPromoted(result);
  };
  const confirm = () => {
    if (!suggestionId) return direct.mutate(undefined, { onSuccess: done });
    accept.mutate(
      { suggestionId, body: { action: "promote" } },
      {
        onSuccess: ({ result }) => {
          if (result?.branch && result.previousMainLine) done({ branch: result.branch, previousMainLine: result.previousMainLine, line: result.line, reparented: [] });
        },
      },
    );
  };
  return (
    <DialogContent
      width="lg"
      title={t("promote.title")}
      initialFocus={cancel}
      footer={
        <>
          <DialogClose render={<Button ref={cancel}>{t("branch.cancel")}</Button>} />
          <Button variant="primary" loading={promote.isPending} onClick={confirm}>
            {t("promote.confirm")}
          </Button>
        </>
      }
    >
      <Diagram plan={plan} />
      <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-tg-sm text-tg-foreground">
        <li>{t("promote.line1")}</li>
        <li>
          {plan.blockers.length === 0 ? t("promote.line2None") : t("promote.line2Some", { count: plan.blockers.length })}
          {plan.blockers.length > 0 && <BranchLinks branches={plan.blockers} onOpenBranch={onOpenBranch} />}
        </li>
        <li>{plan.lifted.length === 0 ? t("promote.line3None") : t("promote.line3", { count: plan.lifted.length })}</li>
        <li>{t("promote.line4")}</li>
      </ul>
      {promote.error && (
        <ErrorAlert>
          <span>{describeBranchError(promote.error, t, hostErrorText).message}</span>
          {named.length > 0 && (
            <>
              <span>{t("promote.blockers")}</span>
              <BranchLinks branches={named} onOpenBranch={onOpenBranch} />
            </>
          )}
        </ErrorAlert>
      )}
    </DialogContent>
  );
}

/**
 * Make a branch the main line (A6): a before / after picture, what happens
 * to the main line after the fork point (a grey "previous main line"
 * branch), which open branches block it (with links), which branches move
 * up, and the server's refusals (`open_branches_on_old_tail` lists the
 * blocking branches). Focus starts on Cancel.
 */
export function PromoteBranchDialog({ open, onOpenChange, ...rest }: PromoteBranchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <PromoteBody onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}
