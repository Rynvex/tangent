/**
 * F16.1: a scrolling column follows a drag held near its top or bottom edge
 * (closer is faster), so a long list can be crossed without letting go.
 * One requestAnimationFrame loop per column: dragover (fired every few
 * milliseconds) only reads the pointer and the box, the frame only scrolls;
 * it stops when the drag leaves the edge, ends, or has not been seen for a
 * moment.
 */
import { useEffect, useRef, type DragEvent, type RefObject } from "react";

/** Within this distance (px) of an edge the column scrolls. */
export const AUTOSCROLL_EDGE_PX = 48;
/** The fastest scroll, at the very edge (px per frame). */
const MAX_SPEED_PX = 18;
/** A drag not seen over the column for this long stops the scroll (it left, or was dropped elsewhere). */
const STALE_MS = 120;

/** The scroll speed for a pointer at `y` in a box from `top` to `bottom`: negative up, positive down, 0 away from the edges. */
export function edgeSpeed(y: number, top: number, bottom: number, edge = AUTOSCROLL_EDGE_PX, max = MAX_SPEED_PX): number {
  if (bottom - top <= edge * 2) return 0;
  const fromTop = y - top;
  const fromBottom = bottom - y;
  if (fromTop >= 0 && fromTop < edge) return -Math.ceil(max * (1 - fromTop / edge));
  if (fromBottom >= 0 && fromBottom < edge) return Math.ceil(max * (1 - fromBottom / edge));
  return 0;
}

export function useDragAutoscroll<T extends HTMLElement>(): { ref: RefObject<T | null>; onDragOver: (event: DragEvent<T>) => void } {
  const ref = useRef<T | null>(null);
  const speed = useRef(0);
  const seen = useRef(0);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const tick = () => {
    const box = ref.current;
    if (!box || speed.current === 0 || performance.now() - seen.current > STALE_MS) {
      frame.current = 0;
      return;
    }
    box.scrollTop += speed.current;
    frame.current = requestAnimationFrame(tick);
  };
  const onDragOver = (event: DragEvent<T>) => {
    const box = ref.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    speed.current = edgeSpeed(event.clientY, rect.top, rect.bottom);
    seen.current = performance.now();
    if (speed.current !== 0 && frame.current === 0) frame.current = requestAnimationFrame(tick);
  };
  return { ref, onDragOver };
}
