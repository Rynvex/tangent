import { useLayoutEffect, useRef, type PointerEvent, type RefObject } from "react";

/** A point in client (viewport) pixels. */
export interface ClientPoint {
  x: number;
  y: number;
}

/** What a pinch keeps from its start: the zoom then, the fingers' distance then, and the map point under their midpoint. */
export interface PinchStart {
  zoom: number;
  distance: number;
  /** The midpoint's place on the unscaled map (map pixels). */
  anchor: ClientPoint;
}

export const pinchDistance = (a: ClientPoint, b: ClientPoint) => Math.hypot(a.x - b.x, a.y - b.y);
export const pinchMidpoint = (a: ClientPoint, b: ClientPoint): ClientPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * One pinch step, pure: the new zoom (the start zoom scaled by how far the
 * fingers spread, clamped) and the scroll that keeps the start's map point
 * under the fingers' midpoint now. `origin` is the canvas's top-left in
 * client pixels.
 */
export function pinchStep(start: PinchStart, midpoint: ClientPoint, distance: number, origin: ClientPoint, clampZoom: (zoom: number) => number): { zoom: number; left: number; top: number } {
  const zoom = clampZoom(start.distance > 0 ? start.zoom * (distance / start.distance) : start.zoom);
  return {
    zoom,
    left: Math.max(0, start.anchor.x * zoom - (midpoint.x - origin.x)),
    top: Math.max(0, start.anchor.y * zoom - (midpoint.y - origin.y)),
  };
}

export interface MapPinchInput {
  canvas: RefObject<HTMLDivElement | null>;
  zoom: number;
  setZoom: (zoom: number) => void;
  clampZoom: (zoom: number) => number;
  /** A pinch is a move by hand (focus mode pauses following). */
  onManualMove?: (() => void) | undefined;
}

/** How long after a pinch a tap's click is swallowed (the lifting finger must not press a node). */
const CLICK_AFTER_PINCH_MS = 350;

/**
 * Two-finger pinch on the map's canvas (F9 B.3): with exactly two pointers
 * down the canvas zooms by how far they spread (within the map's bounds),
 * keeping the map point between them under them, and one-finger panning
 * pauses until both are lifted. Handlers return true when they took the
 * event, so the canvas's own pan and link handlers leave it alone.
 */
export function useMapPinch({ canvas, zoom, setZoom, clampZoom, onManualMove }: MapPinchInput) {
  const pointers = useRef(new Map<number, ClientPoint>());
  const start = useRef<PinchStart | null>(null);
  const zoomNow = useRef(zoom);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const swallowUntil = useRef(0);
  zoomNow.current = zoom;

  // The new size is laid out first; then the scroll that keeps the midpoint in place.
  useLayoutEffect(() => {
    const box = canvas.current;
    const scroll = pendingScroll.current;
    if (!box || !scroll) return;
    pendingScroll.current = null;
    box.scrollLeft = scroll.left;
    box.scrollTop = scroll.top;
  }, [zoom, canvas]);

  const origin = (box: HTMLElement): ClientPoint => {
    const rect = box.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  };

  const begin = (box: HTMLElement) => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    const mid = pinchMidpoint(a, b);
    const at = origin(box);
    const current = zoomNow.current;
    start.current = { zoom: current, distance: pinchDistance(a, b), anchor: { x: (box.scrollLeft + mid.x - at.x) / current, y: (box.scrollTop + mid.y - at.y) / current } };
    onManualMove?.();
  };

  return {
    /** True while two fingers pinch. */
    pinching: () => start.current !== null,
    onPointerDown: (event: PointerEvent<HTMLDivElement>): boolean => {
      // A mouse never pinches; a gesture's first finger forgets any finger lifted outside the canvas.
      if (event.pointerType === "mouse") return false;
      if (event.isPrimary) {
        pointers.current.clear();
        start.current = null;
      }
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size < 2) return start.current !== null;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      // Two fingers start a pinch; a third re-anchors it on the first two (begin reads those).
      begin(event.currentTarget);
      return true;
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>): boolean => {
      if (!pointers.current.has(event.pointerId)) return false;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pinch = start.current;
      if (!pinch) return false;
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return true;
      const next = pinchStep(pinch, pinchMidpoint(a, b), pinchDistance(a, b), origin(event.currentTarget), clampZoom);
      if (next.zoom === zoomNow.current) {
        event.currentTarget.scrollLeft = next.left;
        event.currentTarget.scrollTop = next.top;
      } else {
        pendingScroll.current = { left: next.left, top: next.top };
        setZoom(next.zoom);
      }
      return true;
    },
    /**
     * pointerup and pointercancel: with fewer than two fingers left the pinch
     * ends (the other one does not start panning); with two or more it goes
     * on from where the remaining fingers are.
     */
    onPointerUp: (event: PointerEvent<HTMLDivElement>): boolean => {
      pointers.current.delete(event.pointerId);
      const was = start.current !== null;
      if (!was) return false;
      if (pointers.current.size >= 2) {
        begin(event.currentTarget);
        return true;
      }
      start.current = null;
      pendingScroll.current = null;
      swallowUntil.current = Date.now() + CLICK_AFTER_PINCH_MS;
      return true;
    },
    /** A click right after a pinch (a lifting finger on a node) is not a press. */
    onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      if (Date.now() >= swallowUntil.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
