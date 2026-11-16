/**
 * Focus mode's remembered settings (FOCUS_MODE.md §5): whether it is on, the
 * split, following and the notes layer, kept in this browser. Anything
 * missing, malformed or unreadable falls back to the default.
 */
import type { PrefsStorage } from "./prefs";

export interface FocusPrefs {
  on: boolean;
  /** The chat's share of the split (0–1); null: the default for the window's width. */
  chatShare: number | null;
  follow: boolean;
  notesLayer: boolean;
}

export const DEFAULT_FOCUS_PREFS: FocusPrefs = { on: false, chatShare: null, follow: true, notesLayer: true };

const KEY = "tangent-demo.focus";

export function loadFocusPrefs(storage: PrefsStorage | null): FocusPrefs {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return DEFAULT_FOCUS_PREFS;
    const { on, chatShare, follow, notesLayer } = raw as Record<string, unknown>;
    const share = typeof chatShare === "number" && chatShare > 0 && chatShare < 1 ? chatShare : null;
    return {
      on: typeof on === "boolean" ? on : DEFAULT_FOCUS_PREFS.on,
      chatShare: share,
      follow: typeof follow === "boolean" ? follow : DEFAULT_FOCUS_PREFS.follow,
      notesLayer: typeof notesLayer === "boolean" ? notesLayer : DEFAULT_FOCUS_PREFS.notesLayer,
    };
  } catch {
    return DEFAULT_FOCUS_PREFS;
  }
}

/** Keeps the settings; when storage refuses, they last until the page reloads. */
export function saveFocusPrefs(storage: PrefsStorage | null, prefs: FocusPrefs): void {
  try {
    storage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not kept this time.
  }
}
