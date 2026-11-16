import { GOAL_TEXT_MAX, featureMode, goalLine, goalProposalOf, validateGoal, type Goal, type Suggestion } from "@tangent/client";
import { Sparkles } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Button } from "../components/button";
import { TextArea } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useCapabilities } from "../data/queries";
import { useAcceptSuggestion, useDismissSuggestion } from "../data/p1-hooks";
import { useDeleteGoal, usePutGoal } from "../data/p2-hooks";
import { useP2T } from "../i18n/p2-messages";
import { isComposing } from "../shortcuts/keys";
import { useTangent } from "../provider";

export interface GoalEditorProps {
  rootLineId: string;
  goal: Goal | null;
  /** The open AI proposal (`goal_propose`), if any. */
  proposal: Suggestion | null;
  readOnly: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** 讓 AI 提案: the capsule keeps asking state (it outlives the editor). */
  asking: boolean;
  onAsk: () => void;
  askError: string | null;
}

/** The goal's source: the user's, or an AI proposal (auto mode marks what AI wrote 「AI 做的」). */
function Source({ goal }: { goal: Goal }) {
  const t = useP2T();
  const capabilities = useCapabilities();
  const auto = featureMode(capabilities.data, "goal") === "auto";
  return (
    <p className="m-0 flex flex-wrap items-center gap-1.5 text-tg-xs text-tg-muted">
      <span>{goal.source === "ai" ? t("goal.sourceAi") : t("goal.sourceManual")}</span>
      {goal.source === "ai" && auto && <span className="rounded-tg-full bg-tg-suggestion-soft px-1.5 font-medium text-tg-suggestion">{t("goal.aiMade")}</span>}
      <span aria-hidden>·</span>
      <span>{t("goal.note")}</span>
    </p>
  );
}

/** An open AI proposal: dashed `--tg-suggestion`, adopted or dismissed with one press (never applied by itself). */
function Proposal({ rootLineId, proposal, readOnly }: { rootLineId: string; proposal: Suggestion; readOnly: boolean }) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const accept = useAcceptSuggestion(rootLineId);
  const dismiss = useDismissSuggestion(rootLineId);
  const [error, setError] = useState<string | null>(null);
  const text = goalProposalOf(proposal)?.text ?? "";
  const run = (write: () => Promise<unknown>) => {
    setError(null);
    void write().catch((failure: unknown) => setError(t("goal.failed", { reason: describeError(failure, t, hostErrorText) })));
  };
  const busy = accept.isPending || dismiss.isPending;
  return (
    <div className="flex flex-col gap-2 rounded-tg-sm border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-2.5 py-2">
      <p className="m-0 text-tg-sm break-words text-tg-foreground">
        <span className="font-semibold text-tg-suggestion">{t("goal.proposal")}</span>
        {text}
      </p>
      {!readOnly && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" loading={accept.isPending} disabled={busy && !accept.isPending} onClick={() => run(() => accept.mutateAsync({ suggestionId: proposal.id }))}>
            {t("goal.adopt")}
          </Button>
          <Button size="sm" variant="ghost" loading={dismiss.isPending} disabled={busy && !dismiss.isPending} onClick={() => run(() => dismiss.mutateAsync({ suggestionId: proposal.id }))}>
            {t("goal.dismiss")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The goal's one-line field: Enter saves, Esc (handled by the capsule) cancels; ≤ 300 characters. */
function GoalForm({ rootLineId, initial, onDone }: { rootLineId: string; initial: string; onDone: () => void }) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const put = usePutGoal(rootLineId);
  const [text, setText] = useState(initial);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = validateGoal(text);
  const length = Array.from(goalLine(text)).length;
  const shown = problem === "tooLong" || (tried && problem) ? (problem === "required" ? t("goal.required") : t("goal.tooLong", { limit: GOAL_TEXT_MAX })) : error;
  const save = () => {
    setTried(true);
    if (problem || put.isPending) return;
    setError(null);
    put.mutateAsync({ text: goalLine(text) }).then(onDone, (failure: unknown) => setError(t("goal.failed", { reason: describeError(failure, t, hostErrorText) })));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || isComposing(event)) return;
    event.preventDefault();
    save();
  };
  return (
    <div className="flex flex-col gap-2">
      <TextArea
        label={t("goal.field")}
        value={text}
        rows={2}
        autoFocus
        placeholder={t("goal.placeholder")}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        error={shown ?? undefined}
        description={t("goal.count", { count: length, limit: GOAL_TEXT_MAX })}
        inputClassName="text-tg-sm"
      />
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("goal.cancel")}
        </Button>
        <Button size="sm" variant="primary" loading={put.isPending} aria-disabled={problem === "tooLong" || undefined} onClick={save}>
          {t("goal.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The goal editor (C4, the capsule's popover): the whole goal, its source and
 * that it goes to AI every turn; edit, clear, ask AI for a proposal (any
 * mode — manual has only this button), and the open AI proposal to adopt.
 * A viewer only reads.
 */
export function GoalEditor({ rootLineId, goal, proposal, readOnly, editing, onEditingChange, asking, onAsk, askError }: GoalEditorProps) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const clear = useDeleteGoal(rootLineId);
  const [clearError, setClearError] = useState<string | null>(null);
  if (editing && !readOnly) return <GoalForm rootLineId={rootLineId} initial={goal?.text ?? ""} onDone={() => onEditingChange(false)} />;
  const onClear = () => {
    setClearError(null);
    clear.mutateAsync().catch((failure: unknown) => setClearError(t("goal.failed", { reason: describeError(failure, t, hostErrorText) })));
  };
  return (
    <div className="flex w-[min(26rem,calc(100vw-2rem))] flex-col gap-2.5">
      {goal ? <p className="m-0 text-tg-md leading-normal break-words text-tg-foreground">{goal.text}</p> : <p className="m-0 text-tg-sm text-tg-muted">{t("goal.none")}</p>}
      {goal && <Source goal={goal} />}
      {proposal && <Proposal rootLineId={rootLineId} proposal={proposal} readOnly={readOnly} />}
      {asking && !proposal && (
        <p role="status" className="m-0 text-tg-xs text-tg-muted">
          {t("goal.asking")}
        </p>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant={goal ? "secondary" : "primary"} onClick={() => onEditingChange(true)}>
            {goal ? t("goal.edit") : t("goal.write")}
          </Button>
          <Button size="sm" variant="ghost" icon={<Sparkles aria-hidden className="size-3" />} disabled={asking} onClick={onAsk}>
            {t("goal.ask")}
          </Button>
          {goal && (
            <Button size="sm" variant="ghost" loading={clear.isPending} onClick={onClear}>
              {t("goal.clear")}
            </Button>
          )}
        </div>
      )}
      {(askError ?? clearError) && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {askError ?? clearError}
        </p>
      )}
    </div>
  );
}
