import type { ReactNode } from "react";

/** F12 S2: words of a reply that a branch was opened from (its `excerpt`), marked where they first appear. */
export interface MarkdownMark {
  /** The exact text to find (outside code; within one run of text). */
  text: string;
  /** Stable key (the mark's own id). */
  key: string;
}

/** A stretch of one run of plain text to mark, found by a scan (`MarkdownProps.scanMarks`). */
export interface MarkRange {
  start: number;
  end: number;
  /** The mark's key, as `renderMark` gets it. */
  key: string;
}

/**
 * Makes the scan of one rendering pass (F19 §2.3: a glossary's terms). The
 * scan is called with each run of plain text in reading order, so it can
 * keep count across runs (each term once, a limit per text); its ranges must
 * not overlap.
 */
export type MarkScanner = () => (text: string) => readonly MarkRange[];

export interface MarkdownProps {
  children: string;
  className?: string | undefined;
  /** `message` demotes headings one level so a chat reply never shows a huge h1. */
  variant?: "document" | "message";
  /** Text is still arriving: blocks that have not closed yet stay plain code. */
  isStreaming?: boolean;
  /** Words to mark (S2); each is found once, outside code, links and other marks. Text not found is left as it is. */
  marks?: readonly MarkdownMark[] | undefined;
  /** Renders a mark around its words; required with `marks` or `scanMarks`. */
  renderMark?: ((mark: MarkdownMark, children: ReactNode) => ReactNode) | undefined;
  /** Further marks, found by scanning the plain text outside code, links, math and the `marks` above (which are placed first). */
  scanMarks?: MarkScanner | undefined;
}
