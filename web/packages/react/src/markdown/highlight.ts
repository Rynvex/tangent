// Markdown renderer component); adds diff.
import type { LanguageFn } from "highlight.js";
import type { Root } from "hast";

type LanguageLoader = () => Promise<{ default: LanguageFn }>;

/** Highlighting 20k+ characters on the main thread is noticeable; plain text is fine there. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

// Each loader is its own chunk, fetched only when a block in that language appears.
const LOADERS: Record<string, LanguageLoader> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  "c++": "cpp",
  cs: "csharp",
  golang: "go",
  toml: "ini",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  node: "javascript",
  kt: "kotlin",
  md: "markdown",
  patch: "diff",
  py: "python",
  rb: "ruby",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  html: "xml",
  svg: "xml",
  yml: "yaml",
  docker: "dockerfile",
};

/** Canonical highlight.js name for a fence language, or null when unsupported. */
export function resolveLanguage(language: string | null | undefined): string | null {
  if (!language) return null;
  const key = language.toLowerCase();
  // Own properties only: a fence like ```constructor must not reach Object.prototype.
  const name = Object.hasOwn(ALIASES, key) ? ALIASES[key]! : key;
  return Object.hasOwn(LOADERS, name) ? name : null;
}

type Lowlight = Awaited<ReturnType<typeof createLowlight>>;
let lowlightPromise: Promise<Lowlight> | null = null;

async function createLowlight() {
  const { createLowlight: create } = await import("lowlight");
  return create();
}

/**
 * Highlights code into a hast tree (no HTML strings), loading the highlighter
 * and the one grammar needed on first use. Returns null for unsupported
 * languages and oversize input so the caller shows plain text.
 */
export async function highlightToTree(language: string | null | undefined, code: string): Promise<Root | null> {
  const name = resolveLanguage(language);
  if (!name || code.length > MAX_HIGHLIGHT_CHARS) return null;
  lowlightPromise ??= createLowlight();
  const lowlight = await lowlightPromise;
  if (!lowlight.registered(name)) {
    const grammar = await LOADERS[name]?.();
    if (!grammar) return null;
    lowlight.register({ [name]: grammar.default });
  }
  return lowlight.highlight(name, code);
}
