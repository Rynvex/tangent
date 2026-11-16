import { driftOf, goalProposalOf, relationSuggestionOf, suggestionReason, type OpenLoops, type OpenSeed, type OpenSuggestion } from "@tangent/client";
import { IconButton, SegmentedControl, Skeleton, useEscapeLayer, useOpenLoops, useReadOnly, useSuggestionKind, Button } from "@tangent/react";
import { Hourglass, Inbox, NotebookPen, SquareParking, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { BranchFlow, Navigate } from "./branch-flows";
import { browserStorage, type PrefsStorage } from "./prefs";
import { NoteCard, SeedCardItem, StaleCard, SuggestionItem, type SnoozeProps } from "./review-cards";
import { useReviewT } from "./review-messages";
import { isSnoozed, loadSnoozes, reviewKey, saveSnoozes, snooze, unsnooze, type Snoozes } from "./snooze";

export interface ReviewBoardProps {
  /** The conversation on screen (the default scope). */
  rootLineId: string;
  onClose: () => void;
  navigate: Navigate;
  onFlow: (flow: BranchFlow) => void;
  /** 展開成支線 for a seed of the conversation on screen (the inbox's flow). */
  onExpandSeed: (seed: OpenSeed) => void;
  /** Where 暫存 is kept; the browser's storage by default. */
  storage?: PrefsStorage | null;
  now?: () => number;
}

type Scope = "tree" | "all";
type GroupId = "staleBranches" | "toConfirm" | "seeds" | "suggestions";

const ICONS: Record<GroupId, ReactNode> = {
  staleBranches: <Hourglass aria-hidden className="size-3.5" />,
  toConfirm: <NotebookPen aria-hidden className="size-3.5" />,
  seeds: <SquareParking aria-hidden className="size-3.5" />,
  suggestions: <Inbox aria-hidden className="size-3.5" />,
};

function useSnoozes(storage: PrefsStorage | null, now: () => number) {
  const [snoozes, setSnoozes] = useState<Snoozes>(() => loadSnoozes(storage, now()));
  const change = (next: Snoozes) => {
    setSnoozes(next);
    saveSnoozes(storage, next);
  };
  return {
    is: (key: string) => isSnoozed(snoozes, key, now()),
    count: (keys: readonly string[]) => keys.filter((key) => isSnoozed(snoozes, key, now())).length,
    snooze: (key: string) => change(snooze(snoozes, key, now())),
    unsnooze: (key: string) => change(unsnooze(snoozes, key)),
  };
}

function Column({ group, count, children, empty }: { group: GroupId; count: number; children: ReactNode; empty: boolean }) {
  const t = useReviewT();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-tg-sm font-semibold text-tg-foreground">
        {ICONS[group]}
        {t(`review.group.${group}`)}
        <span className="font-normal text-tg-subtle">{count}</span>
      </h3>
      {empty ? <p className="m-0 text-tg-xs text-tg-muted">{t("review.groupEmpty")}</p> : children}
    </section>
  );
}

/** A suggestion's text for its card: the goal, the two related branches, why it drifted, or its reason. */
function useDetail() {
  return (item: OpenSuggestion): string => {
    const goal = goalProposalOf(item);
    if (goal) return goal.text;
    const relation = relationSuggestionOf(item);
    if (relation) return `${relation.fromTitle} – ${relation.toTitle}`;
    return driftOf(item)?.reason ?? suggestionReason(item);
  };
}

function SuggestionCell({ item, all, onGo, snooze }: { item: OpenSuggestion; all: boolean; onGo: () => void; snooze: SnoozeProps }) {
  const kindName = useSuggestionKind(item.kind);
  return <SuggestionItem item={item} all={all} kindName={kindName} detail={useDetail()(item)} onGo={onGo} {...snooze} />;
}

/** Every item key of the loaded groups, to count what is left and what is snoozed. */
function keysOf(loops: OpenLoops): string[] {
  return [
    ...loops.staleBranches.items.map((item) => reviewKey("staleBranches", item.lineId)),
    ...(loops.toConfirm?.items ?? []).map((item) => reviewKey("toConfirm", item.id)),
    ...(loops.seeds?.items ?? []).map((item) => reviewKey("seeds", item.id)),
    ...(loops.suggestions?.items ?? []).map((item) => reviewKey("suggestions", item.id)),
  ];
}

/**
 * 回顧 (C5, components.md ReviewBoard, demo): what is still unfinished, in
 * four columns — branches open too long, notes to confirm, parked seeds,
 * open suggestions — for this conversation or all of them. Each item ends,
 * snoozes (a day, this browser only) or continues. Esc closes it.
 */
export function ReviewBoard({ rootLineId, onClose, navigate, onFlow, onExpandSeed, storage = browserStorage(), now = Date.now }: ReviewBoardProps) {
  const t = useReviewT();
  const headingId = useId();
  const readOnly = useReadOnly();
  const [scope, setScope] = useState<Scope>("tree");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const loops = useOpenLoops(scope === "tree" ? rootLineId : null);
  const snoozes = useSnoozes(storage, now);
  const handled = useEscapeLayer(true, onClose);
  const all = scope === "all";
  const data = loops.data;
  const keys = data ? keysOf(data) : [];
  const snoozedCount = snoozes.count(keys);
  const overflow = data ? data.staleBranches.total - data.staleBranches.items.length + (["toConfirm", "seeds", "suggestions"] as const).reduce((sum, id) => sum + ((data[id]?.total ?? 0) - (data[id]?.items.length ?? 0)), 0) : 0;
  const left = keys.length - snoozedCount + overflow;
  const visible = <T,>(group: GroupId, items: readonly T[], id: (item: T) => string) => items.filter((item) => showSnoozed || !snoozes.is(reviewKey(group, id(item))));
  const snoozeProps = (group: GroupId, id: string): SnoozeProps => {
    const key = reviewKey(group, id);
    return { snoozed: snoozes.is(key), onSnooze: () => snoozes.snooze(key), onUnsnooze: () => snoozes.unsnooze(key), readOnly };
  };
  const go = (lineId: string, messageId?: string) => {
    navigate(lineId, messageId);
    onClose();
  };
  const expand = (seed: OpenSeed) => (seed.rootLineId === rootLineId ? onExpandSeed(seed) : go(seed.anchorLineId || seed.rootLineId, seed.anchorMessageId || undefined));
  return (
    <section
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (handled || event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
      className="absolute inset-0 z-20 flex flex-col gap-4 overflow-auto bg-tg-background p-4 sm:p-6"
    >
      <header className="flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="m-0 text-tg-lg font-semibold text-tg-foreground-strong">
          {t("review.title")}
        </h2>
        {data && <span className="text-tg-sm text-tg-muted">{left > 0 ? t("review.left", { count: left }) : t("review.done")}</span>}
        <span className="flex-1" />
        <SegmentedControl label={t("review.scope")} options={[{ value: "tree", label: t("review.scopeTree") }, { value: "all", label: t("review.scopeAll") }]} value={scope} onValueChange={setScope} />
        {snoozedCount > 0 && (
          <Button size="sm" variant="ghost" aria-pressed={showSnoozed} onClick={() => setShowSnoozed(!showSnoozed)}>
            {showSnoozed ? t("review.hideSnoozed") : t("review.showSnoozed", { count: snoozedCount })}
          </Button>
        )}
        <IconButton label={t("review.close")} icon={<X />} onClick={onClose} />
      </header>
      {loops.isPending && <Skeleton className="h-40 w-full" />}
      {loops.isError && (
        <div role="alert" className="flex flex-col items-start gap-2 text-tg-sm text-tg-muted">
          {t("review.loadFailed")}
          <Button size="sm" onClick={() => void loops.refetch()}>
            {t("review.retry")}
          </Button>
        </div>
      )}
      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Column group="staleBranches" count={data.staleBranches.total} empty={visible("staleBranches", data.staleBranches.items, (item) => item.lineId).length === 0}>
            {visible("staleBranches", data.staleBranches.items, (item) => item.lineId).map((item) => (
              <StaleCard key={item.lineId} item={item} all={all} onContinue={() => go(item.lineId)} onEnd={() => onFlow({ kind: "review", lineId: item.lineId })} {...snoozeProps("staleBranches", item.lineId)} />
            ))}
          </Column>
          {data.toConfirm && (
            <Column group="toConfirm" count={data.toConfirm.total} empty={visible("toConfirm", data.toConfirm.items, (item) => item.id).length === 0}>
              {visible("toConfirm", data.toConfirm.items, (item) => item.id).map((item) => (
                <NoteCard key={item.id} item={item} all={all} onContinue={() => go(item.sourceLineId || item.rootLineId, item.sourceMessageId || undefined)} {...snoozeProps("toConfirm", item.id)} />
              ))}
            </Column>
          )}
          {data.seeds && (
            <Column group="seeds" count={data.seeds.total} empty={visible("seeds", data.seeds.items, (item) => item.id).length === 0}>
              {visible("seeds", data.seeds.items, (item) => item.id).map((item) => (
                <SeedCardItem key={item.id} item={item} all={all} onExpand={() => expand(item)} {...snoozeProps("seeds", item.id)} />
              ))}
            </Column>
          )}
          {data.suggestions && (
            <Column group="suggestions" count={data.suggestions.total} empty={visible("suggestions", data.suggestions.items, (item) => item.id).length === 0}>
              {visible("suggestions", data.suggestions.items, (item) => item.id).map((item) => (
                <SuggestionCell key={item.id} item={item} all={all} onGo={() => go(item.lineId)} snooze={snoozeProps("suggestions", item.id)} />
              ))}
            </Column>
          )}
        </div>
      )}
    </section>
  );
}
