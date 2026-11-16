/**
 * Focus mode's split (FOCUS_MODE.md §4.2) as pure functions: the default
 * share, the minimum widths, the separator's keys, where the node panel
 * goes, and the order F6 walks the regions in.
 */

/** The chat never gets narrower than this, the map never narrower than MAP_MIN_PX. */
export const CHAT_MIN_PX = 420;
export const MAP_MIN_PX = 360;
/** Below this map width the node panel rises from the map's bottom instead of floating beside it. */
export const PANEL_FLOAT_MIN_PX = 640;
/** The floating panel's width and the gap kept around it. */
export const PANEL_WIDTH_PX = 320;
export const PANEL_GAP_PX = 12;
/** The panel rising from the map's bottom takes this share of its height. */
export const PANEL_BOTTOM_SHARE = 0.6;
/** ←/→ on the separator move it by this share. */
export const SPLIT_STEP = 0.05;
/** Below this window width the split starts at 45:55, so a 1280 window keeps ≥ 640 px of map (design review 2026-10-24). */
const WIDE_WINDOW_PX = 1440;

export function defaultChatShare(windowWidth: number): number {
  return windowWidth < WIDE_WINDOW_PX ? 0.45 : 0.5;
}

/** The chat's width for a share of `total`, kept within both minimums (the chat wins when they cannot both fit). */
export function chatWidth(total: number, share: number): number {
  const wanted = Math.round(total * share);
  return Math.max(CHAT_MIN_PX, Math.min(wanted, total - MAP_MIN_PX));
}

/** Which minimum a width sits at, for the hint by the handle. */
export function limitOf(total: number, chat: number): "chat" | "map" | null {
  if (chat <= CHAT_MIN_PX) return "chat";
  if (total - chat <= MAP_MIN_PX) return "map";
  return null;
}

/** The separator's keys (role="separator"): ←/→ by 5 %, Home/End to either minimum; null for other keys. */
export function shareForKey(key: string, share: number, total: number): number | null {
  const lowest = CHAT_MIN_PX / total;
  const highest = (total - MAP_MIN_PX) / total;
  const clamp = (value: number) => Math.min(highest, Math.max(lowest, value));
  switch (key) {
    case "ArrowLeft":
      return clamp(share - SPLIT_STEP);
    case "ArrowRight":
      return clamp(share + SPLIT_STEP);
    case "Home":
      return lowest;
    case "End":
      return highest;
    default:
      return null;
  }
}

export function panelPlacement(mapWidth: number): "float" | "bottom" {
  return mapWidth >= PANEL_FLOAT_MIN_PX ? "float" : "bottom";
}

/** F6 / ⇧F6: the next region after `current` (-1 when focus is in none of them), wrapping around. */
export function nextRegion(count: number, current: number, backwards: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? count - 1 : 1)) % count;
}
