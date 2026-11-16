import { consolidateSuggestionOf, driftOf, foldSuggestionOf, memorySuggestionOf, goalProposalOf, groupSuggestionOf, rebalanceOf, suggestedAction, relationSuggestionOf, suggestionReason, type RebalanceAction, type Suggestion, type SuggestionStatus } from "@tangent/client";
import { rebalanceReason } from "../branch/rebalance-hint";
import { Lightbulb } from "lucide-react";
import { Button } from "../components/button";
import type { P1MessageKey } from "../i18n/p1-messages";
import { cx } from "../lib/cx";
import { useP1T } from "../i18n/p1-messages";
import { useP2T, type P2MessageKey } from "../i18n/p2-messages";
import { useP3T } from "../i18n/p3-messages";
import { MEMORY_KIND_KEYS, useMemoryT } from "../i18n/memory-messages";
import { formatTokens } from "../components/usage-meter";
import { INBOX_CARD } from "./seed-card";

/** Kinds this package names; a newer server's kind shows as it is. */
const KIND_KEYS: Readonly<Record<string, P1MessageKey>> = {
  probe: "suggestions.kind.probe",
  probe_permanent: "suggestions.kind.probe_permanent",
  promote_or_spinoff: "suggestions.kind.promote_or_spinoff",
};

const DECIDED_KEYS: Readonly<Record<Exclude<SuggestionStatus, "open">, P1MessageKey>> = {
  accepted: "suggestions.accepted",
  dismissed: "suggestions.dismissed",
  expired: "suggestions.expired",
};

export interface SuggestionCardProps {
  suggestion: Suggestion;
  /** A tree-balance suggestion's action (升為主線 / 獨立): the host opens its confirmation (B4). 維持 is `onDismiss`. */
  onAction?: (action: RebalanceAction) => void;
  /** What it is about, as a name (the line's title). */
  target: string;
  readOnly?: boolean;
  onAccept?: () => void;
  onDismiss?: () => void;
  pending?: "accept" | "dismiss" | null;
  error?: string | null;
  /** A group suggestion (C2): the host opens the group / combine dialog (members, conflicts) in place of a blind accept. */
  onReview?: () => void;
}

/** B9's kinds (F5). */
const P2_KIND_KEYS: Readonly<Record<string, P2MessageKey>> = {
  goal_propose: "suggestions.kind.goal_propose",
  drift: "suggestions.kind.drift",
  relation: "suggestions.kind.relation",
  group: "suggestions.kind.group",
};

/** The kind's name: the package's text for a known kind, else the kind itself. */
export function useSuggestionKind(kind: string): string {
  const t = useP1T();
  const p2 = useP2T();
  const p3 = useP3T();
  const memory = useMemoryT();
  const key = KIND_KEYS[kind];
  const p2Key = P2_KIND_KEYS[kind];
  if (kind === "fold") return p3("suggestions.kind.fold");
  if (kind === "memory" || kind === "memory_consolidate") return memory(kind === "memory" ? "suggestions.kind.memory" : "suggestions.kind.memory_consolidate");
  return key ? t(key) : p2Key ? p2(p2Key) : kind;
}

/** What a B9 / B10 suggestion proposes, as text: a fold, the goal, the two related branches (and the label), a group, or why it drifted. */
function useP2Detail(suggestion: Suggestion): { text: string; note: string } | null {
  const t = useP2T();
  const p3 = useP3T();
  const m = useMemoryT();
  const remember = memorySuggestionOf(suggestion);
  if (remember) {
    const note = [m("suggestions.memoryNote", { kind: m(MEMORY_KIND_KEYS[remember.kind]), importance: remember.importance }), ...(remember.source.label ? [m("memory.source", { label: remember.source.label })] : [])].join("・");
    return { text: m(remember.action === "update" ? "suggestions.memoryUpdate" : "suggestions.memoryAdd", { text: remember.text }), note };
  }
  const consolidate = consolidateSuggestionOf(suggestion);
  if (consolidate) return { text: m(consolidate.action === "conflict" ? "suggestions.consolidateConflict" : "suggestions.consolidateMerge", { text: consolidate.text }), note: m("suggestions.consolidateFrom", { texts: consolidate.texts.join("／") }) };
  const fold = foldSuggestionOf(suggestion);
  if (fold) return { text: p3("suggestions.foldText", { title: fold.title, count: fold.messageCount, saved: formatTokens(fold.saved) }), note: fold.summary };
  const goal = goalProposalOf(suggestion);
  if (goal) return { text: t("suggestions.goalText", { text: goal.text }), note: "" };
  const group = groupSuggestionOf(suggestion);
  if (group) {
    const members = group.members.map((member) => t("suggestions.member", { title: member.purpose })).join(t("suggestions.memberJoin"));
    const text = suggestedAction(group) === "group" ? t("suggestions.groupText", { members, title: group.title }) : t("suggestions.combineText", { members });
    return { text, note: group.conflicts.length > 0 ? t("suggestions.groupConflicts", { count: group.conflicts.length }) : "" };
  }
  const relation = relationSuggestionOf(suggestion);
  if (relation) return { text: t("suggestions.relationText", { from: relation.fromTitle, to: relation.toTitle }), note: relation.label };
  const drift = driftOf(suggestion);
  return drift ? { text: drift.reason, note: "" } : null;
}

/**
 * One suggestion (B5; components.md SuggestionCard, dashed `--tg-suggestion`,
 * p 10): kind, what it is about, the reason, accept / dismiss while it waits;
 * accepted, dismissed and expired ones say so and offer nothing. Nothing is
 * ever carried out without the user's press.
 */
export function SuggestionCard({ suggestion, target, readOnly = false, onAccept, onDismiss, onAction, onReview, pending = null, error = null }: SuggestionCardProps) {
  const t = useP1T();
  const p2t = useP2T();
  const kind = useSuggestionKind(suggestion.kind);
  const rebalance = rebalanceOf(suggestion);
  const p2 = useP2Detail(suggestion);
  const reason = rebalance ? rebalanceReason(rebalance, t) : suggestionReason(suggestion);
  const open = suggestion.status === "open";
  const review = onReview && groupSuggestionOf(suggestion) ? onReview : undefined;
  return (
    <article
      aria-label={t("suggestions.label", { kind })}
      data-status={suggestion.status}
      className={cx(INBOX_CARD, "border border-dashed border-tg-suggestion bg-tg-suggestion-soft")}
    >
      <span className="inline-flex items-center gap-1.5 text-tg-xs font-semibold text-tg-suggestion">
        <Lightbulb aria-hidden className="size-3.25" />
        {kind}
      </span>
      <span className="text-tg-sm break-words text-tg-foreground">{t("suggestions.about", { target })}</span>
      {p2 ? (
        <>
          {p2.text && <span className="text-tg-sm break-words text-tg-foreground">{p2.text}</span>}
          {p2.note && <span className="text-tg-xs break-words text-tg-muted">{p2.note}</span>}
        </>
      ) : (
        reason && <span className="text-tg-xs break-words text-tg-muted">{reason}</span>
      )}
      {open && !readOnly && rebalance && (
        <div className="flex flex-wrap gap-1.5">
          {rebalance.actions.includes("promote") && onAction && (
            <Button size="sm" variant="primary" disabled={pending !== null} onClick={() => onAction("promote")}>
              {t("rebalance.promote")}
            </Button>
          )}
          {rebalance.actions.includes("spinoff") && onAction && (
            <Button size="sm" disabled={pending !== null} onClick={() => onAction("spinoff")}>
              {t("rebalance.spinoff")}
            </Button>
          )}
          {onDismiss && (
            <Button size="sm" variant="ghost" loading={pending === "dismiss"} title={t("rebalance.keepHelp")} onClick={onDismiss}>
              {t("rebalance.keep")}
            </Button>
          )}
        </div>
      )}
      {open && !readOnly && !rebalance && (onAccept || onDismiss || review) && (
        <div className="flex flex-wrap gap-1.5">
          {review ? (
            <Button size="sm" variant="primary" disabled={pending !== null} onClick={review}>
              {p2t("suggestions.review")}
            </Button>
          ) : (
            onAccept && (
              <Button size="sm" variant="primary" loading={pending === "accept"} disabled={pending === "dismiss"} onClick={onAccept}>
                {t("suggestions.accept")}
              </Button>
            )
          )}
          {onDismiss && (
            <Button size="sm" loading={pending === "dismiss"} disabled={pending === "accept"} onClick={onDismiss}>
              {t("suggestions.dismiss")}
            </Button>
          )}
        </div>
      )}
      {suggestion.status !== "open" && <span className="text-tg-xs font-medium text-tg-muted">{t(DECIDED_KEYS[suggestion.status])}</span>}
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
