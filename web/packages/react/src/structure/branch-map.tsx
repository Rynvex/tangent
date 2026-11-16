import { BRANCH_MAP_METRICS, MAP_ROOT_KEY, buildBranchMapLayout, chapterStageBoxes, defaultCollapsed, groupFrames, pathKeys, type BranchView, type Chapter, type MapNode } from "@tangent/client";
import { ListChecks, Maximize2, Minimize2, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { IconButton } from "../components/icon-button";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { MapNodeView } from "./map-node";
import { MapStages, hasStages } from "./chapter-stages";
import { RELATION_ROOM } from "./relation-geometry";
import { FisheyeLegend, LayerSwitch, type MapFisheyeProps, type MapLayer, type MapTagsProps } from "./map-layers";
import { GroupFrameLines, GroupSummaries, type MapGroupsProps } from "./group-layer";
import { useMapRelationLayer } from "./map-relations";
import { useMapFocus } from "./use-map-focus";
import { useMapPinch } from "./use-map-pinch";
import { useMapSelection } from "./use-map-selection";
import { useF12T } from "../i18n/f12-messages";
import { RelationHint, RelationLines, RelationNotes, RelationStatus, type MapRelationsProps } from "./relation-layer";

export type { MapRelationsProps } from "./relation-layer";
export type { MapFisheyeProps, MapTagsProps } from "./map-layers";
export type { MapGroupsProps } from "./group-layer";

/** components.md BranchMap: zoom 50–160 %. */
export const MAP_ZOOM_MIN = 0.5;
export const MAP_ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;
/** Room left around the map when fitting it. */
const FIT_MARGIN_PX = 16;

const clampZoom = (zoom: number) => Math.round(Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, zoom)) * 100) / 100;

/**
 * Decision #10: the zoom the map opens at — 100 % when it fits, else what
 * makes the wider of width and height fit, down to 50 % (then the main line
 * and the first layer, at the start, are what is guaranteed in view).
 */
export function firstFitZoom(box: { width: number; height: number }, content: { width: number; height: number }): number | null {
  if (box.width <= 0 || box.height <= 0) return null;
  if (content.width <= box.width && content.height <= box.height) return null;
  return clampZoom(Math.min(1, (box.width - FIT_MARGIN_PX) / content.width, (box.height - FIT_MARGIN_PX) / content.height));
}

export interface BranchMapProps {
  /** The tree's outline. */
  branches: readonly BranchView[];
  rootLineId: string;
  currentLineId: string;
  mainCount?: number;
  /** A node switches to its line (the root id for the main line). */
  onEnter: (lineId: string) => void;
  /** Shown when the host can open the map over the conversation. */
  onToggleFullscreen?: () => void;
  fullscreen?: boolean;
  /** Puts each ended branch's leaf on its node (the leaf feature, B1). */
  showLeaves?: boolean;
  /** The relation layer (C3, the relations feature): shown with a 關聯 switch; absent when the feature is off. */
  relations?: MapRelationsProps;
  /** The 魚眼 layer (C1, the fisheye feature): node opacity = how much AI sees; absent when the feature is off. */
  fisheye?: MapFisheyeProps;
  /** The 群組 layer and multi-select (C2, the group feature): absent when the feature is off. */
  groups?: MapGroupsProps;
  /** The 論證類型 layer (D2, the ibis feature): absent when the feature is off. */
  tags?: MapTagsProps;
  /**
   * Focus mode (FOCUS_MODE.md §6.2): a click chooses a node for the host's
   * node panel; double-click or Enter enters it (`onEnter`). Without it a
   * click enters, as in the side panel and the full-width map.
   */
  onSelect?: (lineId: string) => void;
  /** The chosen node's line (the root id for the main line); one node, unlike the multi-select. */
  selectedLineId?: string | null;
  /** §6.3: the line whose subtree (and way up) stays lit while the rest fades; the map fits it when it changes. */
  focusLineId?: string | null;
  /** §6.1 跟隨 (focus mode): while true the current line is brought into view whenever it changes. */
  follow?: boolean;
  /** The viewer panned or zoomed by hand (focus mode pauses following). */
  onManualMove?: () => void;
  /** §8.4: notes per map key (MAP_ROOT_KEY for the main line). */
  noteCounts?: ReadonlyMap<string, number>;
  /** B13: memos per map key, in the same mark. */
  memoCounts?: ReadonlyMap<string, number>;
  /** Canvas pixels on the right covered by a floating panel, kept clear when a node is brought into view. */
  coveredRight?: number;
  /** The share of the canvas's height a panel covers from the bottom, kept clear the same way. */
  coveredBottomShare?: number;
  /** Controls before the layer switches (focus mode's 跟隨 and 聚焦子樹). */
  toolbar?: ReactNode;
  /** More layer switches (focus mode's 筆記). */
  extraLayers?: readonly MapLayer[];
  /** Drawn over the canvas, outside its scrolling (focus mode's node panel). */
  overlay?: ReactNode;
  /** Nodes to mark softly (focus mode: the branches of the fork point in view in the chat, §6.1). */
  highlighted?: ReadonlySet<string>;
  /** F11 §3: the main line's chapters (the chapters feature), drawn as stages under the main node from two on. */
  chapters?: readonly Chapter[];
  /** A stage goes to its chapter's first message on the main line. */
  onGoToChapter?: (chapter: Chapter) => void;
  className?: string;
}

/** 多選 (C2): a pressed switch; while on, choosing a node selects it. */
function SelectToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useUiT();
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cx(
        "inline-flex h-6.5 items-center gap-1 rounded-tg-full border px-2.5 text-tg-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11",
        on ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border-strong text-tg-muted hover:text-tg-foreground",
      )}
    >
      <ListChecks aria-hidden className="size-3" />
      {t("outline.multiselect")}
    </button>
  );
}

/** How far a press must move before it counts as panning by hand. */
const PAN_SLOP_PX = 3;
/** Keys that scroll the focused canvas. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

/** Drag on the empty canvas pans it (nodes are laid out automatically and never move); `onMoved` hears a real drag. */
function usePan(onMoved?: () => void) {
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, input, [data-tg-connector]"))) return;
      const box = event.currentTarget;
      drag.current = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop, moved: false };
      box.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const start = drag.current;
      if (!start) return;
      if (!start.moved && Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > PAN_SLOP_PX) {
        start.moved = true;
        onMoved?.();
      }
      event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
      event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
    },
    onPointerUp: () => {
      drag.current = null;
    },
  };
}

/**
 * The branch map (A8; components.md: 188×60 nodes, 236 between depths, 78
 * between rows, zoom 50–160 %, full width): the client's layered layout of
 * the tree, the path to the current line highlighted, pan by dragging, zoom
 * with the buttons or + − 0 while the map has focus, or with two fingers. Narrow frames (420
 * embedded, phones) do not offer it.
 */
export function BranchMap(props: BranchMapProps) {
  const { branches, rootLineId, currentLineId, mainCount = 0, onEnter, onToggleFullscreen, fullscreen = false, showLeaves = false, relations, fisheye, groups, tags, className } = props;
  const { onSelect, selectedLineId, focusLineId, follow, onManualMove, noteCounts, memoCounts, coveredRight = 0, coveredBottomShare = 0, toolbar, extraLayers = [], overlay, highlighted, chapters, onGoToChapter } = props;
  const t = useUiT();
  const f12 = useF12T();
  const currentId = currentLineId === rootLineId ? null : currentLineId;
  // S3: fitted once when first opened (not focus mode, which follows its own way); cleared by any zoom or pan by hand.
  const [autoFitted, setAutoFitted] = useState(false);
  const onHandMove = () => {
    setAutoFitted(false);
    onManualMove?.();
  };
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => defaultCollapsed(branches, currentId));
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLDivElement>(null);
  const contentWidth = useRef(0);
  const contentHeight = useRef(0);
  const pan = usePan(onHandMove);
  const layout = useMemo(() => buildBranchMapLayout(branches, { collapsed, direction: "horizontal", currentId, metrics: BRANCH_MAP_METRICS }), [branches, collapsed, currentId]);
  const onPath = useMemo(() => pathKeys(currentId, branches), [currentId, branches]);
  const currentKey = currentId ?? MAP_ROOT_KEY;
  const layer = useMapRelationLayer({ relations, layout, rootLineId, canvas, zoom, mainName: t("breadcrumb.main") });
  const selection = useMapSelection(branches, groups?.selection !== undefined);
  const relationRoom = layer.shown ? RELATION_ROOM : 0;
  const grouped = useMemo(() => (groups?.on ? groupFrames(layout, groups.groups, { offsetX: relationRoom }) : null), [groups?.on, groups?.groups, layout, relationRoom]);
  // F9 B.3: two fingers zoom (pan pauses meanwhile); the bounds and the "moved by hand" signal are the buttons'.
  const pinch = useMapPinch({ canvas, zoom, setZoom, clampZoom, onManualMove: onHandMove });
  const focus = useMapFocus({ layout, branches, rootLineId, canvas, zoom, setZoom, clampZoom, currentKey, selectedLineId, focusLineId, follow, coveredRight, coveredBottomShare });

  // Bring the current branch into view when the map opens or the line changes (the main line sits at the start).
  // Focus mode follows instead (useMapFocus), and only while following is on.
  useLayoutEffect(() => {
    const box = canvas.current;
    if (follow !== undefined) return;
    const node = layout.byKey.get(currentKey);
    if (!box || !node || box.clientWidth === 0) return;
    const visible = node.x * zoom + node.width * zoom <= box.clientWidth && node.y * zoom + node.height * zoom <= box.clientHeight;
    box.scrollLeft = visible ? 0 : Math.max(0, node.x * zoom - box.clientWidth / 2);
    box.scrollTop = visible ? 0 : Math.max(0, node.y * zoom - box.clientHeight / 2);
    // Only on a new current line, not on every zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  const fitDone = useRef(false);
  // Decision #10: on first open only — fit when the tree is wider or taller than the canvas; later widening or panning never refits.
  useLayoutEffect(() => {
    const box = canvas.current;
    if (follow !== undefined || fitDone.current || !box) return undefined;
    const tryFit = () => {
      if (fitDone.current || box.clientWidth === 0) return false;
      fitDone.current = true;
      const zoomTo = firstFitZoom({ width: box.clientWidth, height: box.clientHeight }, { width: contentWidth.current, height: contentHeight.current });
      if (zoomTo === null) return true;
      setZoom(zoomTo);
      setAutoFitted(true);
      box.scrollLeft = 0;
      box.scrollTop = 0;
      return true;
    };
    if (tryFit() || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (tryFit()) observer.disconnect();
    });
    observer.observe(box);
    return () => observer.disconnect();
    // Only when the map first opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A zoom by hand also pauses following (focus mode).
  const zoomBy = (step: number) => {
    setAutoFitted(false);
    onManualMove?.();
    setZoom((value) => clampZoom(value + step));
  };
  const fit = () => {
    setAutoFitted(false);
    onManualMove?.();
    const box = canvas.current;
    if (!box || box.clientWidth === 0) return;
    setZoom(clampZoom(Math.min((box.clientWidth - FIT_MARGIN_PX) / width, (box.clientHeight - FIT_MARGIN_PX) / height)));
    box.scrollLeft = 0;
    box.scrollTop = 0;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (layer.onKeyDown(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape" && selection.active) selection.done();
    else if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
    else if (event.key === "-") zoomBy(-ZOOM_STEP);
    else if (event.key === "0") fit();
    else {
      // The canvas scrolls itself with these; that is a move by hand too.
      if (event.target === event.currentTarget && SCROLL_KEYS.has(event.key)) onHandMove();
      return;
    }
    event.preventDefault();
  };
  const toggleFold = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const percent = Math.round(zoom * 100);

  const mainNode = layout.byKey.get(MAP_ROOT_KEY);
  const stages = hasStages(chapters) && onGoToChapter && mainNode ? chapters : null;
  // The stages grow the canvas downwards when they reach below the branches.
  const stagesBottom = stages && mainNode ? chapterStageBoxes(mainNode, stages.length).bottom + BRANCH_MAP_METRICS.padding : 0;
  const width = layout.width + relationRoom + (grouped?.room ?? 0);
  const height = Math.max(grouped?.height ?? layout.height, stagesBottom);
  contentWidth.current = width;
  contentHeight.current = height;
  const layers: MapLayer[] = [
    ...extraLayers,
    ...(tags ? [{ id: "tags" as const, on: tags.on, onChange: tags.onToggle }] : []),
    ...(groups ? [{ id: "groups" as const, on: groups.on, onChange: groups.onToggle }] : []),
    ...(relations ? [{ id: "relations" as const, on: layer.shown, onChange: layer.setShown }] : []),
    ...(fisheye ? [{ id: "fisheye" as const, on: fisheye.on, onChange: fisheye.onToggle }] : []),
  ];
  const levelOf = (key: string) => (fisheye?.on ? (fisheye.levels?.get(key) ?? null) : null);
  const renderNode = (node: MapNode) => (
    <MapNodeView
      key={node.key}
      node={node}
      isCurrent={node.key === currentKey}
      onPath={onPath.has(node.key)}
      mainCount={mainCount}
      showLeaf={showLeaves}
      zoom={zoom}
      // While a relation is being made, choosing a node picks the other end instead of entering it.
      onEnter={() => {
        const lineId = node.key === MAP_ROOT_KEY ? rootLineId : node.key;
        if (layer.choosing) layer.choose(node.key);
        else if (selection.stateOf(node.key) !== undefined) selection.toggle(node.key);
        else if (onSelect) onSelect(lineId);
        else onEnter(lineId);
      }}
      {...(onSelect ? { hereTag: true } : {})}
      // While a relation end or a multi-select is being picked, Enter and double-click pick too (the click path).
      {...(onSelect && !layer.choosing && selection.stateOf(node.key) === undefined ? { onOpen: () => onEnter(node.key === MAP_ROOT_KEY ? rootLineId : node.key) } : {})}
      chosen={focus.selectedKey === node.key}
      dimmed={focus.scope !== null && !focus.scope.has(node.key)}
      noteCount={noteCounts?.get(node.key) ?? 0}
      memoCount={memoCounts?.get(node.key) ?? 0}
      fresh={focus.fresh.has(node.key)}
      glow={highlighted?.has(node.key) ?? false}
      onToggleFold={() => toggleFold(node.key)}
      {...(layer.canLink ? { onConnectStart: (event: PointerEvent<HTMLSpanElement>) => layer.startDrag(node.key, event) } : {})}
      linkRole={layer.roleOf(node.key)}
      fisheyeLevel={levelOf(node.key)}
      mergedInto={node.branch?.mergedIntoLineId ? (layout.byKey.get(node.branch.mergedIntoLineId)?.branch?.purpose ?? "") : undefined}
      selected={selection.stateOf(node.key)}
      showTag={tags?.on ?? false}
    />
  );
  return (
    <div className={cx("flex min-h-0 flex-1 flex-col gap-2", className)}>
      {(layers.length > 0 || groups?.selection || toolbar) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {toolbar}
          {layers.length > 0 && <LayerSwitch layers={layers} />}
          {groups?.selection && <SelectToggle on={selection.active} onChange={selection.setSelecting} />}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={canvas}
          role="group"
          data-tg-map-canvas=""
          aria-label={t("map.label")}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onWheel={onHandMove}
          onPointerDown={(event) => {
            // The drag's own finger never reaches the canvas (startDrag stops it): this is a second one.
            layer.cancelDrag();
            if (pinch.onPointerDown(event)) pan.onPointerUp();
            else pan.onPointerDown(event);
          }}
          onPointerMove={(event) => {
            if (pinch.onPointerMove(event)) return;
            if (!layer.onPointerMove(event)) pan.onPointerMove(event);
          }}
          onPointerUp={(event) => {
            const pinched = pinch.onPointerUp(event);
            if (!pinched) layer.onPointerUp(event);
            pan.onPointerUp();
          }}
          onPointerCancel={(event) => {
            pinch.onPointerUp(event);
            layer.cancelDrag();
            pan.onPointerUp();
          }}
          onClickCapture={pinch.onClickCapture}
          className="relative min-h-0 flex-1 cursor-grab touch-none overflow-auto rounded-tg border border-tg-border bg-tg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring active:cursor-grabbing"
        >
          <div style={{ width: width * zoom, height: height * zoom }}>
            <div className="relative origin-top-left" style={{ width, height, transform: `scale(${zoom})` }}>
              {grouped && <GroupFrameLines frames={grouped.frames} width={width} height={height} />}
              <svg aria-hidden width={layout.width} height={layout.height} className="absolute inset-0 overflow-visible">
                {layout.edges.map((edge) => (
                  <path
                    key={edge.id}
                    d={edge.path}
                    data-on-path={edge.onPath ? "" : undefined}
                    fill="none"
                    strokeWidth={edge.onPath ? 2 : 1.25}
                    className={cx(edge.onPath ? "stroke-tg-primary" : "stroke-tg-border-strong", focus.scope && !focus.scope.has(edge.to) && "opacity-20")}
                  />
                ))}
              </svg>
              {layer.shown && <RelationLines layout={layout} drawn={layer.drawn} suggested={layer.suggested} mode={layer.mode} />}
              {/* The main node comes first, then its stages (F11 §3), then the branches: the Tab order reads down the main line before across. */}
              {layout.nodes.slice(0, 1).map(renderNode)}
              {stages && mainNode && onGoToChapter && <MapStages chapters={stages} main={mainNode} inMap={(lineId) => layout.byKey.has(lineId)} onGo={onGoToChapter} />}
              {layout.nodes.slice(1).map(renderNode)}
              {grouped && <GroupSummaries frames={grouped.frames} />}
              {layer.shown && relations && (
                <RelationNotes
                  layout={layout}
                  drawn={layer.drawn}
                  suggested={layer.suggested}
                  mode={layer.mode}
                  readOnly={relations.readOnly}
                  zoom={zoom}
                  name={layer.name}
                  onCommit={layer.commit}
                  onDelete={layer.deletion.remove}
                  onEditLabel={(relation, label) => layer.editLabel(relation, label)}
                  onAccept={(suggestion) => layer.deletion.run(() => relations.onAccept(suggestion))}
                  onDismiss={(suggestion) => layer.deletion.run(() => relations.onDismiss(suggestion))}
                />
              )}
            </div>
          </div>
        </div>
        {overlay}
      </div>
      {relations && layer.shown && (
        <RelationStatus mode={layer.mode} fromName={layer.fromName} deleted={layer.deletion.deleted !== null} error={layer.deletion.error} onUndo={layer.deletion.undo} />
      )}
      {layer.canLink && layer.mode.kind === "idle" && <RelationHint />}
      {fisheye?.on && <FisheyeLegend />}
      {selection.active && groups?.selection && (
        <div className="flex flex-wrap items-center gap-2 px-0.5">
          <span role="status" className="text-tg-xs text-tg-foreground">
            {t("outline.selected", { count: selection.selected.length })}
          </span>
          {groups.selection(selection.selected, selection.done)}
        </div>
      )}
      <div className="flex items-center gap-1">
        <div className="inline-flex items-center gap-0.5 rounded-tg-sm border border-tg-border bg-tg-surface-raised p-0.5 shadow-tg">
          <IconButton label={t("map.zoomOut")} icon={<ZoomOut />} size="sm" onClick={() => zoomBy(-ZOOM_STEP)} />
          <span role="status" aria-label={t("map.zoom", { percent })} className="min-w-11 text-center font-tg-mono text-tg-xs text-tg-muted">
            {percent}%
          </span>
          <IconButton label={t("map.zoomIn")} icon={<ZoomIn />} size="sm" onClick={() => zoomBy(ZOOM_STEP)} />
          <IconButton label={t("map.fit")} icon={<Scan />} size="sm" onClick={fit} {...(autoFitted ? { className: "bg-tg-primary-soft text-tg-primary-text" } : {})} />
        </div>
        {autoFitted && (
          <span role="status" className="text-tg-xs text-tg-muted">
            {f12("map.autoFitted")}
          </span>
        )}
        <span className="flex-1" />
        {onToggleFullscreen && (
          <IconButton
            label={fullscreen ? t("map.exitFull") : t("map.full")}
            icon={fullscreen ? <Minimize2 /> : <Maximize2 />}
            size="sm"
            pressed={fullscreen}
            onClick={onToggleFullscreen}
            data-tg-map-full=""
          />
        )}
      </div>
    </div>
  );
}
