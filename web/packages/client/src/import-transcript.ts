/**
 * Plain-text and Markdown transcripts (pasted, or a .md / .txt file): lines
 * that start with a speaker label ("User:", "**ChatGPT:**", "## You",
 * "你：", "Gemini said:"…) begin a message. Without any label the text is
 * split on blank lines and the parts alternate between the user and the AI
 * (`guessedRoles`), for the user to correct in the preview.
 * F14: a date and time on a label line ("[2026-08-12 14:30] User:",
 * "## You (2026/08/12 14:30)") or on its own line right before one is that
 * message's `createdAt`; the conversation runs from the first to the last.
 */
import type { ImportRole } from "./b18-routes";
import type { ImportSourceKind, ParsedConversation, ParsedMessage } from "./import-tree";

const USER_LABELS = ["user", "you", "human", "me", "q", "question", "使用者", "用戶", "用户", "你", "我", "問", "问"];
const AI_LABELS = ["assistant", "ai", "chatgpt", "gpt", "claude", "gemini", "bard", "copilot", "bot", "model", "a", "answer", "助理", "助手", "答", "回答"];
/** Labels that name the service (so the import's source can say where it came from). */
const SOURCE_OF: Readonly<Record<string, ImportSourceKind>> = { chatgpt: "chatgpt", gpt: "chatgpt", claude: "claude", gemini: "gemini", bard: "gemini" };

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LABEL_WORDS = /* @__PURE__ */ [...USER_LABELS, ...AI_LABELS].sort((a, b) => b.length - a.length).map(escape).join("|");
/** "**User:** text", "User: text", "User said:", "## You", "### **Gemini**", "你：text". */
const LABEL_LINE = /* @__PURE__ */ new RegExp(`^(#{1,6} *)?(\\*\\*|__)?(${LABEL_WORDS})( +said)? *(\\*\\*|__)? *([:：])? *(\\*\\*|__)? ?(.*)$`, "i");
/** A label line is short: longer lines are never matched (and never cost the regex anything). */
const LABEL_LINE_MAX = 200;

interface LabelMatch {
  role: ImportRole;
  label: string;
  rest: string;
  createdAt?: string | null;
}

/** "2026-08-12 14:30", "2026/08/12 14:30:05", "2026-08-12T14:30Z", "2026-08-12 14:30 +08:00". */
const STAMP = String.raw`(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?`;
const LEADING_STAMP = /* @__PURE__ */ new RegExp(String.raw`^\[?\s*${STAMP}\s*\]?\s*[-–—|]?\s*`, "i");
const PAREN_STAMP = /* @__PURE__ */ new RegExp(String.raw`\s*[（(\[]\s*${STAMP}\s*[)）\]]`, "i");
const LONE_STAMP_MAX = 64;
const LONE_STAMP = /* @__PURE__ */ new RegExp(String.raw`^(?:#{1,6}\s*)?(?:\*\*|__)?\[?\s*${STAMP}\s*\]?(?:\*\*|__)?\s*$`, "i");

/** A stamp's parts as an ISO time (local time without an offset); null when it is not a real date. */
function stampTime(parts: readonly (string | undefined)[]): string | null {
  const [year, month, day, hour, minute, second = "0", zone] = parts.map((part) => part ?? undefined);
  const numbers = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, se] = numbers as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = zone ? (zone.toUpperCase() === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`) : "";
  const at = offset ? new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}${offset}`) : new Date(y, mo - 1, d, h, mi, se);
  if (Number.isNaN(at.getTime())) return null;
  // A day that does not exist (Feb 31) rolls over: refuse it (with an offset, check the UTC day of the same wall date).
  const landed = offset ? new Date(Date.UTC(y, mo - 1, d)).getUTCDate() : at.getDate();
  return landed !== d ? null : at.toISOString();
}

/** A line's date and time and the line without it, from its start or in brackets; null when it has none. */
function takeStamp(line: string): { at: string | null; rest: string } | null {
  const leading = LEADING_STAMP.exec(line);
  if (leading) return { at: stampTime(leading.slice(1, 8)), rest: line.slice(leading[0].length) };
  const inner = PAREN_STAMP.exec(line);
  if (inner) return { at: stampTime(inner.slice(1, 8)), rest: line.slice(0, inner.index) + line.slice(inner.index + inner[0].length) };
  return null;
}

/** A line that is only a date and time (the stamp of the message whose label follows). */
export function loneStamp(line: string): string | null {
  const text = line.trim();
  // A date line is short; a long line is never one (and never costs the regex anything).
  if (text.length > LONE_STAMP_MAX) return null;
  const match = LONE_STAMP.exec(text);
  return match ? stampTime(match.slice(1, 8)) : null;
}

/** A speaker label at the start of the line, with the date and time it may carry. */
function matchLabel(raw: string): LabelMatch | null {
  const plain = matchPlainLabel(raw);
  if (plain) return plain;
  const stamp = takeStamp(raw.trimStart().slice(0, LABEL_LINE_MAX));
  if (!stamp) return null;
  const label = matchPlainLabel(stamp.rest + raw.trimStart().slice(LABEL_LINE_MAX));
  return label ? { ...label, createdAt: stamp.at } : null;
}

/** A speaker label at the start of the line: a heading, or a word followed by a colon. */
function matchPlainLabel(raw: string): LabelMatch | null {
  const line = raw.trimStart();
  if (line.length > LABEL_LINE_MAX && !/^.{0,40}[:：]/.test(line)) return null;
  const match = LABEL_LINE.exec(line.slice(0, LABEL_LINE_MAX));
  if (!match) return null;
  const [whole, heading, , word, said, , colon, , tail = ""] = match;
  // The label is matched on the line's start only; the text after it is the whole rest of the line.
  const rest = line.slice(whole.length - tail.length);
  const label = word!.toLowerCase();
  // Plain "a:" / "q:" need a colon; a heading needs nothing after it; otherwise a colon or "said".
  if (!colon && !said && !(heading && rest.trim() === "")) return null;
  if (heading && rest.trim() !== "" && !colon) return null;
  const role: ImportRole = USER_LABELS.includes(label) ? "user" : "assistant";
  return { role, label, rest };
}

/** Splits on blank lines outside code fences. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "") {
      if (current.join("").trim()) out.push(current.join("\n").trim());
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.join("").trim()) out.push(current.join("\n").trim());
  return out;
}

/** Each line's label (null outside labels and inside code fences). */
function scanLabels(lines: readonly string[]): Array<LabelMatch | null> {
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return fenced ? null : matchLabel(line);
  });
}

/** The index of the next non-blank line after `index` (lines.length when none). */
function nextFilled(lines: readonly string[], index: number): number {
  let next = index + 1;
  while (next < lines.length && lines[next]!.trim() === "") next += 1;
  return next;
}

/** The time on a lone date line right above a label line (blank lines between allowed). */
function stampBefore(lines: readonly string[], index: number): string | null {
  let at = index - 1;
  while (at >= 0 && lines[at]!.trim() === "") at -= 1;
  return at >= 0 ? loneStamp(lines[at]!) : null;
}

export interface TranscriptResult {
  conversation: ParsedConversation;
  source: ImportSourceKind;
  /** No speaker label was found; roles alternate and may be wrong. */
  guessedRoles: boolean;
}

/** A transcript's messages; null when it has no text at all. */
export function parseTranscript(raw: string, title = ""): TranscriptResult | null {
  const text = raw.replace(/\r\n?/g, "\n");
  if (text.trim() === "") return null;
  const lines = text.split("\n");
  const found: Array<{ role: ImportRole; lines: string[]; createdAt: string | null }> = [];
  const labels = new Set<string>();
  let fenced = false;
  let before: string[] = [];
  const labelsAt = scanLabels(lines);
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const label = labelsAt[index] ?? null;
    // A date alone on its line, right before a label, is that message's time (not part of the text above).
    if (!label && !fenced && loneStamp(line) && labelsAt[nextFilled(lines, index)]) continue;
    if (label) {
      labels.add(label.label);
      found.push({ role: label.role, lines: label.rest.trim() ? [label.rest] : [], createdAt: label.createdAt ?? stampBefore(lines, index) });
    } else if (found.length > 0) {
      found.at(-1)!.lines.push(line);
    } else {
      before.push(line);
    }
  }
  const markdown = /(^|\n)\s*(#{1,6}\s|```|[-*] |\d+\. )|\*\*[^*]+\*\*/.test(text);
  let source: ImportSourceKind = markdown ? "markdown" : "text";
  for (const label of labels) source = SOURCE_OF[label] ?? source;
  let guessedRoles = false;
  let parts: Array<{ role: ImportRole; content: string; createdAt: string | null }>;
  if (found.length === 0) {
    guessedRoles = true;
    parts = paragraphs(text).map((content, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content, createdAt: null }));
  } else {
    const intro = before.join("\n").trim();
    before = [];
    parts = [...(intro ? [{ role: "user" as const, content: intro, createdAt: null }] : []), ...found.map((entry) => ({ role: entry.role, content: entry.lines.join("\n").trim(), createdAt: entry.createdAt }))];
  }
  const messages: ParsedMessage[] = parts.filter((part) => part.content !== "").map((part, index) => ({ externalId: `t${index + 1}`, role: part.role, content: part.content, versions: 1, ...(part.createdAt ? { createdAt: part.createdAt } : {}) }));
  if (messages.length === 0) return null;
  const times = messages.flatMap((message) => (message.createdAt ? [message.createdAt] : [])).sort();
  return {
    conversation: { id: "transcript", title, createdAt: times[0] ?? null, updatedAt: times.at(-1) ?? null, messages, branches: [], skippedBranches: 0 },
    source,
    guessedRoles,
  };
}
