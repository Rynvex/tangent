/**
 * Outlines a range of messages in the transcript (F13 S3, S4): while the
 * extract dialog is open, or a detour card of the decompose panel is hovered
 * or focused, the messages it would move get a `--tg-primary` outline and,
 * with `dim`, the rest of the line steps back. A scoped style rule on the
 * rows' `data-tg-message` ids; nothing in the transcript re-renders.
 */
export interface RangeHighlightProps {
  messageIds: readonly string[];
  /** Fade the other messages of the line (the dialog's state). */
  dim?: boolean;
}

const escapeId = (id: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&"));

export function rangeHighlightCss(messageIds: readonly string[], dim = false): string {
  if (messageIds.length === 0) return "";
  const selectors = messageIds.map((id) => `[data-tg-root] [data-tg-message="${escapeId(id)}"]`).join(",\n");
  const outlined = `${selectors} {\n  outline: 2px solid var(--tg-primary);\n  outline-offset: 4px;\n  border-radius: var(--tg-radius);\n}`;
  if (!dim) return outlined;
  const others = `[data-tg-root] [data-tg-message]:not(${messageIds.map((id) => `[data-tg-message="${escapeId(id)}"]`).join(", ")}) {\n  opacity: 0.4;\n}`;
  return `${outlined}\n${others}`;
}

export function RangeHighlight({ messageIds, dim = false }: RangeHighlightProps) {
  const css = rangeHighlightCss(messageIds, dim);
  return css ? <style data-tg-range-highlight="">{css}</style> : null;
}
