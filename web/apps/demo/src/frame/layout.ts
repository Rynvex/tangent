/**
 * The demo's width rules (handoff components.md, 寬度規則). Pure, so the
 * thresholds are tested without a browser.
 */
export type ListMode = "column" | "rail" | "drawer" | "none";
export type SideMode = "column" | "overlay" | "sheet";
export type Frame = "app" | "embed";

export interface FrameLayout {
  /** Conversation list: 264px column, 56px icon rail, a drawer behind a button, or absent (embedded). */
  list: ListMode;
  side: SideMode;
  /** The side panel starts open only where it is a column. */
  sideOpenByDefault: boolean;
  /** Narrow frames open the outline from a header button instead of the panel toggle. */
  narrow: boolean;
}

export const BREAKPOINTS = { full: 1280, laptop: 1100, tablet: 1024, portrait: 768 } as const;

/** Focus mode (FOCUS_MODE.md §4.1): chat and map side by side from 1024 up, one at a time below it and embedded. */
export type FocusLayout = "split" | "tabs";

export function focusLayoutFor(width: number, frame: Frame): FocusLayout {
  return frame === "embed" || width < BREAKPOINTS.tablet ? "tabs" : "split";
}

export function layoutFor(width: number, frame: Frame): FrameLayout {
  if (frame === "embed") return { list: "none", side: "overlay", sideOpenByDefault: false, narrow: true };
  if (width >= BREAKPOINTS.full) return { list: "column", side: "column", sideOpenByDefault: true, narrow: false };
  if (width >= BREAKPOINTS.laptop) return { list: "rail", side: "column", sideOpenByDefault: true, narrow: false };
  if (width >= BREAKPOINTS.tablet) return { list: "rail", side: "overlay", sideOpenByDefault: false, narrow: false };
  if (width >= BREAKPOINTS.portrait) return { list: "drawer", side: "overlay", sideOpenByDefault: false, narrow: false };
  return { list: "drawer", side: "sheet", sideOpenByDefault: false, narrow: true };
}
