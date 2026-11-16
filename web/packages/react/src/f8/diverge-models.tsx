import {
  DIVERGE_MODELS_COUNT,
  DIVERGE_PURPOSE_HEAD,
  divergeTargetPurpose,
  modelChoices,
  purposeHead,
  replyTurn,
  TangentError,
  type DivergeModelsInput,
  type Message,
} from "@tangent/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { DialogContent } from "../components/dialog";
import { TextArea, TextField } from "../components/text-field";
import { Working } from "../components/working";
import { describeError } from "../conversation/error-text";
import { useCapabilities } from "../data/queries";
import { useF8T } from "../i18n/f8-messages";
import { useTangent } from "../provider";
import { modelKey, ModelOptions, type ModelChoice } from "./model-option";

/** `POST /lines/{id}/diverge/models` (B14): all branches open or none; the outline and the parent follow. */
export function useDivergeModels(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: DivergeModelsInput) => client.divergeModels(lineId, input),
    onSuccess: (result) =>
      Promise.all([queryClient.invalidateQueries({ queryKey: keys.branchesOf(result.rootLineId) }), queryClient.invalidateQueries({ queryKey: keys.lineView(lineId) })]),
  });
}

/** The models a cross-model diverge may use: the server's allowed list (none listed: none to compare). */
export function useDivergeModelChoices(): ModelChoice[] {
  const capabilities = useCapabilities();
  return modelChoices(capabilities.data) ?? [];
}

export interface DivergeModelsPanelProps {
  lineId: string;
  /** The message the dialog opened on: a reply (its question is offered) or any finished chat message. */
  anchor: Message;
  /** The line's messages (the reply's question and the message before it). */
  messages: readonly Message[];
  /** The 「AI 提出幾個方向｜跨模型平行比較」 switch, shown first. */
  switcher: ReactNode;
  onClose: () => void;
}

/** The model the server refused (`422 model_not_allowed` names it), for the error line. */
function refusedModel(error: unknown): string | null {
  if (!(error instanceof TangentError) || error.code !== "model_not_allowed") return null;
  const model = error.extra.model;
  return typeof model === "string" && model ? model : "?";
}

/**
 * 跨模型平行比較 (S8, decision #4): pick 2–5 allowed models; one alternative
 * branch per model opens at once (all or none). The question starts as the
 * reply's question; each target gets its own purpose here — "{purpose} ·
 * {model}", cut so the model's name stays — never the AI's answer. With
 * 「建好後在每條支線送出這個問題」 the unchanged question forks from before it
 * (so it is not asked twice) and is sent in each branch, one paid turn each.
 */
export function DivergeModelsPanel({ lineId, anchor, messages, switcher, onClose }: DivergeModelsPanelProps) {
  const t = useF8T();
  const { client, keys, hostErrorText } = useTangent();
  const queryClient = useQueryClient();
  const labelId = useId();
  const choices = useDivergeModelChoices();
  const diverge = useDivergeModels(lineId);
  const turn = anchor.role === "assistant" ? replyTurn(messages, anchor.id) : null;
  const original = turn?.question.content ?? "";
  const [question, setQuestion] = useState(original);
  const [shared, setShared] = useState("");
  const [picked, setPicked] = useState<readonly ModelChoice[]>([]);
  // Without a message before the question, sending it again would ask it twice: off by default then (decision #4).
  const [sendEach, setSendEach] = useState(turn?.before != null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the branches are open they stay: a retry only sends again where sending failed, never opens a second set.
  const [opened, setOpened] = useState<{ lineIds: string[]; unsent: string[] } | null>(null);
  const prefix = shared.trim() || purposeHead(question || anchor.content, DIVERGE_PURPOSE_HEAD);
  const count = picked.length;
  const countOk = count >= DIVERGE_MODELS_COUNT.min && count <= DIVERGE_MODELS_COUNT.max;
  const willSend = sendEach && question.trim() !== "";
  const toggle = (choice: ModelChoice) =>
    setPicked((current) => (current.some((item) => modelKey(item) === modelKey(choice)) ? current.filter((item) => modelKey(item) !== modelKey(choice)) : current.length >= DIVERGE_MODELS_COUNT.max ? current : [...current, choice]));
  /** Sends the question in each branch, one after the other (each is a paid turn of its own model); returns where it failed. */
  const sendIn = async (lineIds: readonly string[]): Promise<string[]> => {
    setSending(true);
    const unsent: string[] = [];
    let reason = "";
    for (const lineId of lineIds) {
      try {
        await client.sendMessage(lineId, { content: question.trim() });
      } catch (failure) {
        unsent.push(lineId);
        reason ||= describeError(failure, t, hostErrorText);
      } finally {
        void queryClient.invalidateQueries({ queryKey: keys.line(lineId) });
      }
    }
    setSending(false);
    if (unsent.length > 0) setError(t("diverge.sendFailed", { n: unsent.length, reason }));
    return unsent;
  };
  const submit = async () => {
    if (diverge.isPending || sending) return;
    setError(null);
    if (opened) {
      const unsent = await sendIn(opened.unsent);
      if (unsent.length === 0) onClose();
      else setOpened({ ...opened, unsent });
      return;
    }
    if (!countOk) return;
    // The unchanged question forks from before it; a new question (or none sent) from the message itself.
    const anchorMessageId = willSend && turn?.before && question.trim() === original.trim() ? turn.before.id : anchor.id;
    const targets = picked.map((choice) => ({ provider: choice.provider, model: choice.model, purpose: divergeTargetPurpose(prefix, choice.model) }));
    let result;
    try {
      result = await diverge.mutateAsync({ anchorMessageId, ...(shared.trim() ? { purpose: shared.trim() } : {}), targets });
    } catch (failure) {
      const model = refusedModel(failure);
      setError(model ? t("diverge.modelRefused", { model }) : t("diverge.modelsFailed", { reason: describeError(failure, t, hostErrorText) }));
      return;
    }
    if (!willSend) return onClose();
    const lineIds = result.branches.map((branch) => branch.line.id);
    const unsent = await sendIn(lineIds);
    if (unsent.length === 0) onClose();
    else setOpened({ lineIds, unsent });
  };
  return (
    <DialogContent
      width="lg"
      title={t("diverge.modeModels")}
      description={t("diverge.modelsDescription")}
      footer={
        <>
          <Button variant="ghost" aria-disabled={sending || undefined} onClick={() => !sending && onClose()}>
            {t("edit.cancel")}
          </Button>
          <Button variant="primary" loading={diverge.isPending || sending} aria-disabled={(!opened && !countOk) || undefined} onClick={() => void submit()}>
            {opened ? t("diverge.resend", { n: opened.unsent.length }) : t("diverge.submitModels", { n: count })}
          </Button>
        </>
      }
    >
      {switcher}
      <TextArea label={t("diverge.question")} rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} />
      <TextField label={t("diverge.sharedPurpose")} value={shared} placeholder={purposeHead(question || anchor.content, DIVERGE_PURPOSE_HEAD)} onChange={(event) => setShared(event.target.value)} />
      <div className="flex flex-col gap-1.5">
        <span className="flex flex-wrap items-baseline justify-between gap-2">
          <span id={labelId} className="text-tg-sm font-medium text-tg-foreground">
            {t("diverge.models")}
          </span>
          <span className={count > 0 && !countOk ? "text-tg-xs text-tg-destructive" : "text-tg-xs text-tg-muted"}>{t("diverge.pickModels", { n: count })}</span>
        </span>
        <ModelOptions
          labelledBy={labelId}
          choices={choices}
          selected={new Set(picked.map(modelKey))}
          mode="checkbox"
          onToggle={toggle}
          detail={(choice) => (picked.some((item) => modelKey(item) === modelKey(choice)) ? t("diverge.branchPurpose", { purpose: divergeTargetPurpose(prefix, choice.model) }) : null)}
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <Checkbox checked={sendEach} onCheckedChange={setSendEach}>
          {t("diverge.sendEach")}
        </Checkbox>
        {sendEach && <span className="pl-6 text-tg-xs text-tg-warning">{t("diverge.sendCost", { n: Math.max(count, DIVERGE_MODELS_COUNT.min) })}</span>}
      </div>
      {sending && (
        <p role="status" className="m-0 text-tg-sm">
          <Working>{t("diverge.sending")}</Working>
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-3 py-2 text-tg-sm text-tg-foreground">
          {error}
        </p>
      )}
    </DialogContent>
  );
}
