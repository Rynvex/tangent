/**
 * The reading font (F10 §1): AI answers, excerpts and cards read in the
 * modern sans by default; "serif" sets `data-tg-reading-font="serif"` on
 * <html>, which @tangent/react's styles turn into a book serif. Kept in this
 * browser under its own key and applied at startup, before the first render.
 */
import type { PrefsStorage } from "./prefs";

export const READING_FONTS = ["sans", "serif"] as const;
export type ReadingFont = (typeof READING_FONTS)[number];

export const READING_FONT_KEY = "tg.readingFont";
export const READING_FONT_ATTRIBUTE = "data-tg-reading-font";

/** The stored choice; anything missing, unknown or unreadable is the sans default. */
export function loadReadingFont(storage: PrefsStorage | null): ReadingFont {
  try {
    const stored = storage?.getItem(READING_FONT_KEY);
    return stored === "serif" ? "serif" : "sans";
  } catch {
    return "sans";
  }
}

/** Keeps the choice; when storage refuses, it lasts until the page reloads. */
export function saveReadingFont(storage: PrefsStorage | null, font: ReadingFont): void {
  try {
    storage?.setItem(READING_FONT_KEY, font);
  } catch {
    // Not kept this time.
  }
}

/** Sets the attribute for serif and removes it for the default. */
export function applyReadingFont(element: Element, font: ReadingFont): void {
  if (font === "serif") element.setAttribute(READING_FONT_ATTRIBUTE, "serif");
  else element.removeAttribute(READING_FONT_ATTRIBUTE);
}
