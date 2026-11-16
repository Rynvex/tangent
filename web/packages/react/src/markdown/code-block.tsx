// Markdown renderer component).
import type { Root } from "hast";
import { useEffect, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { CopyButton } from "./copy-button";
import { renderHighlightTree } from "./hast-nodes";
import { highlightToTree } from "./highlight";
import { useMarkdownOptions, type CodeFontSize } from "./markdown-options";

/** The code size of each setting, from the type scale's tokens (`md` is the long-standing size). */
const CODE_SIZES: Readonly<Record<CodeFontSize, string>> = { sm: "text-tg-xs", md: "text-tg-sm", lg: "text-tg-md" };

/** Shared chrome of code blocks: a label bar (language, copy) above a horizontally scrolling body. */
export function CodeFrame({ label, actions, children }: { label: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div data-tg-code="" className="my-3 overflow-hidden rounded-tg border border-tg-border bg-tg-surface font-tg-sans not-italic">
      <div className="flex items-center justify-between gap-2 border-b border-tg-border px-2.5 py-0.5">
        <span className="font-tg-mono text-tg-xs tracking-wide text-tg-muted uppercase">{label}</span>
        <div className="flex items-center gap-1">{actions}</div>
      </div>
      {children}
    </div>
  );
}

interface CodeBlockProps {
  language: string | null;
  code: string;
  /** True while the closing fence has not arrived; skips highlighting. */
  isOpen: boolean;
}

/**
 * A fenced code block: highlighted once complete (grammar loaded on demand),
 * scrolls sideways instead of wrapping (review §2 #2) unless the reader chose
 * wrapping (`MarkdownOptionsProvider`), copy button in the bar. The scroller
 * is focusable so keyboard users can scroll it.
 */
export function CodeBlock({ language, code, isOpen }: CodeBlockProps) {
  const [tree, setTree] = useState<Root | null>(null);
  const { codeWrap, codeFontSize } = useMarkdownOptions();

  useEffect(() => {
    if (isOpen) return;
    let isCurrent = true;
    highlightToTree(language, code)
      .then((result) => {
        if (isCurrent) setTree(result);
      })
      .catch(() => {
        if (isCurrent) setTree(null);
      });
    return () => {
      isCurrent = false;
    };
  }, [language, code, isOpen]);

  const shownTree = isOpen ? null : tree;
  return (
    <CodeFrame label={language ?? "text"} actions={<CopyButton text={code} />}>
      <pre
        data-tg-code-wrap={codeWrap ? "" : undefined}
        className={cx("tg-md-code m-0 overflow-x-auto p-3 font-tg-mono leading-relaxed text-tg-foreground", CODE_SIZES[codeFontSize], codeWrap && "break-words whitespace-pre-wrap")}
        tabIndex={0}
      >
        <code>{shownTree ? renderHighlightTree(shownTree) : code}</code>
      </pre>
    </CodeFrame>
  );
}
