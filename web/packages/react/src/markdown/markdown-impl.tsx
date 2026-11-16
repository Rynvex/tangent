// Markdown renderer component):
// same plugins and security settings, Tangent tokens, no mermaid, no uploads.
import type { Element, ElementContent } from "hast";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cx } from "../lib/cx";
import { CodeBlock } from "./code-block";
import { escapeCurrencyDollars } from "./math-guard";
import { useMarkdownOptions } from "./markdown-options";
import { MathView } from "./math-view";
import type { MarkdownProps, MarkScanner } from "./markdown-props";
import { safeHref } from "./safe-url";
import { findOpenBlockOffset } from "./segments";
import { markIndexOf, rehypeMarks, scanKeyOf } from "./marks";

/** Offset in the rendered source of a block still being written, or -1. */
const OpenBlockContext = createContext(-1);
/** F12 S2: the marks of this text and how to render one. */
const MarksContext = createContext<Pick<MarkdownProps, "marks" | "renderMark">>({});

/** A span the marks step made renders as the host's mark; any other span stays a span. */
function MarkSpan({ node, children, ...rest }: ComponentProps<"span"> & ExtraProps) {
  const { marks, renderMark } = useContext(MarksContext);
  const properties = node?.properties as Record<string, unknown> | undefined;
  const index = markIndexOf(properties);
  const mark = index === null ? undefined : marks?.[index];
  if (mark && renderMark) return <>{renderMark(mark, children)}</>;
  // F19: a span the scan made (a glossary term); its words are its children.
  const scanned = scanKeyOf(properties);
  if (scanned !== null && renderMark) return <>{renderMark({ key: scanned, text: node ? node.children.map(textOf).join("") : "" }, children)}</>;
  return <span {...rest}>{children}</span>;
}
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
type HeadingTag = (typeof HEADING_TAGS)[number];
const REMARK_PLUGINS = [remarkGfm, remarkMath];
/** Math turned off by the reader: `$` is only a character, so nothing is parsed (or escaped) as a formula. */
const REMARK_PLUGINS_NO_MATH = [remarkGfm];

function demote(tag: HeadingTag): HeadingTag {
  return HEADING_TAGS[Math.min(HEADING_TAGS.indexOf(tag) + 1, HEADING_TAGS.length - 1)] ?? tag;
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  return node.type === "element" ? node.children.map(textOf).join("") : "";
}

function languageOf(code: Element): string | null {
  const classes = code.properties?.className;
  const match = (Array.isArray(classes) ? classes.map(String) : []).find((name) => name.startsWith("language-"));
  return match ? match.slice("language-".length) : null;
}

function PreBlock({ node }: ExtraProps) {
  const openOffset = useContext(OpenBlockContext);
  const { renderMath } = useMarkdownOptions();
  const code = node?.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
  if (!node || !code) return null;
  const source = code.children.map(textOf).join("").replace(/\n$/, "");
  const language = languageOf(code);
  const start = node.position?.start.offset ?? -1;
  const isOpen = openOffset !== -1 && start >= openOffset;
  if (language === "math" && !isOpen && renderMath) return <MathView source={source} isDisplay />;
  return <CodeBlock language={language === "math" ? null : language} code={source} isOpen={isOpen} />;
}

function InlineCode({ className, children, node: _node, ...rest }: ComponentProps<"code"> & ExtraProps) {
  if (typeof className === "string" && className.split(" ").includes("language-math")) {
    return <MathView source={String(children)} isDisplay={false} />;
  }
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
}

function SafeLink({ href, children }: ComponentProps<"a"> & ExtraProps) {
  const safe = safeHref(href);
  if (!safe) return <span>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Model output is untrusted and an external image leaks the reader's IP: images become links. */
function SafeImage({ src, alt }: ComponentProps<"img"> & ExtraProps) {
  const href = typeof src === "string" ? safeHref(src) : null;
  const label = alt || href || "";
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
}

function ScrollTable({ children }: { children?: ReactNode }) {
  return (
    <div className="my-3 max-w-full overflow-x-auto" tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

function ReadonlyCheckbox({ node: _node, ...rest }: ComponentProps<"input"> & ExtraProps) {
  return <input {...rest} disabled readOnly className="mr-1.5 align-middle" />;
}

function headingComponent(tag: HeadingTag, shouldDemote: boolean) {
  const Tag = shouldDemote ? demote(tag) : tag;
  return function Heading({ children }: ComponentProps<"h1"> & ExtraProps) {
    return <Tag>{children}</Tag>;
  };
}

function buildComponents(variant: "document" | "message"): Components {
  const isMessage = variant === "message";
  return {
    pre: PreBlock,
    code: InlineCode,
    a: SafeLink,
    img: SafeImage,
    table: ScrollTable,
    input: ReadonlyCheckbox,
    span: MarkSpan,
    h1: headingComponent("h1", isMessage),
    h2: headingComponent("h2", isMessage),
    h3: headingComponent("h3", isMessage),
    h4: headingComponent("h4", isMessage),
    h5: headingComponent("h5", isMessage),
    h6: headingComponent("h6", isMessage),
  };
}

const DOCUMENT_COMPONENTS = buildComponents("document");
const MESSAGE_COMPONENTS = buildComponents("message");

/** Element styles, all from --tg-* tokens; size and font come from the container. */
const PROSE = [
  "min-w-0 max-w-none break-words",
  "[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-tg-xl [&_h1]:font-semibold [&_h1]:text-tg-foreground-strong",
  "[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-tg-lg [&_h2]:font-semibold [&_h2]:text-tg-foreground-strong",
  "[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-tg-md [&_h3]:font-semibold [&_h3]:text-tg-foreground-strong",
  "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:font-semibold [&_h5]:mt-3 [&_h5]:mb-1 [&_h5]:font-semibold [&_h6]:mt-3 [&_h6]:mb-1 [&_h6]:font-semibold",
  "[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:pl-1",
  "[&_li]:my-1 [&_a]:text-tg-primary-text [&_a]:underline [&_a]:underline-offset-2",
  "[&_:not(pre)>code]:rounded-tg-sm [&_:not(pre)>code]:bg-tg-accent [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-tg-mono [&_:not(pre)>code]:text-[0.85em]",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-tg-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-tg-muted",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:font-tg-sans [&_table]:text-tg-base",
  "[&_th]:border [&_th]:border-tg-border [&_th]:bg-tg-surface-sunken [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-tg-border [&_td]:px-2.5 [&_td]:py-1.5 [&_hr]:my-4 [&_hr]:border-tg-border",
].join(" ");

/** One observer for every block that waits to come into view before it takes a new scan. */
let viewObserver: IntersectionObserver | null = null;
const waitingForView = new WeakMap<globalThis.Element, () => void>();

/** Runs `run` once `element` is in view (at once where the browser cannot tell); returns how to stop waiting. */
function whenInView(element: HTMLElement, run: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    run();
    return () => undefined;
  }
  viewObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const waiting = waitingForView.get(entry.target);
      waitingForView.delete(entry.target);
      viewObserver?.unobserve(entry.target);
      waiting?.();
    }
  });
  waitingForView.set(element, run);
  viewObserver.observe(element);
  return () => {
    waitingForView.delete(element);
    viewObserver?.unobserve(element);
  };
}

/**
 * The scan in effect (F19 §2.3). A block is parsed with the scan it is given
 * when it first renders; a scan that changes later (the glossary changed) is
 * taken only once the block is in view, so a long transcript re-parses the
 * few replies on screen and each of the others as it is scrolled to, never
 * hundreds at once.
 */
function useScanInView(box: RefObject<HTMLElement | null>, scanMarks: MarkScanner | undefined): MarkScanner | undefined {
  const [applied, setApplied] = useState<MarkScanner | undefined>(() => scanMarks);
  useEffect(() => {
    if (applied === scanMarks) return undefined;
    const take = () => setApplied(() => scanMarks);
    const element = box.current;
    if (!element) {
      take();
      return undefined;
    }
    return whenInView(element, take);
  }, [applied, scanMarks, box]);
  return applied;
}

/**
 * Read-only Markdown renderer for model text. Raw HTML is not rendered (no
 * rehype-raw), links are limited to http/https/mailto, images never load,
 * and code and formulas load their heavy renderers on demand. Memoised on its
 * text so a long thread re-parses only what changed.
 */
function MarkdownImpl({ children, className, variant = "document", isStreaming = false, marks, renderMark, scanMarks }: MarkdownProps) {
  const box = useRef<HTMLDivElement>(null);
  const { renderMath } = useMarkdownOptions();
  const source = useMemo(() => (renderMath ? escapeCurrencyDollars(children) : children), [children, renderMath]);
  const openOffset = useMemo(() => (isStreaming ? findOpenBlockOffset(source) : -1), [isStreaming, source]);
  const scan = useScanInView(box, scanMarks);
  const marked = !isStreaming && renderMark && ((marks && marks.length > 0) || scan);
  const rehypePlugins = useMemo(() => (marked ? [rehypeMarks(marks ?? [], scan)] : undefined), [marked, marks, scan]);
  const marksValue = useMemo(() => ({ marks, renderMark }), [marks, renderMark]);
  // react-markdown parses on every render: the parsed text is kept until what it is parsed from, or with, changes
  // (a scan still waiting for its block to come into view changes neither).
  const parsed = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={renderMath ? REMARK_PLUGINS : REMARK_PLUGINS_NO_MATH} {...(rehypePlugins ? { rehypePlugins } : {})} components={variant === "message" ? MESSAGE_COMPONENTS : DOCUMENT_COMPONENTS}>
        {source}
      </ReactMarkdown>
    ),
    [source, rehypePlugins, variant, renderMath],
  );
  return (
    <div ref={box} data-tg-markdown="" className={cx(PROSE, className)}>
      <OpenBlockContext.Provider value={openOffset}>
        <MarksContext.Provider value={marksValue}>{parsed}</MarksContext.Provider>
      </OpenBlockContext.Provider>
    </div>
  );
}

export const MarkdownContent = memo(MarkdownImpl);
