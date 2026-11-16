// Markdown renderer component). Tangent
// has no uploads, so no image ever loads (see SafeImage in markdown-impl.tsx).
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Returns the href when it is an absolute http(s) or mailto URL, otherwise
 * null. `new URL` strips the tab/newline tricks (`java\tscript:`) browsers
 * accept, so the protocol check sees what the browser would see.
 */
export function safeHref(href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim());
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
