/**
 * F17 S2/S3: the canvas' legend (bottom left) and its controls (bottom
 * right on a desktop, a 44px row above the canvas on a phone): 顯示穿插順序
 * #a→#b (Route; off without interleaved turns), 縮小, the zoom in percent,
 * 放大 and 置中適應.
 */
import { CornerDownRight, Route, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useId } from "react";
import { cx } from "../cx";
import { useF17T } from "./f17-messages";
import { ZOOM_MAX, ZOOM_MIN, type MindMap } from "./use-mindmap";

export function Legend({ trace }: { trace: boolean }) {
  const t = useF17T();
  const item = "inline-flex items-center gap-1.5 whitespace-nowrap";
  return (
    <div role="group" aria-label={t("map.legend")} className="absolute bottom-3 left-3 z-20 flex items-center gap-3 rounded-tg border border-tg-border bg-tg-surface-raised px-2.5 py-1.5 text-[0.6875rem] text-tg-foreground">
      <span className={item}>
        <span aria-hidden className="inline-flex h-4 items-center rounded-[4px] bg-tg-primary px-1 font-tg-mono text-[0.625rem] text-tg-primary-foreground">
          §
        </span>
        {t("map.legendChapter")}
      </span>
      <span className={item}>
        <CornerDownRight aria-hidden className="size-3 text-tg-branch-merged" />
        {t("map.legendBranch")}
      </span>
      <span className={item}>
        <span aria-hidden className="h-2.5 w-3.5 rounded-[3px] border-[1.5px] border-dashed border-tg-border-strong" />
        {t("map.legendSolo")}
      </span>
      {trace && (
        <span className={item}>
          <span aria-hidden className="w-4 border-t-2 border-dashed border-tg-warning" />
          {t("map.legendTrace")}
        </span>
      )}
    </div>
  );
}

export interface ControlsProps {
  map: MindMap;
  touch: boolean;
  onFit: () => void;
}

export function Controls({ map, touch, onFit }: ControlsProps) {
  const t = useF17T();
  const reasonId = useId();
  const range = map.layout.trace.range;
  const size = touch ? "size-11" : "size-7";
  const button = cx("grid shrink-0 place-items-center rounded-tg-sm text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring disabled:opacity-45", size);
  const percent = Math.round(map.zoom * 100);
  return (
    <div
      role="toolbar"
      aria-label={t("map.controls")}
      className={cx("flex items-center gap-0.5", touch ? "shrink-0 justify-end border-b border-tg-border bg-tg-surface-sunken px-1" : "absolute right-3 bottom-3 z-20 rounded-tg border border-tg-border bg-tg-surface-raised p-0.5")}
    >
      <button
        type="button"
        data-tg-mindmap-trace-toggle=""
        aria-pressed={map.trace}
        aria-disabled={!map.canTrace || undefined}
        aria-describedby={map.canTrace ? undefined : reasonId}
        aria-label={touch ? t("map.trace") : undefined}
        onClick={() => map.canTrace && map.toggleTrace()}
        className={cx(
          "inline-flex shrink-0 items-center gap-1.5 rounded-tg-sm text-tg-xs font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-tg-ring aria-disabled:opacity-45",
          touch ? "size-11 justify-center" : "h-7 px-2",
          map.trace ? "bg-tg-warning-soft text-tg-foreground-strong" : "text-tg-muted hover:bg-tg-accent hover:text-tg-foreground",
        )}
      >
        <Route aria-hidden className="size-3.5" />
        {!touch && (
          <>
            {t("map.trace")}
            {range && <span className="font-tg-mono">{`#${range[0]}→#${range[1]}`}</span>}
          </>
        )}
      </button>
      <span id={reasonId} className="sr-only">
        {map.canTrace ? "" : t("map.traceOff")}
      </span>
      {!touch && <span aria-hidden className="mx-1 h-4.5 w-px bg-tg-border" />}
      <button type="button" aria-label={t("map.zoomOut")} disabled={map.zoom <= ZOOM_MIN} onClick={map.zoomOut} className={button}>
        <ZoomOut aria-hidden className="size-3.5" />
      </button>
      <output aria-live="polite" aria-label={t("map.zoomLevel", { n: percent })} data-tg-mindmap-zoom="" className="min-w-10 text-center font-tg-mono text-tg-xs text-tg-muted">
        {percent}%
      </output>
      <button type="button" aria-label={t("map.zoomIn")} disabled={map.zoom >= ZOOM_MAX} onClick={map.zoomIn} className={button}>
        <ZoomIn aria-hidden className="size-3.5" />
      </button>
      <button type="button" aria-label={touch ? t("map.fit") : undefined} onClick={onFit} className={touch ? button : "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-tg-sm px-2 text-tg-xs whitespace-nowrap text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring"}>
        <Scan aria-hidden className="size-3.5" />
        {!touch && t("map.fit")}
      </button>
    </div>
  );
}
