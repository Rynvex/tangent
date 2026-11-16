import { createContext, useContext, useMemo, type ReactNode } from "react";

/** The code blocks' three sizes: one step below the default, the default, one step above. */
export type CodeFontSize = "sm" | "md" | "lg";

/**
 * How Markdown is shown, as the reader set it (a host's settings page). The
 * defaults are the renderer's long-standing behaviour: code scrolls sideways
 * at the small text size, and `$…$` is KaTeX math.
 */
export interface MarkdownOptions {
  /** Long code lines wrap instead of scrolling sideways. */
  codeWrap: boolean;
  codeFontSize: CodeFontSize;
  /** Off: `$…$`, `$$…$$` and ```math stay as written (a text full of prices reads as prices). */
  renderMath: boolean;
}

export const DEFAULT_MARKDOWN_OPTIONS: MarkdownOptions = Object.freeze({ codeWrap: false, codeFontSize: "md", renderMath: true });

const MarkdownOptionsContext = createContext<MarkdownOptions>(DEFAULT_MARKDOWN_OPTIONS);

export interface MarkdownOptionsProviderProps extends Partial<MarkdownOptions> {
  children: ReactNode;
}

/** Sets the Markdown options for everything below; anything left out keeps the default. */
export function MarkdownOptionsProvider({ codeWrap = false, codeFontSize = "md", renderMath = true, children }: MarkdownOptionsProviderProps) {
  const value = useMemo(() => ({ codeWrap, codeFontSize, renderMath }), [codeWrap, codeFontSize, renderMath]);
  return <MarkdownOptionsContext.Provider value={value}>{children}</MarkdownOptionsContext.Provider>;
}

export function useMarkdownOptions(): MarkdownOptions {
  return useContext(MarkdownOptionsContext);
}
