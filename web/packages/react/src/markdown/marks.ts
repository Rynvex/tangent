/**
 * F12 S2: wraps the first appearance of each mark's text in a
 * `<span data-tg-mark="i">` (a rehype step), skipping code, preformatted
 * text, links and math. A mark split across formatting (bold, a link) is not
 * found and stays unmarked, as the design asks ("找不到原文就不標").
 */
import type { Element, ElementContent, Root, Text } from "hast";
import type { MarkdownMark, MarkRange, MarkScanner } from "./markdown-props";

const SKIP = new Set(["pre", "code", "a", "kbd", "samp"]);
const MARK_PROPERTY = "dataTgMark";
/** A span a scan made: its property holds the mark's key. */
const SCAN_PROPERTY = "dataTgScan";

function isSkipped(node: Element): boolean {
  if (SKIP.has(node.tagName)) return true;
  if (node.properties?.[MARK_PROPERTY] !== undefined || node.properties?.[SCAN_PROPERTY] !== undefined) return true;
  const classes = node.properties?.className;
  return Array.isArray(classes) && classes.some((name) => String(name).startsWith("math") || String(name).startsWith("language-math"));
}

/** Splits the first text node under `parent` that holds `text`; true when it marked one. */
function markIn(parent: Root | Element, text: string, index: number): boolean {
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children[i] as ElementContent;
    if (child.type === "element") {
      if (!isSkipped(child) && markIn(child, text, index)) return true;
      continue;
    }
    if (child.type !== "text") continue;
    const at = child.value.indexOf(text);
    if (at < 0) continue;
    const before: Text = { type: "text", value: child.value.slice(0, at) };
    const after: Text = { type: "text", value: child.value.slice(at + text.length) };
    const mark: Element = { type: "element", tagName: "span", properties: { [MARK_PROPERTY]: String(index) }, children: [{ type: "text", value: text }] };
    const replaced: ElementContent[] = [...(before.value ? [before] : []), mark, ...(after.value ? [after] : [])];
    parent.children.splice(i, 1, ...(replaced as typeof parent.children));
    return true;
  }
  return false;
}

/** One text node cut at the scan's ranges: plain text between spans that carry each range's key. */
function cut(value: string, ranges: readonly MarkRange[]): ElementContent[] {
  const out: ElementContent[] = [];
  let at = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    // A range that overlaps the one before it, or runs off the text, is left out.
    if (range.start < at || range.end <= range.start || range.end > value.length) continue;
    if (range.start > at) out.push({ type: "text", value: value.slice(at, range.start) });
    out.push({ type: "element", tagName: "span", properties: { [SCAN_PROPERTY]: range.key }, children: [{ type: "text", value: value.slice(range.start, range.end) }] });
    at = range.end;
  }
  if (at < value.length) out.push({ type: "text", value: value.slice(at) });
  return out;
}

/** Runs the scan over every text node under `parent`, in reading order, outside the skipped elements. */
function scanIn(parent: Root | Element, scan: (text: string) => readonly MarkRange[]): void {
  for (let i = 0; i < parent.children.length; i += 1) {
    const child = parent.children[i] as ElementContent;
    if (child.type === "element") {
      if (!isSkipped(child)) scanIn(child, scan);
      continue;
    }
    if (child.type !== "text") continue;
    const ranges = scan(child.value);
    if (ranges.length === 0) continue;
    const pieces = cut(child.value, ranges);
    parent.children.splice(i, 1, ...(pieces as typeof parent.children));
    i += pieces.length - 1;
  }
}

/** The rehype plugin: marks each text once, in order; then the scan's marks in what is left. */
export function rehypeMarks(marks: readonly MarkdownMark[], scanMarks?: MarkScanner) {
  return () => (tree: Root) => {
    marks.forEach((mark, index) => {
      const text = mark.text.trim();
      if (text) markIn(tree, text, index);
    });
    if (scanMarks) scanIn(tree, scanMarks());
  };
}

/** The key of a span a scan made, or null for any other span. */
export function scanKeyOf(properties: Record<string, unknown> | undefined): string | null {
  const raw = properties?.[SCAN_PROPERTY];
  return typeof raw === "string" ? raw : null;
}

/** The mark index a rendered span carries, or null for any other span. */
export function markIndexOf(properties: Record<string, unknown> | undefined): number | null {
  const raw = properties?.[MARK_PROPERTY];
  if (raw === undefined || raw === null) return null;
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : null;
}
