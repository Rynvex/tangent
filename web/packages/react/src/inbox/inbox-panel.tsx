import {
  SEED_OPEN_MAX,
  branchTitle,
  isFeatureOn,
  seedLimitState,
  seedOrigin,
  type BranchView,
  type LoadedLine,
  type RebalanceAction,
  type Seed,
  type Suggestion,
} from "@tangent/client";
import { ArrowRight, Inbox, SquareParking } from "lucide-react";
import { useState } from "react";
import { KIND_KEYS } from "../conversation/branch-suggestions";
import { describeError } from "../conversation/error-text";
import { useReadOnly } from "../data/live-hooks";
import {
  useAcceptSuggestion,
  useDecidedSeeds,
  useDecidedSuggestions,
  useDismissSuggestion,
  useDropSeed,
  useNoteSeed,
  useSeeds,
  useSuggestions,
  type Decided,
} from "../data/p1-hooks";
import { useBranches, useCapabilities, useMessages } from "../data/queries";
import type { BundleTranslate } from "../i18n/bundle";
import { useTangent } from "../provider";
import { useP1T, type P1MessageKey } from "../i18n/p1-messages";
import { useP2T } from "../i18n/p2-messages";

type Translate = BundleTranslate<P1MessageKey>;
import { ListState, Section } from "./inbox-section";
import { SeedCard, type SeedSource } from "./seed-card";
import { StaleSection } from "./stale-section";
import { ArgReviewCard } from "../f8/arg-review-card";
import { SuggestionCard } from "./suggestion-card";
import { DismissAllButton, DismissedRow, InboxFilterChips, readInboxFilter, saveInboxFilter, useDismissAll, type InboxFilter } from "./inbox-filter";
import { useF12T } from "../i18n/f12-messages";

export interface InboxPanelProps {
  rootLineId: string;
  /** The line on screen: its messages name a seed parked on a branch. */
  lineId: string;
  /** Expanding a seed: the host opens the branch dialog prefilled with it (origin seed). */
  onExpandSeed: (seed: Seed) => void;
  /** F10 §4.2 直接問: expand the seed and ask its text in the new branch (the host goes there); a refusal shows on the card. */
  onAskSeed?: (seed: Seed) => Promise<unknown>;
  /** Goes to a seed's message, or to the branch a seed became. */
  onGoTo: (lineId: string, messageId?: string) => void;
  /** A tree-balance suggestion's 升為主線 / 獨立: the host opens the confirmation (B4); without it they are not offered. */
  onRebalance?: (suggestion: Suggestion, action: RebalanceAction) => void;
  /** A stale branch's 繼續 (B9 open_loops): go there. */
  onContinueBranch?: (lineId: string) => void;
  /** A stale branch's 結束並帶回: the host starts the conclusion card. */
  onEndBranch?: (lineId: string) => void;
  /** 回顧所有未完成的事 at the bottom (C5); offered while open_loops is on. */
  onReview?: () => void;
  /** A group suggestion's 檢視… (C2): the host opens the group / combine dialog; without it, a plain accept. */
  onGroupSuggestion?: (suggestion: Suggestion) => void;
}

/** The open items, then the ones decided on this page since the panel opened (newest first). */
function withDecided<T extends { id: string }>(open: readonly T[], decided: readonly Decided<T>[], since: number): T[] {
  const recent = decided.filter((entry) => entry.at >= since).map((entry) => entry.item);
  const ids = new Set(recent.map((item) => item.id));
  return [...open.filter((item) => !ids.has(item.id)), ...recent];
}

function lineLabel(lineId: string, rootLineId: string, branches: readonly BranchView[], t: Translate): string {
  if (lineId === rootLineId) return t("breadcrumb.main");
  const branch = branches.find((item) => item.lineId === lineId);
  return branch ? t("notes.sourceBranch", { kind: t(KIND_KEYS[branch.kind]), title: branchTitle(branch, t) }) : t("parking.fromElsewhere");
}

/**
 * Where a seed was parked: the label the server stored then, linked to the
 * line its message is on now (B8.1); an older server's seed is looked up
 * among the loaded lines instead.
 */
function sourceOf(seed: Seed, rootLineId: string, lines: readonly LoadedLine[], branches: readonly BranchView[], t: Translate): SeedSource {
  const fallback = fallbackSource(seed, rootLineId, lines, branches, t);
  if (!seed.anchorLineId) return seed.sourceLabel && seed.anchorMessageId ? { label: seed.sourceLabel, lineId: null } : fallback;
  return { label: seed.sourceLabel || fallback.label, lineId: seed.anchorLineId, messageId: seed.anchorMessageId };
}

function fallbackSource(seed: Seed, rootLineId: string, lines: readonly LoadedLine[], branches: readonly BranchView[], t: Translate): SeedSource {
  const origin = seedOrigin(seed, rootLineId, lines);
  switch (origin.kind) {
    case "main":
      return { label: t("notes.sourceMain", { n: origin.n }), lineId: origin.lineId, messageId: origin.messageId };
    case "branch": {
      const branch = branches.find((item) => item.lineId === origin.lineId);
      return { label: t("parking.fromBranch", { title: branch ? branchTitle(branch, t) : t("parking.fromElsewhere"), n: origin.n }), lineId: origin.lineId, messageId: origin.messageId };
    }
    case "unknown":
      return { label: t("parking.fromElsewhere"), lineId: null };
    default:
      return { label: t("parking.fromNothing"), lineId: null };
  }
}

const without = <T,>(record: Readonly<Record<string, T>>, id: string): Readonly<Record<string, T>> => {
  const { [id]: _gone, ...rest } = record;
  return rest;
};

/**
 * Which items are being written and why each one's last write failed, keyed
 * by item (R7 D1). Each write awaits its own promise (`mutateAsync`): a
 * shared mutation's per-call callbacks only fire for its latest call, so two
 * cards acting at once would lose the first one's result.
 */
function useItemStates<A extends string>() {
  const [pending, setPending] = useState<Readonly<Record<string, A>>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  return {
    pendingFor: (id: string): A | null => pending[id] ?? null,
    errorFor: (id: string): string | null => errors[id] ?? null,
    run: (id: string, action: A, write: () => Promise<unknown>, failed: (error: unknown) => string): void => {
      setPending((current) => ({ ...current, [id]: action }));
      setErrors((current) => without(current, id));
      void write()
        .catch((error: unknown) => setErrors((current) => ({ ...current, [id]: failed(error) })))
        .finally(() => setPending((current) => without(current, id)));
    },
  };
}

function ParkingSection({ rootLineId, lineId, notesOn, readOnly, since, onExpandSeed, onAskSeed, onGoTo, branches, filtered }: InboxPanelProps & { notesOn: boolean; readOnly: boolean; since: number; branches: readonly BranchView[]; filtered: boolean }) {
  const t = useP1T();
  const f12 = useF12T();
  const { hostErrorText } = useTangent();
  const seeds = useSeeds(rootLineId);
  const decided = useDecidedSeeds(rootLineId);
  const main = useMessages(rootLineId);
  const current = useMessages(lineId === rootLineId ? null : lineId);
  const note = useNoteSeed(rootLineId);
  const drop = useDropSeed(rootLineId);
  const states = useItemStates<"note" | "drop" | "ask">();
  const open = seeds.data?.seeds ?? [];
  const items = withDecided(open, decided, since);
  const lines: LoadedLine[] = [
    { lineId: rootLineId, messages: main.data?.messages ?? [] },
    ...(lineId !== rootLineId ? [{ lineId, messages: current.data?.messages ?? [] }] : []),
  ];
  const maxOpen = seeds.data?.limits.maxOpen ?? SEED_OPEN_MAX;
  const limit = seedLimitState(open.length, maxOpen);
  const failed = (error: unknown) => t("parking.actionFailed", { reason: describeError(error, t, hostErrorText) });
  return (
    <Section icon={<SquareParking aria-hidden className="size-3.25" />} title={t("parking.title")} count={t("parking.count", { count: open.length })}>
      {limit !== "ok" && (
        <p role="status" className="m-0 rounded-tg-sm bg-tg-warning-soft px-2.5 py-1.5 text-tg-xs text-tg-foreground">
          {limit === "full" ? t("error.seedLimit", { limit: maxOpen }) : t("parking.near", { count: open.length, limit: maxOpen })}
        </p>
      )}
      <ListState query={{ isPending: seeds.isPending, isError: seeds.isError, refetch: seeds.refetch, items }} empty={filtered ? f12("inbox.noSeeds") : t("parking.empty")}>
        {items.map((seed) => (
          <SeedCard
            key={seed.id}
            seed={seed}
            source={sourceOf(seed, rootLineId, lines, branches, t)}
            readOnly={readOnly}
            onExpand={() => onExpandSeed(seed)}
            {...(onAskSeed ? { onAsk: () => states.run(seed.id, "ask", () => onAskSeed(seed), failed) } : {})}
            {...(notesOn ? { onNote: () => states.run(seed.id, "note", () => note.mutateAsync({ seedId: seed.id }), failed) } : {})}
            onDrop={() => states.run(seed.id, "drop", () => drop.mutateAsync({ seedId: seed.id }), failed)}
            onGoTo={onGoTo}
            pending={states.pendingFor(seed.id)}
            error={states.errorFor(seed.id)}
          />
        ))}
      </ListState>
    </Section>
  );
}

function SuggestionsSection({
  rootLineId,
  readOnly,
  since,
  branches,
  onRebalance,
  onGroupSuggestion,
  filtered,
}: {
  filtered: boolean;
  rootLineId: string;
  readOnly: boolean;
  since: number;
  branches: readonly BranchView[];
  onRebalance: InboxPanelProps["onRebalance"];
  onGroupSuggestion: InboxPanelProps["onGroupSuggestion"];
}) {
  const t = useP1T();
  const f12 = useF12T();
  const { hostErrorText } = useTangent();
  const list = useSuggestions(rootLineId);
  const bulk = useDismissAll(rootLineId);
  const decided = useDecidedSuggestions(rootLineId);
  const accept = useAcceptSuggestion(rootLineId);
  const dismiss = useDismissSuggestion(rootLineId);
  const states = useItemStates<"accept" | "dismiss">();
  const open = list.data?.suggestions ?? [];
  const items: Suggestion[] = withDecided(open, decided, since).filter((item) => !bulk.hides(item));
  const failed = (error: unknown) => t("suggestions.failed", { reason: describeError(error, t, hostErrorText) });
  // F12 S5: 忽略全部 only while some are open (never for viewers); its result row takes the list's place for 5 s.
  const action = !readOnly && open.length > 0 ? <DismissAllButton count={open.length} pending={bulk.pending} onClick={bulk.run} /> : undefined;
  return (
    <Section icon={<Inbox aria-hidden className="size-3.25" />} title={t("suggestions.title")} count={t("suggestions.count", { count: open.length })} action={action}>
      {bulk.error && (
        <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-2.5 py-1.5 text-tg-xs text-tg-foreground">
          {bulk.error}
        </p>
      )}
      {/* The row sits above the list: suggestions that arrive meanwhile show under it; alone, it stands for the emptied list. */}
      {bulk.dismissedCount !== null && <DismissedRow count={bulk.dismissedCount} />}
      {(bulk.dismissedCount === null || items.length > 0) && (
      <ListState query={{ isPending: list.isPending, isError: list.isError, refetch: list.refetch, items }} empty={filtered ? f12("inbox.noSuggestions") : t("suggestions.empty")}>
        {items.map((suggestion) => (
          <SuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            target={lineLabel(suggestion.lineId, rootLineId, branches, t)}
            readOnly={readOnly}
            onAccept={() => states.run(suggestion.id, "accept", () => accept.mutateAsync({ suggestionId: suggestion.id }), failed)}
            onDismiss={() => states.run(suggestion.id, "dismiss", () => dismiss.mutateAsync({ suggestionId: suggestion.id }), failed)}
            {...(onRebalance ? { onAction: (action: RebalanceAction) => onRebalance(suggestion, action) } : {})}
            {...(onGroupSuggestion ? { onReview: () => onGroupSuggestion(suggestion) } : {})}
            pending={states.pendingFor(suggestion.id)}
            error={states.errorFor(suggestion.id)}
          />
        ))}
      </ListState>
      )}
    </Section>
  );
}

/**
 * The side panel's 待處理 (B3 + B5, B9): branches open too long, the parking
 * lot and the suggestion inbox, each only while its feature is on, and the
 * way to the review (C5) at the bottom.
 * Seeds can be expanded (the host's branch dialog), saved to the notes or
 * dropped; suggestions accepted or dismissed. What was decided here stays,
 * marked, until the panel closes. A viewer sees everything and changes nothing.
 */
export function InboxPanel(props: InboxPanelProps) {
  const t = useP2T();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const branches = useBranches(props.rootLineId, true);
  const [since] = useState(() => Date.now());
  const parkingOn = isFeatureOn(capabilities.data, "parking");
  const suggestionsOn = isFeatureOn(capabilities.data, "suggestions");
  const loopsOn = isFeatureOn(capabilities.data, "open_loops");
  const outline = branches.data?.branches ?? [];
  // F12 S5: the filter (kept for this visit, back to 全部 in another conversation); offered when both lists are on.
  const [filter, setFilterState] = useState<InboxFilter>(() => readInboxFilter(props.rootLineId));
  const [filterRoot, setFilterRoot] = useState(props.rootLineId);
  if (filterRoot !== props.rootLineId) {
    setFilterRoot(props.rootLineId);
    setFilterState(readInboxFilter(props.rootLineId));
  }
  const setFilter = (next: InboxFilter) => {
    setFilterState(next);
    saveInboxFilter(props.rootLineId, next);
  };
  const seedCount = useSeeds(parkingOn ? props.rootLineId : null).data?.seeds.length ?? 0;
  const suggestionCount = useSuggestions(suggestionsOn ? props.rootLineId : null).data?.suggestions.length ?? 0;
  const chipsOn = parkingOn && suggestionsOn;
  const shown = chipsOn ? filter : "all";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-3">
        {chipsOn && <InboxFilterChips value={filter} onValueChange={setFilter} seeds={seedCount} suggestions={suggestionCount} />}
        {/* F8 S2: one press clears AI's draft types, so it comes first. */}
        {shown === "all" && <ArgReviewCard key={props.rootLineId} rootLineId={props.rootLineId} lineId={props.lineId} onGoTo={props.onGoTo} />}
        {loopsOn && shown === "all" && <StaleSection rootLineId={props.rootLineId} readOnly={readOnly} onContinue={props.onContinueBranch} onEnd={props.onEndBranch} />}
        {parkingOn && shown !== "suggestions" && <ParkingSection {...props} notesOn={isFeatureOn(capabilities.data, "notes")} readOnly={readOnly} since={since} branches={outline} filtered={shown === "seeds"} />}
        {suggestionsOn && shown !== "seeds" && (
          <SuggestionsSection key={props.rootLineId} rootLineId={props.rootLineId} readOnly={readOnly} since={since} branches={outline} onRebalance={props.onRebalance} onGroupSuggestion={props.onGroupSuggestion} filtered={shown === "suggestions"} />
        )}
      </div>
      {loopsOn && props.onReview && (
        <button
          type="button"
          onClick={props.onReview}
          className="flex shrink-0 items-center justify-between gap-2 border-t border-tg-border px-4 py-3 text-left text-tg-sm text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
        >
          {t("review.open")}
          <ArrowRight aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}
