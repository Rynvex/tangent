// Markdown renderer component). The
// stylesheet comes from the katex package through a dynamic import, so the
// host's bundler emits it as its own file, loaded with the first formula.
const KATEX_MAX_EXPAND = 1000;
const KATEX_MAX_SIZE_EM = 50;
const MAX_FORMULA_CHARS = 5_000;

let cssLoad: Promise<unknown> | null = null;

/** The KaTeX stylesheet and its fonts load once, on the first formula. */
function ensureKatexCss(): Promise<unknown> {
  cssLoad ??= import("katex/dist/katex.min.css").catch(() => undefined);
  return cssLoad;
}

/**
 * Renders TeX to KaTeX markup. Untrusted input: `trust` is off (so `\href`,
 * `\url`, `\includegraphics` do not produce links or images), strictness is on
 * except for non-ASCII text, and macro expansion and sizes are capped. Throws
 * on invalid input; the caller shows the source instead.
 */
export async function renderTex(source: string, displayMode: boolean): Promise<string> {
  if (source.length > MAX_FORMULA_CHARS) throw new Error("formula is too large");
  const [{ default: katex }] = await Promise.all([import("katex"), ensureKatexCss()]);
  return katex.renderToString(source, {
    displayMode,
    throwOnError: true,
    trust: false,
    strict: (code: string) => (code === "unicodeTextInMathMode" ? "ignore" : "error"),
    maxExpand: KATEX_MAX_EXPAND,
    maxSize: KATEX_MAX_SIZE_EM,
  });
}
