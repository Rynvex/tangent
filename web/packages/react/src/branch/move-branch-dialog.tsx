import { useDialogT } from "../i18n/dialog-messages";
import {
  BRANCH_MOVE_MAX,
  BRANCH_PURPOSE_MAX,
  buildMoveInput,
  classifyOpenBranchError,
  describeBranchError,
  planMove,
  previewLine,
  validatePurpose,
  type LineView,
  type Message,
  type MovableBranchKind,
  type MoveBranchResult,
  type MoveProblem,
} from "@tangent/client";
import { PackageOpen } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { TextField } from "../components/text-field";
import { useMoveToBranch } from "../data/branch-mutations";
import type { DialogMessageKey } from "../i18n/dialog-messages";
import { useTangent } from "../provider";
import { ErrorAlert } from "./error-alert";
import { KindRadio } from "./kind-radio";

export interface MoveBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The line the messages leave. */
  line: LineView;
  messages: readonly Message[];
  /** The user message the move starts at; everything after it moves too. */
  startMessageId: string;
  onMoved: (result: MoveBranchResult) => void;
}

const PROBLEM_KEYS: Record<MoveProblem, DialogMessageKey> = {
  mustStartWithUser: "move.problem.mustStartWithUser",
  tooMany: "move.problem.tooMany",
  notDone: "move.problem.notDone",
  protectedMessage: "move.problem.protectedMessage",
  noAnchor: "move.problem.noAnchor",
  notFound: "move.problem.notFound",
};

const MOVE_KINDS: readonly MovableBranchKind[] = ["investigate", "alternative"];

function MoveBody({ line, messages, startMessageId, onOpenChange, onMoved }: Omit<MoveBranchDialogProps, "open">) {
  const t = useDialogT();
  const { hostErrorText } = useTangent();
  const move = useMoveToBranch(line.id);
  const plan = planMove(messages, startMessageId);
  const [purpose, setPurpose] = useState("");
  const [kind, setKind] = useState<MovableBranchKind>("investigate");
  const [showProblem, setShowProblem] = useState(false);
  const [confirmDeeper, setConfirmDeeper] = useState(false);
  const busy = line.status === "thinking";
  const purposeProblem = validatePurpose(purpose);
  const blocked = plan.problem !== null || busy;

  const submit = (deeper = confirmDeeper) => {
    setShowProblem(true);
    if (purposeProblem || blocked || move.isPending) return;
    const input = buildMoveInput({ purpose, count: plan.messages.length, kind, provider: "", mainProvider: line.provider, model: "" });
    move.mutate(deeper ? { ...input, confirmDeeper: true } : input, {
      onSuccess: (result) => {
        onOpenChange(false);
        onMoved(result);
      },
    });
  };
  const failure = move.error ? classifyOpenBranchError(move.error) : null;
  const purposeError = showProblem && purposeProblem === "required" ? t("branch.purposeRequired") : purposeProblem === "tooLong" ? t("branch.purposeTooLong", { limit: BRANCH_PURPOSE_MAX }) : null;

  return (
    <DialogContent
      width="md"
      title={
        <span className="inline-flex items-center gap-2">
          <PackageOpen aria-hidden className="size-4.5 text-tg-primary-text" />
          {t("move.title", { count: plan.messages.length })}
        </span>
      }
      description={t("move.description")}
      footer={
        <>
          <DialogClose render={<Button>{t("branch.cancel")}</Button>} />
          <Button variant="primary" loading={move.isPending} aria-disabled={blocked || undefined} onClick={() => submit()}>
            {t("move.submit")}
          </Button>
        </>
      }
    >
      {plan.problem && <ErrorAlert>{t(PROBLEM_KEYS[plan.problem], { max: BRANCH_MOVE_MAX })}</ErrorAlert>}
      {busy && <ErrorAlert tone="warning">{t("move.busy")}</ErrorAlert>}
      <ol tabIndex={0} className="m-0 flex max-h-55 list-none flex-col gap-0.5 overflow-auto rounded-tg-sm border border-tg-border bg-tg-surface-sunken p-1.5">
        {plan.messages.map((message) => (
          <li key={message.id} className="flex gap-2.5 px-2 py-1.5 text-tg-sm">
            <span className="w-10 shrink-0 font-tg-mono text-tg-xs text-tg-muted">{message.role === "user" ? t("move.role.user") : t("move.role.assistant")}</span>
            <span className="min-w-0 truncate">{previewLine(message)}</span>
          </li>
        ))}
      </ol>
      <TextField label={t("move.purposeLabel")} value={purpose} placeholder={t("move.purposePlaceholder")} error={purposeError} onChange={(event) => setPurpose(event.target.value)} />
      <KindRadio value={kind} onValueChange={setKind} kinds={MOVE_KINDS} />
      <p className="m-0 text-tg-xs text-tg-muted">{t("move.cost")}</p>
      {move.error && (
        <ErrorAlert tone={failure?.kind === "depth" ? "warning" : "destructive"}>
          <span>{describeBranchError(move.error, t, hostErrorText).message}</span>
          {failure?.kind === "depth" && (
            <Button
              size="sm"
              className="self-start"
              onClick={() => {
                setConfirmDeeper(true);
                submit(true);
              }}
            >
              {t("branch.depthConfirm")}
            </Button>
          )}
        </ErrorAlert>
      )}
    </DialogContent>
  );
}

/**
 * Move the last messages into a branch (A7): from one of the user's own
 * messages to the end. Shows what moves, why it cannot (a reply running, a
 * card or marker in the range, too many, nothing left to fork from), the
 * cost, and asks for the new branch's purpose and kind (never an aside).
 */
export function MoveBranchDialog({ open, onOpenChange, ...rest }: MoveBranchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <MoveBody key={rest.startMessageId} onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}
