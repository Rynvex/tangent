import { goalProposalOf, isFeatureOn, type Suggestion } from "@tangent/client";
import { Target } from "lucide-react";
import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { describeError } from "../conversation/error-text";
import { useJobFailure, useReadOnly } from "../data/live-hooks";
import { useSuggestions } from "../data/suggestion-query";
import { useGoal, useProposeGoal } from "../data/p2-hooks";
import { useCapabilities, useLine } from "../data/queries";
import { useP2T } from "../i18n/p2-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";
import { GoalEditor } from "./goal-editor";

/**
 * How long 讓 AI 提案 waits at most: a proposal (`suggestion.changed`), a
 * goal (auto, `goal.changed`) or `job.failed` normally ends it first; this
 * only covers a stream that was down meanwhile.
 */
const ASK_WAIT_MS = 60_000;

export interface GoalCapsuleProps {
  /** Any line of the tree; the goal is the tree's (pass the root). */
  rootLineId: string;
  /** Narrow headers: only the target icon (the goal stays one press away). */
  compact?: boolean;
  className?: string;
}

/**
 * The open `goal_propose` suggestion, newest first. Read only while the tree
 * has open suggestions or AI was just asked (no extra request otherwise);
 * `suggestion.changed` keeps it current.
 */
function useGoalProposal(rootLineId: string, asking: boolean): Suggestion | null {
  const capabilities = useCapabilities();
  const root = useLine(rootLineId);
  const enabled = isFeatureOn(capabilities.data, "suggestions") && (asking || (root.data?.openSuggestions ?? 0) > 0);
  const list = useSuggestions(rootLineId, enabled);
  const proposals = (list.data?.suggestions ?? []).filter((item) => item.status === "open" && goalProposalOf(item));
  return proposals.reduce<Suggestion | null>((newest, item) => (!newest || newest.createdAt < item.createdAt ? item : newest), null);
}

/**
 * 讓 AI 提案: asks, then waits until a proposal newer than the press (or, in
 * auto mode, a goal written after it) arrives, or the job fails
 * (`job.failed`, B9 phase C), or a minute passes.
 */
function useAsk(rootLineId: string) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const propose = useProposeGoal(rootLineId);
  const [asked, setAsked] = useState<{ at: string; jobId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failure = useJobFailure(asked?.jobId ?? null);
  useEffect(() => {
    if (!asked) return;
    const timer = setTimeout(() => setAsked(null), ASK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [asked]);
  useEffect(() => {
    if (!failure) return;
    setAsked(null);
    setError(t("goal.jobFailed", { reason: t(`job.error.${failure.error.code}`) }));
  }, [failure, t]);
  const ask = () => {
    setError(null);
    const at = new Date().toISOString();
    propose.mutateAsync().then(
      (job) => setAsked({ at, jobId: job.jobId }),
      (failed: unknown) => setError(t("goal.askFailed", { reason: describeError(failed, t, hostErrorText) })),
    );
  };
  return { askedAt: asked?.at ?? null, settle: () => setAsked(null), ask, error, pending: propose.isPending };
}

/**
 * The goal capsule (C4; handoff: the dashed capsule next to the path): the
 * goal in one line, or 設定目標. It opens the editor; an AI proposal only
 * marks the capsule — it never opens anything or takes focus. Rendered only
 * while the goal feature is on. Everything local (open, the edit's draft,
 * the wait for 讓 AI 提案) belongs to one conversation and starts over in
 * another (R9 G1).
 */
export function GoalCapsule(props: GoalCapsuleProps) {
  return <ConversationGoalCapsule key={props.rootLineId} {...props} />;
}

function ConversationGoalCapsule({ rootLineId, compact = false, className }: GoalCapsuleProps) {
  const t = useP2T();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const on = isFeatureOn(capabilities.data, "goal");
  const goal = useGoal(rootLineId, on);
  const asking = useAsk(rootLineId);
  const waiting = asking.askedAt !== null || asking.pending;
  const proposal = useGoalProposal(rootLineId, waiting);
  const current = goal.data?.goal ?? null;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // A proposal or a goal newer than the press ends the wait.
  const settled = asking.askedAt !== null && ((proposal && proposal.createdAt >= asking.askedAt) || (current && current.updatedAt >= asking.askedAt));
  useEffect(() => {
    if (settled) asking.settle();
  }, [settled, asking]);
  if (!on || !goal.isSuccess) return null;
  const name = current ? t("goal.capsule", { text: current.text }) : t("goal.set");
  const onOpenChange = (next: boolean, details: { reason: string }) => {
    // Esc while editing cancels the edit; the editor stays open (interactions: Esc steps back one level).
    if (!next && editing && details.reason === "escape-key") return setEditing(false);
    setOpen(next);
    if (!next) setEditing(false);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={name}
        title={current?.text}
        className={cx(
          "inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-tg-full border border-dashed border-tg-border-strong px-2.5 text-tg-xs text-tg-muted transition-colors duration-(--tg-duration-fast)",
          "hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring data-popup-open:bg-tg-accent pointer-coarse:h-11",
          compact ? "w-7 justify-center px-0 pointer-coarse:w-11" : "max-w-[min(22rem,32vw)]",
          className,
        )}
      >
        <Target aria-hidden className="size-3.5 shrink-0" />
        {!compact && <span className={cx("truncate", current && "text-tg-foreground")}>{current ? current.text : t("goal.set")}</span>}
        {proposal && (
          <span className="flex shrink-0 items-center">
            <span aria-hidden className="size-1.5 rounded-tg-full bg-tg-suggestion" />
            <span className="sr-only">{t("goal.proposalWaiting")}</span>
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent title={editing ? t("goal.editing") : t("goal.editorTitle")} aria-label={t("goal.editorTitle")}>
        <GoalEditor
          rootLineId={rootLineId}
          goal={current}
          proposal={proposal}
          readOnly={readOnly}
          editing={editing}
          onEditingChange={setEditing}
          asking={waiting && !settled}
          onAsk={asking.ask}
          askError={asking.error}
        />
      </PopoverContent>
    </Popover>
  );
}
