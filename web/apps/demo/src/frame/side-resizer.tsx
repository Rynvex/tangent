import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useF12ShellT } from "./f12-shell-messages";

/** S3: the side panel's width bounds and steps (decision #9: the conversation keeps 480 px). */
export const SIDE_WIDTH = { min: 280, max: 600, initial: 360, step: 16, bigStep: 64, conversationMin: 480 } as const;
const STORAGE_KEY = "tangent:side-width:v1";
const PERSIST_DELAY_MS = 150;

/** S2: the conversation list's width bounds and steps. */
export const LIST_WIDTH = { min: 200, max: 560, initial: 264, step: 16, bigStep: 64, conversationMin: 480 } as const;
const LIST_STORAGE_KEY = "tangent:list-width:v1";

/** The widest the list column may be in this window: min(560, window − 480), never under the minimum. */
export function listWidthMax(viewport: number): number {
  return Math.max(LIST_WIDTH.min, Math.min(LIST_WIDTH.max, viewport - LIST_WIDTH.conversationMin));
}

export function clampListWidth(width: number, max: number): number {
  return Math.round(Math.min(max, Math.max(LIST_WIDTH.min, width)));
}

/** The widest the panel may be in this window: min(600, window − list − 480), never under the minimum. */
export function sideWidthMax(viewport: number, listWidth: number): number {
  return Math.max(SIDE_WIDTH.min, Math.min(SIDE_WIDTH.max, viewport - listWidth - SIDE_WIDTH.conversationMin));
}

export function clampSideWidth(width: number, max: number): number {
  return Math.round(Math.min(max, Math.max(SIDE_WIDTH.min, width)));
}

function readStored(): number {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : SIDE_WIDTH.initial;
  } catch {
    return SIDE_WIDTH.initial;
  }
}

/** The width the user chose, kept in localStorage (the same for every conversation); storage may be blocked. */
export function useSideWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(readStored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const save = useCallback((next: number) => {
    setWidth(next);
    // Written once the width rests (a drag moves it many times).
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Blocked storage: the width holds until the page reloads.
      }
    }, PERSIST_DELAY_MS);
  }, []);
  return [width, save];
}

/** The width a key gives (null for other keys): ← wider, → narrower (the panel is on the right), Home / End the bounds, Enter the default. */
export function widthForKey(key: string, shift: boolean, width: number, max: number): number | null {
  const step = shift ? SIDE_WIDTH.bigStep : SIDE_WIDTH.step;
  switch (key) {
    case "ArrowLeft":
      return clampSideWidth(width + step, max);
    case "ArrowRight":
      return clampSideWidth(width - step, max);
    case "Home":
      return SIDE_WIDTH.min;
    case "End":
      return max;
    case "Enter":
      return clampSideWidth(SIDE_WIDTH.initial, max);
    default:
      return null;
  }
}

export interface SidePanelResizerProps {
  width: number;
  max: number;
  viewport: number;
  onChange: (width: number) => void;
}

/**
 * S3 SidePanelResizer (demo): a 6px separator on the panel's left edge.
 * Hover, focus and dragging show a 2px primary line and a 12×36 grip, with a
 * hint (拖拉調整寬度・雙擊重設為 360; the width while dragging; why it stops at
 * a bound). Keys: ← → 16px, with Shift 64px, Home / End, Enter resets.
 */
export function SidePanelResizer({ width, max, viewport, onChange }: SidePanelResizerProps) {
  const t = useF12ShellT();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [lit, setLit] = useState(false);
  const atMax = width >= max;
  const atMin = width <= SIDE_WIDTH.min;
  const hint = dragging
    ? t("side.width", { w: width })
    : atMax && max < SIDE_WIDTH.max
      ? t("side.maxWidth", { vw: viewport, max })
      : atMin && lit
        ? t("side.minWidth", { min: SIDE_WIDTH.min })
        : t("side.resizeHint", { w: SIDE_WIDTH.initial });
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    onChange(clampSideWidth(start.width + (start.x - event.clientX), max));
  };
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = widthForKey(event.key, event.shiftKey, width, max);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };
  const shown = lit || dragging;
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("side.resize")}
      aria-valuemin={SIDE_WIDTH.min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={t("side.width", { w: width })}
      data-tg-side-resizer=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(clampSideWidth(SIDE_WIDTH.initial, max))}
      onKeyDown={onKeyDown}
      onPointerEnter={() => setLit(true)}
      onPointerLeave={() => setLit(false)}
      onFocus={() => setLit(true)}
      onBlur={() => setLit(false)}
      className="group absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize touch-none outline-none"
    >
      <span aria-hidden className={shown ? "absolute inset-y-0 left-0 w-0.5 bg-tg-primary" : "absolute inset-y-0 left-0 w-px bg-transparent"} />
      {shown && (
        <>
          <span aria-hidden className="absolute top-1/2 left-0.5 flex h-9 w-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-tg-sm border border-tg-primary bg-tg-surface text-tg-primary-text group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-tg-ring">
            <GripVertical className="size-3" />
          </span>
          <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 max-w-60 translate-y-4 rounded-tg-sm bg-tg-foreground-strong px-2 py-1 text-tg-xs whitespace-normal text-tg-background shadow-tg-overlay">
            {hint}
          </span>
        </>
      )}
    </div>
  );
}

/** The width a key gives the list column: → wider, ← narrower, Home / End the bounds, Enter the default. */
export function listWidthForKey(key: string, shift: boolean, width: number, max: number): number | null {
  const step = shift ? LIST_WIDTH.bigStep : LIST_WIDTH.step;
  switch (key) {
    case "ArrowRight":
      return clampListWidth(width + step, max);
    case "ArrowLeft":
      return clampListWidth(width - step, max);
    case "Home":
      return LIST_WIDTH.min;
    case "End":
      return max;
    case "Enter":
      return clampListWidth(LIST_WIDTH.initial, max);
    default:
      return null;
  }
}

function readListStored(): number {
  try {
    const value = Number(window.localStorage.getItem(LIST_STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : LIST_WIDTH.initial;
  } catch {
    return LIST_WIDTH.initial;
  }
}

/** The list column's width chosen by the user, remembered across reloads. */
export function useListWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(readListStored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const save = useCallback((next: number) => {
    setWidth(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(LIST_STORAGE_KEY, String(next));
      } catch {
        // Blocked storage
      }
    }, PERSIST_DELAY_MS);
  }, []);
  return [width, save];
}

export interface ListResizerProps {
  width: number;
  max: number;
  viewport: number;
  onChange: (width: number) => void;
}

/** Resizer on the conversation list column's right edge. */
export function ListResizer({ width, max, viewport, onChange }: ListResizerProps) {
  const t = useF12ShellT();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [lit, setLit] = useState(false);
  const atMax = width >= max;
  const atMin = width <= LIST_WIDTH.min;
  const hint = dragging
    ? t("side.width", { w: width })
    : atMax && max < LIST_WIDTH.max
      ? t("list.maxWidth", { vw: viewport, max })
      : atMin && lit
        ? t("list.minWidth", { min: LIST_WIDTH.min })
        : t("list.resizeHint", { w: LIST_WIDTH.initial });
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    onChange(clampListWidth(start.width + (event.clientX - start.x), max));
  };
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = listWidthForKey(event.key, event.shiftKey, width, max);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };
  const shown = lit || dragging;
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("list.resize")}
      aria-valuemin={LIST_WIDTH.min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={t("side.width", { w: width })}
      data-tg-list-resizer=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(clampListWidth(LIST_WIDTH.initial, max))}
      onKeyDown={onKeyDown}
      onPointerEnter={() => setLit(true)}
      onPointerLeave={() => setLit(false)}
      onFocus={() => setLit(true)}
      onBlur={() => setLit(false)}
      className="group absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none outline-none"
    >
      <span aria-hidden className={shown ? "absolute inset-y-0 right-0 w-0.5 bg-tg-primary" : "absolute inset-y-0 right-0 w-px bg-transparent"} />
      {shown && (
        <>
          <span aria-hidden className="absolute top-1/2 right-0.5 flex h-9 w-3 translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-tg-sm border border-tg-primary bg-tg-surface text-tg-primary-text group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-tg-ring">
            <GripVertical className="size-3" />
          </span>
          <span aria-hidden className="pointer-events-none absolute top-1/2 right-3 max-w-60 translate-y-4 rounded-tg-sm bg-tg-foreground-strong px-2 py-1 text-tg-xs whitespace-normal text-tg-background shadow-tg-overlay">
            {hint}
          </span>
        </>
      )}
    </div>
  );
}
