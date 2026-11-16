/**
 * Focus mode's map behaviour (FOCUS_MODE.md §6): keep the current line in
 * view while following, bring the chosen node clear of the floating panel,
 * fit a focused subtree, and fade in nodes that just appeared. Scripted
 * moves never count as the viewer's own (only those pause following).
 */
import { focusScope, MAP_ROOT_KEY, subtreeKeys, type BranchView, type MapLayout, type MapNode } from "@tangent/client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { prefersReducedMotion } from "../lib/motion";

/** How long a new node fades in (§6.1). */
export const NODE_FADE_MS = 600;
/** Room kept around a node or subtree brought into view. */
const MARGIN_PX = 16;
const NONE: ReadonlySet<string> = new Set();

export interface MapFocusOptions {
  layout: MapLayout;
  branches: readonly BranchView[];
  rootLineId: string;
  canvas: RefObject<HTMLDivElement | null>;
  zoom: number;
  /** Sets the zoom (already clamped by the caller's rules). */
  setZoom: (zoom: number) => void;
  clampZoom: (zoom: number) => number;
  currentKey: string;
  selectedLineId: string | null | undefined;
  focusLineId: string | null | undefined;
  /** Undefined outside focus mode: none of this runs. */
  follow: boolean | undefined;
  /** Canvas pixels on the right covered by the floating panel. */
  coveredRight: number;
  /** The share of the canvas's height covered from the bottom (the panel rising from it). */
  coveredBottomShare: number;
}

function scrollBox(box: HTMLElement, left: number, top: number, smooth: boolean) {
  const target = { left: Math.max(0, left), top: Math.max(0, top) };
  if (typeof box.scrollTo === "function") box.scrollTo({ ...target, behavior: smooth ? "smooth" : "auto" });
  else {
    box.scrollLeft = target.left;
    box.scrollTop = target.top;
  }
}

/** Scrolls just enough to show the node in the uncovered part of the canvas; nothing when it already shows. */
function reveal(box: HTMLElement, node: MapNode, zoom: number, coveredRight: number, coveredBottomShare: number) {
  if (box.clientWidth === 0) return;
  const left = node.x * zoom;
  const top = node.y * zoom;
  const width = node.width * zoom;
  const height = node.height * zoom;
  const viewWidth = Math.max(width, box.clientWidth - coveredRight);
  const viewHeight = Math.max(height, box.clientHeight * (1 - coveredBottomShare));
  const inX = left >= box.scrollLeft && left + width <= box.scrollLeft + viewWidth;
  const inY = top >= box.scrollTop && top + height <= box.scrollTop + viewHeight;
  if (inX && inY) return;
  scrollBox(
    box,
    inX ? box.scrollLeft : left - Math.max(MARGIN_PX, (viewWidth - width) / 2),
    inY ? box.scrollTop : top - Math.max(MARGIN_PX, (viewHeight - height) / 2),
    !prefersReducedMotion(),
  );
}

export function useMapFocus(options: MapFocusOptions) {
  const { layout, branches, rootLineId, canvas, zoom, setZoom, clampZoom, currentKey, selectedLineId, focusLineId, follow, coveredRight, coveredBottomShare } = options;
  const active = follow !== undefined;
  const keyOf = (lineId: string) => (lineId === rootLineId ? MAP_ROOT_KEY : lineId);
  const focusKey = active && focusLineId ? keyOf(focusLineId) : null;
  const selectedKey = active && selectedLineId ? keyOf(selectedLineId) : null;
  const scope = useMemo(() => (focusKey ? focusScope(focusKey, branches) : null), [focusKey, branches]);
  // The latest values for effects that run on other changes.
  const latest = useRef({ layout, zoom, coveredRight, coveredBottomShare });
  latest.current = { layout, zoom, coveredRight, coveredBottomShare };
  const revealKey = (key: string) => {
    const box = canvas.current;
    const node = latest.current.layout.byKey.get(key);
    if (box && node) reveal(box, node, latest.current.zoom, latest.current.coveredRight, latest.current.coveredBottomShare);
  };

  // 跟隨: the current line (also once it appears on the map, and when following resumes).
  useEffect(() => {
    if (follow) revealKey(currentKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, currentKey, layout]);

  // The chosen node is brought clear of the panel; choosing never pauses following.
  useEffect(() => {
    if (selectedKey) revealKey(selectedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  // Focusing a subtree fits it (the subtree, not the way up; at most 100 %), then scrolls to its corner once the new zoom is drawn.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const box = canvas.current;
    if (!focusKey || !box || box.clientWidth === 0) return;
    const subtree = subtreeKeys(focusKey, branches);
    const nodes = latest.current.layout.nodes.filter((node) => subtree.has(node.key));
    if (nodes.length === 0) return;
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const spanX = Math.max(...nodes.map((node) => node.x + node.width)) - minX;
    const spanY = Math.max(...nodes.map((node) => node.y + node.height)) - minY;
    const fitted = clampZoom(Math.min(1, (box.clientWidth - latest.current.coveredRight - 2 * MARGIN_PX) / spanX, (box.clientHeight - 2 * MARGIN_PX) / spanY));
    const target = { left: minX * fitted - MARGIN_PX, top: minY * fitted - MARGIN_PX };
    if (fitted === latest.current.zoom) scrollBox(box, target.left, target.top, false);
    else {
      pendingScroll.current = target;
      setZoom(fitted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);
  useLayoutEffect(() => {
    const target = pendingScroll.current;
    const box = canvas.current;
    if (!target || !box) return;
    pendingScroll.current = null;
    scrollBox(box, target.left, target.top, false);
  }, [zoom, canvas]);

  // New nodes fade in once (not on the first drawing).
  const known = useRef<ReadonlySet<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    const keys = new Set(layout.nodes.map((node) => node.key));
    const before = known.current;
    known.current = keys;
    if (!active || !before) return;
    const added = [...keys].filter((key) => !before.has(key));
    if (added.length > 0) setFresh(new Set(added));
  }, [layout, active]);
  useEffect(() => {
    if (fresh.size === 0) return;
    const timer = setTimeout(() => setFresh(NONE), NODE_FADE_MS);
    return () => clearTimeout(timer);
  }, [fresh]);

  return { scope, selectedKey, fresh };
}
