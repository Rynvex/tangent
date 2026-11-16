/**
 * F17 MindMapCanvas (S2, S3, S5): the layout drawn on a dotted canvas that
 * scrolls, scaled by one CSS transform (縮小／放大／置中適應; hit testing
 * follows the transform, so drops land where they are shown). The tree's
 * curves, its cards (treeitems: arrow keys move and select, Right goes to a
 * child and Left to the parent, Home and End, Enter opens the inspector),
 * the fork pills, the lane of separate conversations, and with 顯示穿插順序
 * the turn order: amber dashed curves with 「n→n+1」 labels, the tree's own
 * lines faded to 35%. Nothing in it is announced twice: the curves, pills and
 * labels are decoration (aria-hidden); every card says what it holds.
 */
import { MINDMAP_ROOT_KEY, type ImportMindMapLayout, type MindMapPlacedNode } from "@tangent/client";
import { ExternalLink, MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { cx } from "../cx";
import { useF17T, type F17T } from "./f17-messages";
import { Controls, Legend } from "./mindmap-controls";
import { useLaneTarget } from "./mindmap-drop";
import { useAssemblyDnd } from "./use-assembly-drag";
import type { MindMapModelNode } from "./mindmap-model";
import { ForkPill, forkText, NodeCard, RootCard } from "./mindmap-node";
import { clampZoom, type MindMap } from "./use-mindmap";

/** Room around the tree: the sides, the top, and the bottom (where the desktop's legend and controls float). */
const EDGE = 10;
const TOP = 12;
const BOTTOM_DESKTOP = 56;
const BOTTOM_TOUCH = 16;
/** The tree's own lines while the turn order is shown. */
const FADED = 0.35;

export interface MindMapCanvasProps {
  map: MindMap;
  touch: boolean;
  full: boolean;
  root: { title: string; folder: string; tags: readonly string[] };
  /** A card was chosen: `open` moves focus into the inspector (Enter); `browse` is an arrow key (full width stays). */
  onPick: (key: string, open: boolean, browse?: boolean) => void;
}

const itemSelector = (key: string) => `[data-tg-mindmap-item="${CSS.escape(key)}"]`;

/** The keyboard order and the tree's parents and first children. */
function navigation(layout: ImportMindMapLayout) {
  const order = [...(layout.root ? [MINDMAP_ROOT_KEY] : []), ...layout.nodes.map((node) => node.key)];
  const parent = new Map<string, string>();
  const child = new Map<string, string>();
  for (const node of layout.nodes) {
    const up = node.parentKey ?? (layout.root ? MINDMAP_ROOT_KEY : null);
    if (!up) continue;
    parent.set(node.key, up);
    if (!child.has(up) && (node.kind !== "standalone" || up !== MINDMAP_ROOT_KEY)) child.set(up, node.key);
  }
  return { order, parent, child };
}

function nextKey(layout: ImportMindMapLayout, current: string, key: string): string | null {
  const { order, parent, child } = navigation(layout);
  const at = order.indexOf(current);
  switch (key) {
    case "ArrowDown":
      return order[Math.min(at + 1, order.length - 1)] ?? null;
    case "ArrowUp":
      return order[Math.max(at - 1, 0)] ?? null;
    case "ArrowRight":
      return child.get(current) ?? null;
    case "ArrowLeft":
      return parent.get(current) ?? null;
    case "Home":
      return order[0] ?? null;
    case "End":
      return order.at(-1) ?? null;
    default:
      return null;
  }
}

function useBoxSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setSize({ w: box.clientWidth, h: box.clientHeight }));
    observer.observe(box);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function nodeLabel(t: F17T, placed: MindMapPlacedNode, node: MindMapModelNode, chapters: ReadonlyMap<string, number>): string {
  const turns = node.turns.length > 0 ? t("map.aria.turns", { list: node.turns.map((turn) => `#${turn}`).join("、") }) : "";
  if (placed.kind === "chapter") return t("map.aria.chapter", { n: placed.chapter ?? "", title: node.title, turns });
  if (placed.kind === "standalone") return t("map.aria.solo", { title: node.title, turns });
  const fork = placed.fork ? `${placed.fork.moved ? `${t("map.forkMoved")}・` : ""}${forkText(t, placed.fork, chapters.get(placed.parentKey ?? "") ?? null, node.forkRound)}` : "";
  return t(node.role === "open_branch" ? "map.aria.open" : "map.aria.branch", { title: node.title, fork, turns });
}

function Lane({ map, layout, batch }: { map: MindMap; layout: ImportMindMapLayout; batch: boolean }) {
  const t = useF17T();
  const { active, over, props } = useLaneTarget(map);
  const { lane } = layout;
  return (
    <>
      <div
        aria-hidden
        data-tg-mindmap-lane=""
        {...props}
        style={{ top: lane.y, height: lane.height, width: layout.width }}
        className={cx("absolute left-0 border-t-[1.5px] border-dashed", active ? "rounded-b-tg border-tg-primary bg-tg-primary-soft outline-[1.5px] -outline-offset-2 outline-tg-primary outline-dashed" : "border-tg-border-strong", over && "ring-2 ring-tg-ring")}
      />
      <span aria-hidden style={{ top: lane.titleY }} className={cx("pointer-events-none absolute left-6 inline-flex items-center gap-1.5 text-tg-xs font-medium whitespace-nowrap", active ? "text-tg-primary-text" : "text-tg-muted")}>
        <ExternalLink aria-hidden className="size-3.5" />
        {active ? t("map.laneDrop") : batch ? t("map.laneBatch") : t("map.lane")}
      </span>
    </>
  );
}

function Curves({ map, layout }: { map: MindMap; layout: ImportMindMapLayout }) {
  const opacity = map.trace ? FADED : 1;
  const dragging = map.turnDrag !== null;
  return (
    <svg aria-hidden width={layout.width} height={layout.height} className="pointer-events-none absolute top-0 left-0 overflow-visible">
      {layout.edges.map((edge) => {
        const color = edge.kind === "chapter-to-branch" ? "var(--tg-branch-merged)" : "var(--tg-primary)";
        const width = edge.kind === "chapter-spine" ? 3 : edge.kind === "root-to-chapter" ? 2 : 1.75;
        return (
          <g key={`${edge.kind}:${edge.from}:${edge.to}`} style={{ opacity }}>
            <path d={edge.d} fill="none" style={{ stroke: color }} strokeWidth={width} strokeLinecap="round" />
            {edge.head && <path d={edge.head} fill="none" style={{ stroke: color }} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
          </g>
        );
      })}
      {map.trace &&
        !dragging &&
        layout.trace.paths.map((path) => (
          <g key={`${path.from}`} data-tg-mindmap-trace-path={`${path.from}-${path.to}`}>
            <path d={path.d} fill="none" style={{ stroke: "var(--tg-warning)" }} strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" />
            <path d={path.head} style={{ fill: "var(--tg-warning)" }} />
          </g>
        ))}
    </svg>
  );
}

export function MindMapCanvas({ map, touch, full, root, onPick }: MindMapCanvasProps) {
  const t = useF17T();
  const scroller = useRef<HTMLDivElement>(null);
  const size = useBoxSize(scroller);
  const { layout, model, zoom } = map;
  const chapters = new Map(layout.nodes.flatMap((node) => (node.chapter !== null ? [[node.key, node.chapter] as const] : [])));
  const fitted = useRef(false);
  const fit = () => {
    const box = scroller.current;
    if (!box) return;
    const bottom = touch ? BOTTOM_TOUCH : BOTTOM_DESKTOP;
    map.setZoom(clampZoom(Math.min(1, (box.clientWidth - 2 * EDGE) / layout.width, (box.clientHeight - TOP - bottom) / layout.height)));
    box.scrollTo?.({ left: 0, top: 0 });
  };
  // A phone starts with the whole width in view (about 43%).
  useEffect(() => {
    if (!touch || fitted.current || size.w === 0) return;
    fitted.current = true;
    map.setZoom(clampZoom((size.w - 2 * EDGE) / layout.width));
  }, [touch, size.w, layout.width, map]);
  const focusKey = map.selected ?? (layout.root ? MINDMAP_ROOT_KEY : (layout.nodes[0]?.key ?? null));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = (event.target as HTMLElement).closest<HTMLElement>("[data-tg-mindmap-item]")?.dataset.tgMindmapItem;
    if (!current) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onPick(current, event.key === "Enter");
      return;
    }
    const next = nextKey(layout, current, event.key);
    if (next === null) return;
    event.preventDefault();
    onPick(next, false, true);
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(itemSelector(next))?.focus());
  };
  const width = layout.width * zoom;
  const left = Math.max(EDGE, (size.w - width) / 2);
  const bottom = touch ? BOTTOM_TOUCH : BOTTOM_DESKTOP;
  const item = (key: string, level: number, label: string) => ({ itemKey: key, level, label, selected: map.selected === key, focusable: focusKey === key, onSelect: () => onPick(key, false) });
  const stats = t("map.rootStats", model.stats);
  const dragging = map.turnDrag !== null;
  const nodeDragging = useAssemblyDnd()?.dragging != null;
  return (
    <div className={touch ? "relative flex h-[clamp(13rem,45dvh,22rem)] shrink-0 flex-col" : "relative flex min-h-0 min-w-0 flex-1 flex-col"}>
      {touch && <Controls map={map} touch onFit={fit} />}
      <div
        ref={scroller}
        role="tree"
        aria-label={t("map.label")}
        data-tg-mindmap-canvas=""
        onKeyDown={onKeyDown}
        className="relative min-h-0 flex-1 overflow-auto bg-tg-background bg-[radial-gradient(var(--tg-border)_1px,transparent_1px)] [background-size:20px_20px]"
      >
        <div role="none" style={{ width: left + width + EDGE, height: TOP + layout.height * zoom + bottom }} className="relative">
          <div role="none" data-tg-mindmap-world="" style={{ left, top: TOP, width: layout.width, height: layout.height, transform: `scale(${zoom})` }} className="absolute origin-top-left">
            <Lane map={map} layout={layout} batch={model.input.mode === "batch"} />
            <Curves map={map} layout={layout} />
            {layout.nodes.map((placed) =>
              placed.fork ? <ForkPill key={`fork:${placed.key}`} fork={placed.fork} faded={dragging || nodeDragging} text={forkText(t, placed.fork, chapters.get(placed.parentKey ?? "") ?? null, model.byKey.get(placed.key)?.forkRound ?? null)} /> : null,
            )}
            {layout.root && <RootCard rect={layout.root} title={root.title} folder={root.folder} tags={root.tags} stats={stats} item={item(MINDMAP_ROOT_KEY, 1, t("map.aria.root", { title: root.title, stats }))} />}
            {layout.nodes.map((placed) => {
              const node = model.byKey.get(placed.key);
              if (!node) return null;
              const level = placed.kind === "branch" ? 3 : layout.root ? 2 : 1;
              return <NodeCard key={placed.key} placed={placed} node={node} map={map} draggable={!touch} item={item(placed.key, level, nodeLabel(t, placed, node, chapters))} />;
            })}
            {map.trace &&
              !dragging &&
              layout.trace.labels.map((label) => (
                <span
                  key={label.text}
                  aria-hidden
                  data-tg-mindmap-trace-label={label.text}
                  style={{ left: label.x, top: label.y }}
                  className="pointer-events-none absolute inline-flex h-4.5 -translate-x-1/2 -translate-y-1/2 items-center rounded-tg-full bg-tg-warning px-1.5 font-tg-mono text-[0.625rem] font-semibold whitespace-nowrap text-tg-background shadow-[0_0_0_2px_var(--tg-background)]"
                >
                  {label.text}
                </span>
              ))}
          </div>
        </div>
      </div>
      {!touch && <Legend trace={map.trace} />}
      {!touch && <Controls map={map} touch={false} onFit={fit} />}
      {full && (
        <span data-tg-mindmap-full-hint="" className="pointer-events-none absolute top-3 right-3 z-20 inline-flex items-center gap-1.5 rounded-tg border border-tg-border bg-tg-surface-raised px-2.5 py-1.5 text-tg-xs whitespace-nowrap text-tg-muted">
          <MousePointerClick aria-hidden className="size-3.5" />
          {t("map.hint")}
        </span>
      )}
    </div>
  );
}
