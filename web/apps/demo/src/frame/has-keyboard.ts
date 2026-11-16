/**
 * Decision #12 (F8 S4): whether 快捷鍵說明 is worth offering — not on a
 * touch-only device until a physical key is pressed. Its own module, so the
 * frame (main bundle) reads it without the shortcut list's tables.
 */
import { useSyncExternalStore } from "react";

/** What decision #12 reads from the page. */
export interface KeyboardWindow {
  matchMedia?: (query: string) => { matches: boolean };
}

/** True unless the only pointer is coarse (touch) and no physical key has been pressed yet. */
export function shortcutsHelpAvailable(win: KeyboardWindow | undefined, keyboardSeen: boolean): boolean {
  if (keyboardSeen) return true;
  const coarse = win?.matchMedia?.("(pointer: coarse)").matches ?? false;
  return !coarse;
}

/** A key from a hardware keyboard: an on-screen keyboard reports `Unidentified` or the IME code 229. */
export function isPhysicalKey(event: { key: string; keyCode?: number }): boolean {
  return event.key !== "Unidentified" && event.key !== "" && event.keyCode !== 229;
}

let keyboardSeen = false;
const listeners = new Set<() => void>();

function subscribeKeyboard(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined" || keyboardSeen) return () => listeners.delete(listener);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isPhysicalKey(event)) return;
    keyboardSeen = true;
    for (const each of listeners) each();
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => {
    listeners.delete(listener);
    window.removeEventListener("keydown", onKeyDown, { capture: true });
  };
}

const availableNow = () => shortcutsHelpAvailable(typeof window === "undefined" ? undefined : window, keyboardSeen);

/**
 * Whether to offer 快捷鍵說明 (its `?` key, the menu and palette entries):
 * not on a touch-only device until a physical key is pressed (decision #12).
 */
export function useHasKeyboard(): boolean {
  return useSyncExternalStore(subscribeKeyboard, availableNow, () => true);
}

/** Tests only: forget the keys seen so far. */
export function resetKeyboardSeen(): void {
  keyboardSeen = false;
}
