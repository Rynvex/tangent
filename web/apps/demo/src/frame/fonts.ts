/**
 * How the demo loads @tangent/fonts (F0 review M13):
 * - `latin.css` and `serif.css` are imported eagerly by main.tsx (UI text and
 *   AI answers; their CJK serif slices only download for glyphs on screen).
 * - `tc.css` (IBM Plex Sans TC + Noto Sans TC, the largest @font-face list) is
 *   loaded on demand: at once when the locale is Chinese, otherwise the first
 *   time CJK text appears in the page (a MutationObserver that disconnects
 *   after it fires). Until then CJK text renders in the system fallback.
 * - `host.css` (Geist) only for the host theme.
 * Dynamic `import()` of CSS makes Vite emit separate stylesheets that are not
 * render-blocking.
 */
import type { TangentTheme } from "@tangent/react";

/** CJK ideographs, kana, bopomofo and full-width punctuation. */
const CJK = /[　-〿㄀-ㄯ㐀-䶿一-鿿豈-﫿＀-￯]/;

let tcLoaded = false;

function loadTc(): void {
  if (tcLoaded) return;
  tcLoaded = true;
  void import("@tangent/fonts/tc.css");
}

export function loadFontsOnDemand(locale: string, theme: TangentTheme): void {
  if (theme === "host") void import("@tangent/fonts/host.css");
  if (/^zh|^ja/i.test(locale)) return loadTc();
  if (CJK.test(document.body.textContent ?? "")) return loadTc();
  const observer = new MutationObserver(() => {
    if (!CJK.test(document.body.textContent ?? "")) return;
    observer.disconnect();
    loadTc();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
