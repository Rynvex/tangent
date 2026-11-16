import { buildBranchTree, type BranchNode } from "./branch-tree";
import type { BranchView } from "./types";

export interface ExportLabels {
  /** Text for a status, already translated. */
  status: (status: BranchView["status"]) => string;
  /** Label put before a returned conclusion. */
  conclusion: string;
  /** Label put before the line id. */
  line: string;
}

const MAX_TEXT = 300;
const MAX_FILE_NAME = 80;
const REVOKE_DELAY_MS = 10_000;
const FALLBACK_FILE_NAME = "conversation-map";

/** Collapses whitespace and control characters so user text always fits on one line. */
export function singleLine(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function markdownEscape(text: string): string {
  return text.replace(/[\\`*_{}[\]<>()#+!|~]/g, "\\$&");
}

function markdownLines(node: BranchNode, level: number, labels: ExportLabels): string[] {
  const { branch } = node;
  const parts = [markdownEscape(singleLine(branch.purpose)), `(${markdownEscape(labels.status(branch.status))})`];
  if (branch.status === "merged" && branch.conclusionLine) {
    parts.push(`— ${labels.conclusion}: ${markdownEscape(singleLine(branch.conclusionLine))}`);
  }
  parts.push(`\`${labels.line} ${branch.lineId.replace(/[^\w-]/g, "")}\``);
  const line = `${"  ".repeat(level)}- ${parts.join(" ")}`;
  return [line, ...node.children.flatMap((child) => markdownLines(child, level + 1, labels))];
}

/** An indented Markdown list: purpose, status, conclusion and line id per branch; no messages. */
export function branchesToMarkdown(mainTitle: string, branches: readonly BranchView[], labels: ExportLabels): string {
  const tree = buildBranchTree(branches);
  const heading = `# ${markdownEscape(singleLine(mainTitle))}`;
  const body = tree.flatMap((node) => markdownLines(node, 0, labels));
  return [heading, "", ...body, ""].join("\n");
}

/** Mermaid node text: quotes and brackets as entity codes, one line. */
function mermaidText(text: string): string {
  return singleLine(text)
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/\[/g, "#91;")
    .replace(/\]/g, "#93;");
}

/** Prefix for node ids: Mermaid ids may not start with a digit (UUIDs often do), and none can be `root`. */
const MERMAID_ID_PREFIX = "b_";

/** Mermaid node ids: word characters only, prefixed, and unique even when two line ids sanitise alike. */
function mermaidIds(branches: readonly BranchView[]): ReadonlyMap<string, string> {
  const taken = new Set<string>();
  return new Map(
    branches.map((branch) => {
      const base = `${MERMAID_ID_PREFIX}${branch.lineId.replace(/[^\w]/g, "_")}`;
      let id = base;
      for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
      taken.add(id);
      return [branch.lineId, id];
    }),
  );
}

function mermaidLines(node: BranchNode, level: number, labels: ExportLabels, ids: ReadonlyMap<string, string>): string[] {
  const { branch } = node;
  const conclusion = branch.status === "merged" && branch.conclusionLine ? ` — ${labels.conclusion}: ${singleLine(branch.conclusionLine)}` : "";
  const text = mermaidText(`${branch.purpose} (${labels.status(branch.status)})${conclusion}`);
  const line = `${"  ".repeat(level)}${ids.get(branch.lineId) ?? MERMAID_ID_PREFIX}["${text}"]`;
  return [line, ...node.children.flatMap((child) => mermaidLines(child, level + 1, labels, ids))];
}

/** A Mermaid mindmap: the main line is the root, each branch a node (purpose, status, conclusion). */
export function branchesToMermaid(mainTitle: string, branches: readonly BranchView[], labels: ExportLabels): string {
  const tree = buildBranchTree(branches);
  const ids = mermaidIds(branches);
  return ["mindmap", `  root["${mermaidText(mainTitle)}"]`, ...tree.flatMap((node) => mermaidLines(node, 2, labels, ids)), ""].join("\n");
}

/** Removes characters XML 1.0 cannot carry, then escapes markup characters. */
export function xmlEscape(text: string): string {
  return text
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const attr = (value: string): string => xmlEscape(singleLine(value));

function freeMindNode(node: BranchNode, labels: ExportLabels): string {
  const { branch } = node;
  const id = `ID_${branch.lineId.replace(/[^\w-]/g, "_")}`;
  const attributes = [
    `<attribute NAME="status" VALUE="${attr(labels.status(branch.status))}"/>`,
    `<attribute NAME="line" VALUE="${attr(branch.lineId)}"/>`,
  ];
  if (branch.status === "merged" && branch.conclusionLine) {
    attributes.push(`<attribute NAME="conclusion" VALUE="${attr(branch.conclusionLine)}"/>`);
  }
  const children = node.children.map((child) => freeMindNode(child, labels));
  return `<node ID="${id}" TEXT="${attr(branch.purpose)}">${[...attributes, ...children].join("")}</node>`;
}

/** A FreeMind 1.0.1 document; the main line is the root node. */
export function branchesToFreeMind(mainTitle: string, branches: readonly BranchView[], labels: ExportLabels): string {
  const tree = buildBranchTree(branches);
  const children = tree.map((node) => freeMindNode(node, labels)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.0.1"><node ID="ID_main" TEXT="${attr(mainTitle)}">${children}</node></map>\n`;
}

function opmlOutline(node: BranchNode, labels: ExportLabels): string {
  const { branch } = node;
  const conclusion = branch.status === "merged" && branch.conclusionLine ? ` _conclusion="${attr(branch.conclusionLine)}"` : "";
  const head = `<outline text="${attr(branch.purpose)}" _status="${attr(labels.status(branch.status))}"${conclusion} _line="${attr(branch.lineId)}"`;
  if (node.children.length === 0) return `${head}/>`;
  return `${head}>${node.children.map((child) => opmlOutline(child, labels)).join("")}</outline>`;
}

/** An OPML 2.0 outline; the main line is the one top-level outline, branches nest under it. */
export function branchesToOpml(mainTitle: string, branches: readonly BranchView[], labels: ExportLabels): string {
  const tree = buildBranchTree(branches);
  const body = `<outline text="${attr(mainTitle)}">${tree.map((node) => opmlOutline(node, labels)).join("")}</outline>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>${attr(mainTitle)}</title></head><body>${body}</body></opml>\n`;
}

/** A safe download name: no path characters, no leading dots, bounded length. */
export function exportFileName(title: string, extension: string): string {
  const cleaned = title
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, MAX_FILE_NAME)
    .trim();
  return `${cleaned || FALLBACK_FILE_NAME}.${extension}`;
}

/** Hands `text` to the browser as a file download. */
export function downloadText(fileName: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download before the browser has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
