import { BRANCH_PURPOSE_MAX, charCount, chatNumbers, flowPurpose, modelChoices, purposeHead, replyTurn, type LineView, type Message } from "@tangent/client";
import { useId, useState } from "react";
import { Button } from "../components/button";
import { Skeleton } from "../components/display";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { TextArea } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useCapabilities } from "../data/queries";
import { useF8T } from "../i18n/f8-messages";
import { useTangent } from "../provider";
import { useBranchAndSend } from "./branch-and-send";
import { modelKey, ModelOptions, type ModelChoice } from "./model-option";

/** Characters of the question in a re-ask's purpose (S7: 「重答（{model}）：{問題前 30 字}」). */
const QUESTION_HEAD = 30;

export interface RegenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  line: LineView;
  messages: readonly Message[];
  /** The finished reply to answer again. */
  replyId: string;
  /** The branch is open (and the question re-sent unless `sendError`): the host goes there. */
  onDone: (branchLineId: string, sendError?: string) => void;
  /** The question opened the line: ask it again in a new conversation instead (decision #3). */
  onAskAgain?: (question: Message) => void;
}

/** The models to offer: the server's allowed list, plus the reply's own model (disabled when not allowed); the line's model without a list. */
export function regenerateChoices(allowed: readonly { provider: string; model: string }[] | null, line: LineView, reply: Message | undefined, t: ReturnType<typeof useF8T>, replyLabel: string): ModelChoice[] {
  const used = { provider: reply?.meta.provider ?? line.provider, model: reply?.meta.model ?? line.model };
  const base: ModelChoice[] = allowed ? allowed.map((choice) => ({ ...choice })) : [{ provider: line.provider, model: line.model }];
  const known = base.some((choice) => modelKey(choice) === modelKey(used));
  const all = known || !used.model ? base : [...base, { ...used, disabled: true, note: t("model.notAllowed") }];
  return all.map((choice) => (modelKey(choice) === modelKey(used) ? { ...choice, note: choice.disabled ? `${replyLabel}・${choice.note ?? ""}` : replyLabel } : choice));
}

/**
 * 分岔重答（可換模型） (S7, components.md `RegenerateBranchDialog`): pick a
 * model; an alternative branch opens from the message before the turn's
 * question and the question is sent there again, so the AI sees it once.
 * The reply's own model is marked but not preselected (this is usually
 * about switching); a model the server does not allow is listed, disabled.
 */
export function RegenerateDialog({ open, onOpenChange, ...rest }: RegenerateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <RegenerateForm key={`${rest.line.id}:${rest.replyId}`} onOpenChange={onOpenChange} {...rest} />
    </Dialog>
  );
}

function RegenerateForm({ line, messages, replyId, onOpenChange, onDone, onAskAgain }: Omit<RegenerateDialogProps, "open">) {
  const t = useF8T();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const labelId = useId();
  const numbers = chatNumbers(messages);
  const reply = messages.find((message) => message.id === replyId);
  const turn = replyTurn(messages, replyId);
  const k = numbers.get(replyId) ?? "?";
  const choices = regenerateChoices(modelChoices(capabilities.data), line, reply, t, t("regen.usedHere", { k }));
  const enabled = choices.filter((choice) => !choice.disabled);
  // Nothing is picked for the user (S7: this is usually about switching), unless there is only one model to pick.
  const [chosen, setPicked] = useState<ModelChoice | null>(null);
  const picked = chosen ?? (capabilities.isSuccess && enabled.length === 1 ? enabled[0]! : null);
  const [purpose, setPurpose] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flow = useBranchAndSend(line.id);
  const question = turn?.question;
  const shownPurpose = purpose ?? (question && picked ? flowPurpose(t("regen.purposePrefix", { model: picked.model, text: purposeHead(question.content, QUESTION_HEAD) })) : "");
  const purposeOk = shownPurpose.trim() !== "" && charCount(shownPurpose.trim()) <= BRANCH_PURPOSE_MAX;
  const ready = Boolean(turn?.before && question && picked && purposeOk);
  const submit = () => {
    if (!ready || !turn?.before || !question || !picked || flow.pending) return;
    setError(null);
    const input = { anchorMessageId: turn.before.id, purpose: shownPurpose.trim(), kind: "alternative" as const, provider: picked.provider, model: picked.model };
    void flow.run(input, question.content).then((result) => {
      if ("created" in result) {
        onOpenChange(false);
        onDone(result.created.line.id);
        return;
      }
      const reason = describeError(result.failure.error, t, hostErrorText);
      if (result.failure.stage === "send") {
        onOpenChange(false);
        onDone(result.failure.created.line.id, t("edit.sendFailed", { reason }));
        return;
      }
      setError(t("edit.failed", { reason }));
    });
  };
  if (question && !turn?.before) {
    return (
      <DialogContent
        width="md"
        title={t("regen.title")}
        footer={
          <>
            <DialogClose render={<Button>{t("edit.cancel")}</Button>} />
            {onAskAgain && (
              <Button
                variant="primary"
                onClick={() => {
                  onOpenChange(false);
                  onAskAgain(question);
                }}
              >
                {t("edit.asNewConv")}
              </Button>
            )}
          </>
        }
      >
        <p className="m-0 text-tg-sm text-tg-foreground">{t("regen.firstExplain", { u: numbers.get(question.id) ?? "?" })}</p>
      </DialogContent>
    );
  }
  return (
    <DialogContent
      width="md"
      title={t("regen.title")}
      description={turn?.before && question ? t("regen.explain", { a: numbers.get(turn.before.id) ?? "?", u: numbers.get(question.id) ?? "?", k }) : undefined}
      footer={
        <>
          <DialogClose render={<Button>{t("edit.cancel")}</Button>} />
          <Button variant="primary" loading={flow.pending} aria-disabled={!ready || undefined} onClick={submit}>
            {t("regen.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <span id={labelId} className="text-tg-sm font-medium text-tg-foreground">
          {t("regen.model")}
        </span>
        {/* The allowed models come with the capabilities: no list (and no guess) before they are here. */}
        {capabilities.isPending ? <Skeleton className="h-21 w-full" /> : <ModelOptions labelledBy={labelId} choices={choices} selected={new Set(picked ? [modelKey(picked)] : [])} mode="radio" onToggle={setPicked} />}
        {enabled.length === 1 && <p className="m-0 text-tg-xs text-tg-muted">{t("regen.onlyOne")}</p>}
      </div>
      <TextArea label={t("edit.purpose")} rows={2} value={shownPurpose} onChange={(event) => setPurpose(event.target.value)} error={shownPurpose && !purposeOk ? t("seeds.tooLong", { max: BRANCH_PURPOSE_MAX }) : undefined} />
      {error && (
        <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-3 py-2 text-tg-sm text-tg-foreground">
          {error}
        </p>
      )}
    </DialogContent>
  );
}
