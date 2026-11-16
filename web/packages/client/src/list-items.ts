/**
 * The Markdown list items of a reply (S11 將清單存入停車場): the top-level
 * items of its bullet and numbered lists, outside code blocks, as plain
 * one-line text. Nested items stay part of their parent's text.
 */
import { oneLine } from "./f8-turns";

/** A list needs at least this many items before the reply offers to park them (S11). */
export const LIST_TO_SEEDS_MIN = 2;

const ITEM = /^( {0,3})(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;
const NESTED = /^ {2,}\S/;

/** Inline Markdown to plain text: links keep their text, emphasis and code marks go, a task box goes. */
export function plainInline(text: string): string {
  return oneLine(
    text
      .replace(/^\[[ xX]\]\s+/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(?<![\w*])([*_])(?!\s)(.+?)(?<!\s)\1(?![\w*])/g, "$2")
      .replace(/`([^`]*)`/g, "$1"),
  );
}

/** The reply's top-level list items, in order; empty items are skipped. */
export function markdownListItems(content: string): string[] {
  const items: string[] = [];
  let fenced = false;
  let current: string[] | null = null;
  const flush = () => {
    if (current) {
      const text = plainInline(current.join(" "));
      if (text) items.push(text);
    }
    current = null;
  };
  for (const line of content.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      flush();
      continue;
    }
    if (fenced) continue;
    const item = ITEM.exec(line);
    if (item && item[1]!.length < 2) {
      flush();
      current = [item[2]!];
    } else if (current && line.trim() !== "" && NESTED.test(line)) {
      // A nested item or a continuation line belongs to the item above.
      current.push(line.trim().replace(/^(?:[-*+]|\d{1,3}[.)])[ \t]+/, ""));
    } else if (line.trim() !== "") {
      flush();
    }
  }
  flush();
  return items;
}
