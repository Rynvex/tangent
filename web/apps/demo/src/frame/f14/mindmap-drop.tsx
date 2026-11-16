/**
 * F17 S5, the mind map's drop targets (desktop; phones move a round from a
 * menu and a node from its inspector):
 * - ChapterZones: while another node is dragged, a chapter shows two side by
 *   side zones, 「掛在 §k 下當支線」 and 「合併進 §k」 (decision #5), dropped
 *   on through F16.1's AssemblyDnd.
 * - TurnTarget: while a round is dragged from the inspector, every other
 *   node is a target: 「將第 #n 輪併入此節點」 (S5b).
 * - LaneTarget: the separate conversations' lane takes a node (另存為獨立對話)
 *   or a round (a conversation of its own).
 * They are pointer targets only (aria-hidden): the inspector's role buttons,
 * 掛載於, 合併進… and 移至其他節點 do the same from the keyboard.
 * The canvas is scaled with a CSS transform, which the browser's hit testing
 * follows, so a drop lands where it is shown at any zoom.
 */
import { CirclePlus, CornerDownRight, Plus } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { useDropTarget } from "./drop-zones";
import { useF17T } from "./f17-messages";
import { useAssemblyDnd } from "./use-assembly-drag";
import type { MindMap } from "./use-mindmap";

function Zone({ over, icon, label, testId, props }: { over: boolean; icon: ReactNode; label: string; testId: Record<string, string>; props: ReturnType<typeof useDropTarget>["props"] }) {
  return (
    <span
      {...testId}
      {...props}
      className={cx(
        "flex min-w-0 flex-col items-center justify-center gap-1 rounded-tg-sm border-[1.5px] border-dashed px-1 text-center text-tg-xs font-semibold",
        over ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border-strong bg-tg-surface text-tg-foreground",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

/** 「掛在 §k 下當支線」｜「合併進 §k」 over chapter `chapterKey` while another node is dragged. */
export function ChapterZones({ chapterKey, chapter }: { chapterKey: string; chapter: number }) {
  const t = useF17T();
  const dnd = useAssemblyDnd();
  const attach = useDropTarget({ kind: "attach", chapterKey });
  const merge = useDropTarget({ kind: "merge", key: chapterKey });
  if (!dnd?.dragging || dnd.dragging.includes(chapterKey)) return null;
  const name = `§${chapter}`;
  return (
    <span aria-hidden className="absolute -inset-[1.5px] z-10 grid grid-cols-2 gap-1.5 rounded-tg bg-[color-mix(in_oklab,var(--tg-surface-raised)_90%,transparent)] p-2">
      <Zone over={attach.over} props={attach.props} testId={{ "data-tg-mindmap-drop-branch": chapterKey }} icon={<CornerDownRight aria-hidden className="size-4" />} label={t("map.dropBranch", { chapter: name })} />
      <Zone over={merge.over} props={merge.props} testId={{ "data-tg-mindmap-drop-merge": chapterKey }} icon={<CirclePlus aria-hidden className="size-4" />} label={t("map.dropMerge", { chapter: name })} />
    </span>
  );
}

/** dragover / dragleave / drop of a round dragged from the inspector. */
function useTurnDrop(map: MindMap, target: string) {
  const [over, setOver] = useState(false);
  const allow = (event: DragEvent<HTMLElement>) => {
    if (!map.isDraggingTurn()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  return {
    over: over && map.turnDrag !== null,
    props: {
      onDragEnter: allow,
      onDragOver: allow,
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!map.isDraggingTurn()) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        map.dropTurn(target);
      },
    },
  };
}

/** Node `nodeKey` as a place for the dragged round (not the node it is in). */
export function TurnTarget({ map, nodeKey, units }: { map: MindMap; nodeKey: string; units: readonly string[] }) {
  const t = useF17T();
  const { over, props } = useTurnDrop(map, nodeKey);
  const drag = map.turnDrag;
  if (!drag || units.includes(drag.unit)) return null;
  return (
    <span aria-hidden data-tg-mindmap-drop-turn={nodeKey} {...props} className={cx("absolute -inset-[1.5px] z-10 rounded-tg outline-2 outline-offset-2 outline-tg-primary outline-dashed", over && "bg-[color-mix(in_oklab,var(--tg-primary-soft)_70%,transparent)]")}>
      <span className={cx("absolute -top-7 left-0 inline-flex h-5 items-center gap-1 rounded-tg-full px-2 text-[0.6875rem] font-medium whitespace-nowrap", over ? "bg-tg-primary text-tg-primary-foreground" : "bg-tg-primary-soft text-tg-primary-text")}>
        <Plus aria-hidden className="size-3" />
        {t("map.dropTurn", { turn: `#${drag.turn}` })}
      </span>
    </span>
  );
}

/** The lane's drop handling: a node becomes a separate conversation, a round one of its own. */
export function useLaneTarget(map: MindMap) {
  const dnd = useAssemblyDnd();
  const node = useDropTarget({ kind: "role", role: "standalone" });
  const turn = useTurnDrop(map, "lane");
  // Each handler checks its own drag (read at once), so both can listen all the time.
  const both = (name: "onDragEnter" | "onDragOver" | "onDragLeave") => (event: DragEvent<HTMLElement>) => {
    turn.props[name](event);
    if (dnd) node.props[name](event);
  };
  return {
    active: dnd?.dragging != null || map.turnDrag !== null,
    over: node.over || turn.over,
    props: {
      onDragEnter: both("onDragEnter"),
      onDragOver: both("onDragOver"),
      onDragLeave: both("onDragLeave"),
      onDrop: (event: DragEvent<HTMLElement>) => (map.isDraggingTurn() ? turn.props.onDrop(event) : dnd?.isDragging() ? node.props.onDrop(event) : undefined),
    },
  };
}
