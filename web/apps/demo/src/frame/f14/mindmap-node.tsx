/**
 * F17 S2: the mind map's cards at the design's sizes (the layout places
 * them): the main line's root, a chapter (§n, its time, a two-line title,
 * 「跨段整合 N 輪」 and its #n chips), a branch (支線・附結論卡 or 開放支線,
 * its chips and its card's one line), a separate conversation (dashed), and a
 * branch's fork pill (「自 §1 的 #3 後分岔」, or 「分岔點已移動」 in the warning
 * colours). Each card is a treeitem: selected on a click, dragged by a mouse
 * (desktop) onto a chapter's zones or the lane.
 */
import type { MindMapChip, MindMapFork, MindMapPlacedNode, MindMapRect } from "@tangent/client";
import { CornerDownRight, Flag, FolderOpen, GitBranch, Layers, List, TriangleAlert } from "lucide-react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import { cx } from "../cx";
import { useF17T, type F17T } from "./f17-messages";
import { ChapterZones, TurnTarget } from "./mindmap-drop";
import type { MindMapModelNode } from "./mindmap-model";
import { useAssemblyDnd } from "./use-assembly-drag";
import type { MindMap } from "./use-mindmap";

const boxStyle = (rect: MindMapRect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });

const tagChip = "inline-flex h-5 items-center gap-1 rounded-tg-full px-1.5 text-[0.6875rem] whitespace-nowrap";

/** The common treeitem props of a card. */
export interface ItemProps {
  itemKey: string;
  level: number;
  label: string;
  selected: boolean;
  focusable: boolean;
  onSelect: () => void;
}

function itemAttrs({ itemKey, level, label, selected, focusable, onSelect }: ItemProps) {
  return {
    role: "treeitem",
    "aria-level": level,
    "aria-label": label,
    "aria-selected": selected,
    tabIndex: focusable ? 0 : -1,
    "data-tg-mindmap-item": itemKey,
    onClick: onSelect,
  } as const;
}

const cardBase = "absolute box-border flex flex-col rounded-tg border-[1.5px] px-3 py-2.5 text-left outline-offset-3 focus-visible:outline-2 focus-visible:outline-tg-ring";

export interface RootCardProps {
  rect: MindMapRect;
  title: string;
  folder: string;
  tags: readonly string[];
  stats: string;
  item: ItemProps;
}

/** Tags shown on the root before 「+k」. */
const ROOT_TAGS = 2;

export function RootCard({ rect, title, folder, tags, stats, item }: RootCardProps) {
  const t = useF17T();
  const more = tags.length - ROOT_TAGS;
  return (
    <div {...itemAttrs(item)} data-tg-mindmap-root="" style={boxStyle(rect)} className={cx(cardBase, "cursor-pointer border-tg-border-strong bg-tg-surface-raised shadow-tg", item.selected && "outline-2 outline-tg-primary")}>
      <span className="flex items-center gap-1.5 text-[0.6875rem] text-tg-muted">
        <List aria-hidden className="size-3" />
        {t("map.root")}
      </span>
      <span className="mt-1 line-clamp-2 text-tg-md leading-snug font-semibold text-tg-foreground-strong">{title}</span>
      <span className="mt-2 flex min-w-0 flex-wrap gap-1 overflow-hidden">
        {folder && (
          <span className={cx(tagChip, "max-w-full bg-tg-surface-sunken text-tg-foreground")}>
            <FolderOpen aria-hidden className="size-3 shrink-0 text-tg-muted" />
            <span className="truncate">{folder}</span>
          </span>
        )}
        {tags.slice(0, ROOT_TAGS).map((tag) => (
          <span key={tag} className={cx(tagChip, "max-w-24 border border-tg-border text-tg-foreground")}>
            <span className="truncate">#{tag}</span>
          </span>
        ))}
        {more > 0 && <span className={cx(tagChip, "border border-tg-border text-tg-muted")}>+{more}</span>}
      </span>
      <span className="mt-auto truncate text-[0.6875rem] text-tg-muted">{stats}</span>
    </div>
  );
}

/** One chip: #n in a fixed 28 × 20 box (the trace lands on it), or 「+k」. */
function Chip({ chip, map, dimmed }: { chip: MindMapChip; map: MindMap; dimmed: boolean }) {
  const range = map.trace ? map.layout.trace.range : null;
  const turns = chip.turn === null ? chip.hidden : [chip.turn];
  const traced = range !== null && turns.some((turn) => turn >= range[0] && turn <= range[1]);
  return (
    <span
      data-tg-mindmap-chip={chip.turn ?? "more"}
      className={cx(
        "grid h-5 w-7 shrink-0 place-items-center rounded-[5px] border font-tg-mono text-[0.6875rem] font-semibold",
        traced ? "border-tg-warning bg-tg-warning-soft text-tg-foreground-strong" : "border-tg-border-input bg-tg-surface text-tg-foreground-strong",
        dimmed && "opacity-40",
      )}
    >
      {chip.turn === null ? `+${chip.hidden.length}` : `#${chip.turn}`}
    </span>
  );
}

function ChipRow({ placed, node, map, prefix }: { placed: MindMapPlacedNode; node: MindMapModelNode; map: MindMap; prefix?: string }) {
  const t = useF17T();
  const dragged = map.turnDrag?.turn ?? null;
  return (
    <span className="flex h-5 shrink-0 items-center gap-1">
      {placed.stitched && (
        <span className="inline-flex h-5 w-24 shrink-0 items-center gap-1 rounded-tg-full bg-tg-primary-soft px-1.5 text-[0.6875rem] font-medium whitespace-nowrap text-tg-primary-text">
          <Layers aria-hidden className="size-3 shrink-0" />
          {t("map.stitched", { n: node.turns.length })}
        </span>
      )}
      {placed.chips.map((chip) => (
        <Chip key={chip.turn ?? "more"} chip={chip} map={map} dimmed={chip.turn !== null && chip.turn === dragged} />
      ))}
      <span className="ml-0.5 text-[0.6875rem] whitespace-nowrap text-tg-muted">
        {node.turns.length === 0 && node.rounds > 0 ? `${t("map.rounds", { n: node.rounds })}・` : prefix}
        {t("map.messages", { n: node.messages })}
      </span>
    </span>
  );
}

export interface NodeCardProps {
  placed: MindMapPlacedNode;
  node: MindMapModelNode;
  map: MindMap;
  item: ItemProps;
  /** Desktop: the card can be dragged (onto a chapter's zones or the lane). */
  draggable: boolean;
}

/** A dragged card stays as a dashed placeholder; HTML5 drag carries its key. */
function useNodeDrag(nodeKey: string, draggable: boolean) {
  const dnd = useAssemblyDnd();
  const dragging = dnd?.dragging?.includes(nodeKey) ?? false;
  if (!draggable || !dnd) return { dragging, attrs: {} };
  return {
    dragging,
    attrs: {
      draggable: true,
      onDragStart: (event: DragEvent<HTMLDivElement>) => {
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", nodeKey);
        }
        dnd.start(nodeKey);
      },
      onDragEnd: dnd.end,
    },
  };
}

function cardTone(node: MindMapModelNode, selected: boolean, dragging: boolean): string {
  const tone = node.role === "chapter" ? "border-tg-primary bg-tg-surface" : node.role === "standalone" ? "border-dashed border-tg-border-strong bg-tg-surface-sunken" : "border-tg-branch-merged bg-tg-surface";
  return cx(tone, node.invalid && "border-tg-destructive", selected && "shadow-tg-overlay outline-2 outline-tg-primary", dragging && "border-dashed opacity-40");
}

function NodeBody({ placed, node, map }: { placed: MindMapPlacedNode; node: MindMapModelNode; map: MindMap }) {
  const t = useF17T();
  const title = <span className="mt-1.5 line-clamp-2 h-10 shrink-0 text-tg-sm leading-5 font-semibold text-tg-foreground-strong">{node.title}</span>;
  if (placed.kind === "chapter") {
    return (
      <>
        <span className="flex h-5 shrink-0 items-center gap-1.5">
          <span className="inline-flex h-5 items-center rounded-tg-sm bg-tg-primary px-1.5 font-tg-mono text-[0.6875rem] font-semibold text-tg-primary-foreground">§{placed.chapter}</span>
          <span className="truncate font-tg-mono text-[0.6875rem] text-tg-muted">{node.when}</span>
        </span>
        {title}
        <span className="mt-2">
          <ChipRow placed={placed} node={node} map={map} />
        </span>
      </>
    );
  }
  if (placed.kind === "standalone") {
    return (
      <>
        <span className="line-clamp-2 h-10 shrink-0 text-tg-sm leading-5 font-semibold text-tg-foreground-strong">{node.title}</span>
        <span className="mt-1.5">
          <ChipRow placed={placed} node={node} map={map} prefix={placed.chips.length > 0 ? "・" : ""} />
        </span>
      </>
    );
  }
  const merged = node.role === "merged_branch";
  return (
    <>
      <span className="flex h-4.5 shrink-0 items-center gap-1.5 text-[0.6875rem] whitespace-nowrap text-tg-muted">
        {merged ? <CornerDownRight aria-hidden className="size-3 text-tg-branch-merged" /> : <GitBranch aria-hidden className="size-3 text-tg-branch-open" />}
        {merged ? t("map.branchCard") : t("map.openBranch")}
        <span className="truncate font-tg-mono">{node.when}</span>
      </span>
      {title}
      <span className="mt-1.5">
        <ChipRow placed={placed} node={node} map={map} prefix={placed.chips.length > 0 ? "・" : ""} />
      </span>
      <span className="mt-2 flex h-5.5 min-w-0 shrink-0 items-center gap-1.5 rounded-tg-sm bg-tg-card px-1.5 text-[0.6875rem] text-tg-foreground">
        <Flag aria-hidden className="size-3 shrink-0 text-tg-leaf-conclusion" />
        <span className="truncate">{merged ? (node.card?.conclusion ?? "") : t("map.openNoCard")}</span>
      </span>
    </>
  );
}

export function NodeCard({ placed, node, map, item, draggable }: NodeCardProps) {
  const { dragging, attrs } = useNodeDrag(node.key, draggable);
  return (
    <div {...itemAttrs(item)} {...attrs} data-tg-mindmap-node={node.key} style={boxStyle(placed.rect)} className={cx(cardBase, "cursor-pointer", draggable && "active:cursor-grabbing", cardTone(node, item.selected, dragging))}>
      <NodeBody placed={placed} node={node} map={map} />
      {placed.kind === "chapter" && placed.chapter !== null && <ChapterZones chapterKey={node.key} chapter={placed.chapter} />}
      <TurnTarget map={map} nodeKey={node.key} units={node.units} />
    </div>
  );
}

/** 「自 §1 的 #3 後分岔」 (or 「分岔點已移動」) above a branch. */
export function forkText(t: F17T, fork: MindMapFork, chapter: number | null, round: number | null): string {
  const name = chapter !== null ? `§${chapter}` : "§";
  if (fork.turn !== null) return t("map.forkAfter", { chapter: name, turn: `#${fork.turn}` });
  return round !== null ? t("map.forkAfterRound", { chapter: name, n: round }) : t("map.forkIn", { chapter: name });
}

export function ForkPill({ fork, text, faded }: { fork: MindMapFork; text: string; faded: boolean }): ReactNode {
  const t = useF17T();
  return (
    <span
      aria-hidden
      data-tg-mindmap-fork={fork.moved ? "moved" : ""}
      title={fork.moved ? `${t("map.forkMoved")}・${text}` : text}
      style={{ left: fork.x, top: fork.y }}
      className={cx(
        "absolute inline-flex h-5 max-w-63 items-center gap-1 rounded-tg-full border px-2 text-[0.6875rem] whitespace-nowrap text-tg-foreground transition-opacity",
        fork.moved ? "border-tg-warning bg-tg-warning-soft font-medium" : "border-tg-branch-merged bg-tg-surface-raised",
        faded && "opacity-30",
      )}
    >
      {fork.moved ? <TriangleAlert aria-hidden className="size-2.5 shrink-0 text-tg-warning" /> : <GitBranch aria-hidden className="size-2.5 shrink-0 text-tg-branch-merged" />}
      <span className="truncate">{fork.moved ? `${t("map.forkMoved")}・${text}` : text}</span>
    </span>
  );
}
