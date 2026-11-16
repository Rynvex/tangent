/**
 * HTML exports: Google Takeout's Gemini activity (`MyActivity.html`) and
 * ChatGPT's `chat.html` (which carries the same data as conversations.json in
 * a script). The file is untrusted: it is parsed with `DOMParser` into an
 * inert document (scripts never run, nothing is attached to the page) and
 * only its text is read.
 */

/** Elements whose content starts on a new line. */
const BLOCKS = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "TABLE", "BLOCKQUOTE", "SECTION", "ARTICLE", "PRE", "HR"]);
/** Elements whose text never belongs to a message. */
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "SVG", "IFRAME", "OBJECT"]);

/** The readable text of a node: blocks on their own lines, list items as "- ", code blocks fenced. */
export function htmlToText(node: Node): string {
  const parts: string[] = [];
  const walk = (current: Node) => {
    if (current.nodeType === 3) {
      parts.push((current.textContent ?? "").replace(/\s+/g, " "));
      return;
    }
    if (current.nodeType !== 1) return;
    const element = current as Element;
    const tag = element.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    if (tag === "BR") {
      parts.push("\n");
      return;
    }
    if (tag === "PRE") {
      parts.push(`\n\`\`\`\n${(element.textContent ?? "").replace(/\n+$/, "")}\n\`\`\`\n`);
      return;
    }
    const block = BLOCKS.has(tag);
    if (block) parts.push("\n");
    if (tag === "LI") parts.push("- ");
    if (/^H[1-6]$/.test(tag)) parts.push(`${"#".repeat(Number(tag[1]))} `);
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block) parts.push("\n");
  };
  walk(node);
  return parts
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ParseHtml = (html: string) => Document;

/** The browser's parser: an inert document (`text/html` never runs scripts). */
export const defaultParseHtml: ParseHtml = (html) => new DOMParser().parseFromString(html, "text/html");

/** One Gemini prompt and its answer from the activity page, with its time when it could be read. */
export interface GeminiTurn {
  prompt: string;
  response: string;
  time: string | null;
}

const PROMPTED = /^\s*(Prompted|Asked|已提示|已詢問|提示)\s*[:：]?\s*/i;

/** Parses the Takeout date line ("Oct 30, 2026, 1:23:45 PM JST"); null when the browser cannot. */
function readTime(text: string): string | null {
  const cleaned = text.replace(/ /g, " ").replace(/\s+[A-Z]{2,5}$/, "").trim();
  const at = Date.parse(cleaned);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** Gemini activity cells of `MyActivity.html` (newest first in the file; returned oldest first). */
export function parseGeminiActivityHtml(doc: Document): GeminiTurn[] {
  const turns: GeminiTurn[] = [];
  for (const cell of Array.from(doc.querySelectorAll(".outer-cell"))) {
    const header = cell.querySelector(".header-cell")?.textContent ?? "";
    if (!/gemini|bard/i.test(header)) continue;
    const content = cell.querySelector(".content-cell");
    if (!content) continue;
    // The prompt and the date are the text before the first block element; the answer is the rest.
    const lead: string[] = [];
    const rest: Node[] = [];
    for (const child of Array.from(content.childNodes)) {
      if (rest.length === 0 && (child.nodeType === 3 || (child.nodeType === 1 && (child as Element).tagName === "BR"))) lead.push(child.nodeType === 3 ? (child.textContent ?? "") : "\n");
      else rest.push(child);
    }
    const [first = "", ...others] = lead.join("").split("\n").map((line) => line.trim()).filter(Boolean);
    if (!PROMPTED.test(first)) continue;
    const prompt = first.replace(PROMPTED, "").trim();
    const time = others.length > 0 ? readTime(others[others.length - 1]!) : null;
    const holder = doc.createElement("div");
    for (const node of rest) holder.appendChild(node.cloneNode(true));
    const response = htmlToText(holder);
    if (prompt) turns.push({ prompt, response, time });
  }
  return turns.reverse();
}

/** The `jsonData` array ChatGPT's `chat.html` embeds; null when the page has none. */
export function chatGptJsonFromHtml(doc: Document): unknown {
  for (const script of Array.from(doc.querySelectorAll("script"))) {
    const text = script.textContent ?? "";
    const at = text.search(/(?:var|let|const)\s+jsonData\s*=/);
    if (at < 0) continue;
    const start = text.indexOf("[", at);
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}
