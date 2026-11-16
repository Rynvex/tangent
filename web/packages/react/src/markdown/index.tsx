// Markdown renderer component).
import { memo, useEffect, useState, type ComponentType } from "react";
import { cx } from "../lib/cx";
import type { MarkdownProps } from "./markdown-props";

export type { MarkdownMark, MarkdownProps, MarkRange, MarkScanner } from "./markdown-props";
export { CopyButton } from "./copy-button";
export { safeHref } from "./safe-url";
export { DEFAULT_MARKDOWN_OPTIONS, MarkdownOptionsProvider, useMarkdownOptions, type CodeFontSize, type MarkdownOptions, type MarkdownOptionsProviderProps } from "./markdown-options";

let loadedContent: ComponentType<MarkdownProps> | null = null;
let pendingLoad: Promise<void> | null = null;

/**
 * Fetches the renderer (react-markdown, remark plugins) the first time any
 * Markdown is shown, so it stays out of the first-load bundle. Once loaded it
 * renders synchronously, so only the very first block ever shows the fallback.
 */
export function loadMarkdownRenderer(): Promise<void> {
  pendingLoad ??= import("./markdown-impl").then((module) => {
    loadedContent = module.MarkdownContent;
  });
  return pendingLoad;
}

function useRendererReady(): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    if (loadedContent) return;
    let isCurrent = true;
    loadMarkdownRenderer()
      .then(() => {
        if (isCurrent) bump((value) => value + 1);
      })
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, []);
  return loadedContent !== null;
}

function MarkdownLoader(props: MarkdownProps) {
  const isReady = useRendererReady();
  if (isReady && loadedContent) {
    const Content = loadedContent;
    return <Content {...props} />;
  }
  return (
    <div data-tg-markdown-pending="" className={cx("min-w-0 break-words whitespace-pre-wrap", props.className)}>
      {props.children}
    </div>
  );
}

/** Safe Markdown (GFM tables and task lists, code with highlighting, KaTeX math); see markdown-impl.tsx. */
export const Markdown = memo(MarkdownLoader);
