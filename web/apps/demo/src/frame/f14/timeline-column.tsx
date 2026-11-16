/**
 * F14 S2, the left column: the sessions oldest first, each a SessionNodeCard
 * (drag or Alt+arrows to reorder; announced). F16.1: the compact view (on by
 * default from 8 sessions, `data-tg-compact-toggle`), the filter row (from 5),
 * the checkboxes with Shift ranges and the BatchActionBar; dragging a checked
 * card drags every checked one.
 */
import type { TimelineSession } from "@tangent/client";
import { ClockArrowUp } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "../cx";
import { BatchActionBar } from "./batch-action-bar";
import { refocus, useCardHandlers } from "./card-handlers";
import { useF14T } from "./f14-messages";
import { SessionNodeCard } from "./session-node-card";
import { filterSessions, NO_FILTER, Step2FilterBar, type Step2Filter } from "./step2-filter";
import type { Assembly } from "./use-assembly";
import type { AssemblyDnd } from "./use-assembly-drag";

/** From this many picked sessions the list starts compact. */
export const COMPACT_FROM = 8;
/** From this many the filter row shows. */
export const FILTER_FROM = 5;

export interface TimelineColumnProps {
  assembly: Assembly;
  dnd: AssemblyDnd;
  /** How many sessions were picked (before merging): the compact default. */
  picked: number;
  relations: boolean;
  touch: boolean;
  locale: string;
}

function ColumnHeader({ touch, compact, onCompact }: { touch: boolean; compact: boolean; onCompact: () => void }) {
  const t = useF14T();
  return (
    <header className="flex items-center gap-2 text-tg-sm">
      {!touch && <ClockArrowUp aria-hidden className="size-4 text-tg-muted" />}
      {!touch && <h3 className="m-0 flex-1 text-tg-sm font-semibold text-tg-foreground-strong">{t("import.chronological")}</h3>}
      {!touch && <span className="text-tg-xs text-tg-muted">{t("import.dragHint")}</span>}
      <button
        type="button"
        data-tg-compact-toggle=""
        onClick={onCompact}
        className={cx("shrink-0 rounded-tg-sm border border-tg-border px-2 text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "ml-auto min-h-11" : "h-6")}
      >
        {compact ? t("f161.compactOff") : t("f161.compactOn")}
      </button>
    </header>
  );
}

interface TimelineListProps extends Omit<TimelineColumnProps, "picked"> {
  shown: readonly TimelineSession[];
  compact: boolean;
  cards: ReturnType<typeof useCardHandlers>;
}

function TimelineList({ assembly, dnd, relations, touch, locale, shown, compact, cards }: TimelineListProps) {
  const { blueprint, ordered } = assembly;
  const nodes = new Map(blueprint.nodes.map((node) => [node.key, node]));
  const shownKeys = shown.map((session) => session.key);
  return (
    <ol className={cx("m-0 flex list-none flex-col p-0", compact ? "gap-1" : "gap-2")}>
      {shown.map((session) => {
        const index = ordered.indexOf(session);
        const node = nodes.get(session.key)!;
        return (
          <SessionNodeCard
            key={session.key}
            session={session}
            index={index}
            count={ordered.length}
            role={node.role}
            chapter={node.chapter}
            mode={assembly.mode}
            relations={relations}
            attach={node.attach?.point ?? null}
            attachOptions={assembly.attachOptions.filter((option) => option.point.sessionKey !== session.key)}
            edits={assembly.messageEdits(session.key)}
            expanded={cards.expanded.has(session.key)}
            openSegment={cards.segments[session.key] ?? null}
            dragging={dnd.dragging?.includes(session.key) ?? false}
            touch={touch}
            locale={locale}
            compact={compact}
            selected={dnd.selection.has(session.key)}
            selectedCount={dnd.selection.size}
            mergedCount={assembly.mergedCountOf(session.key)}
            handlers={cards.handlersFor(session, index, shownKeys)}
          />
        );
      })}
    </ol>
  );
}

export function TimelineColumn(props: TimelineColumnProps) {
  const t = useF14T();
  const { assembly, dnd, touch } = props;
  const [compactChoice, setCompactChoice] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<Step2Filter>(NO_FILTER);
  const cards = useCardHandlers(assembly, dnd);
  const { blueprint, ordered } = assembly;
  const selection = dnd.selection;
  const compact = compactChoice ?? props.picked >= COMPACT_FROM;
  const filtering = ordered.length >= FILTER_FROM;
  const shown = useMemo(() => (filtering ? filterSessions(ordered, blueprint.nodes, filter) : ordered), [filtering, ordered, blueprint.nodes, filter]);
  const shownKeys = shown.map((session) => session.key);
  const nodesMap = useMemo(() => new Map(blueprint.nodes.map((node) => [node.key, node])), [blueprint.nodes]);
  const chapters = blueprint.nodes.flatMap((node) => (node.role === "chapter" && node.chapter !== null ? [{ key: node.key, chapter: node.chapter, title: assembly.byKey.get(node.key)?.conversation.title || t("import.untitled") }] : []));
  const targets = useMemo(
    () =>
      ordered.map((session) => {
        const node = nodesMap.get(session.key);
        return {
          key: session.key,
          chapter: node?.chapter ?? null,
          role: node?.role ?? "chapter",
          title: session.conversation.title || t("import.untitled"),
        };
      }),
    [ordered, nodesMap, t],
  );
  const mergeSelected = (preferredTargetKey?: string) => {
    const keys = preferredTargetKey && !selection.has(preferredTargetKey) ? [...selection.ordered, preferredTargetKey] : selection.ordered;
    if (cards.merge(keys, preferredTargetKey)) selection.clear();
  };
  const moveAfterSelected = (targetKey: string) => {
    assembly.moveBatchAfter(selection.ordered, targetKey);
    selection.clear();
  };
  const clearSelection = () => {
    selection.clear();
    refocus("[data-tg-select-shown], [data-tg-select-box]");
  };
  return (
    <section aria-label={t("import.chronological")} className="flex min-h-0 flex-col gap-2">
      <ColumnHeader touch={touch} compact={compact} onCompact={() => setCompactChoice(!compact)} />
      {selection.size > 0 && (
        <BatchActionBar
          count={selection.size}
          chapters={chapters}
          targets={targets}
          touch={touch}
          onRole={(role, chapterKey) => assembly.setRoleBatch(selection.ordered, role, chapterKey)}
          onMerge={mergeSelected}
          onMoveAfter={moveAfterSelected}
          onClear={clearSelection}
        />
      )}
      {filtering && (
        <Step2FilterBar filter={filter} onFilter={setFilter} shown={shown.length} checkedShown={shownKeys.filter(selection.has).length} touch={touch} onSelectShown={(on) => selection.setMany(shownKeys, on)} />
      )}
      <span role="status" className="sr-only">
        {cards.said}
      </span>
      {shown.length === 0 && (
        <p className="m-0 flex items-center gap-2 text-tg-xs text-tg-muted">
          {t("f161.noMatch")}
          <button type="button" onClick={() => setFilter(NO_FILTER)} className="rounded-tg-sm px-1 font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring">
            {t("f161.clearFilter")}
          </button>
        </p>
      )}
      <TimelineList {...props} shown={shown} compact={compact} cards={cards} />
    </section>
  );
}
