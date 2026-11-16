import { charCount } from "./text";

/** A title or purpose made from a long question is at most this many characters (F11 §2). */
export const TOPIC_SUMMARY_MAX_CHARS = 36;
/** Shorter fragments (「好。」, 「OK」) are not sentences worth naming a topic after. */
const MIN_CLAUSE_CHARS = 3;

/** Closed fences only; an unclosed fence loses just its marker line (the question may follow it). */
const CODE_FENCE = /```[\s\S]*?```/g;
const FENCE_LINE = /^\s*```.*$/gm;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const URL = /https?:\/\/\S+/g;
const LINE_PREFIX = /^\s*(>\s*)*(#{1,6}\s+)?([-*+]\s+|\d+[.)]\s+|\d+、)?\s*/;
const EMPHASIS = /(\*\*|__|`)/g;
/** A clause and the marks that end it (an ASCII . ! ? only before a space, so `Node.js` or `v1.2` stays whole). */
const CLAUSE = /(?:[^。！？；;\n.!?]|[.!?](?!\s|$))+(?:[。！？；;]|[.!?](?=\s|$))*/g;
/** A long clause's comma-separated parts, to find the one that asks. */
const SUB_CLAUSE = /[^，,]+[，,]*/g;
const QUESTION_WORDS = /請問|如何|怎麼|為什麼|為何|什麼是|哪個|哪一種|能不能|是否|該怎麼|差在哪|優缺點|怎麼辦|\b(what|why|how|which|should)\b/i;
const OPENING =
  /^(我想請問一下|想請問一下|請問一下|請問|想問一下|我想問|幫我解釋一下|請幫我解釋|請教一下|我想了解|想了解|那如果|如果我想|為什麼說|針對)\s*[，,：:]*\s*/;
const TEMPLATE_TAIL = /[，,。？?！!]*\s*(請用簡單好懂的方式解釋.*|請詳細說明背後的邏輯與原因.*|請舉一個具體.*|具體步驟該怎麼做.*)$/;
const TRAILING_MARKS = /[？?。！!，,、：:；;\s]+$/;
/** Where a long topic may be cut: after a comma-like mark or a space. */
const SOFT_BREAK = /[，,、：:；; ]/;

function cleaned(text: string): string {
  return text
    .replace(CODE_FENCE, " ")
    .replace(FENCE_LINE, " ")
    .replace(MD_LINK, "$1")
    .replace(URL, " ")
    .split("\n")
    .map((line) => line.replace(LINE_PREFIX, "").replace(EMPHASIS, ""))
    .join("\n");
}

function clauses(text: string): string[] {
  return (text.match(CLAUSE) ?? []).map((clause) => clause.replace(/\s+/g, " ").trim()).filter((clause) => charCount(clause.replace(TRAILING_MARKS, "")) >= MIN_CLAUSE_CHARS);
}

const isQuestion = (clause: string) => /[？?]$/.test(clause) || QUESTION_WORDS.test(clause);

/** A sentence too long for a title: its last comma-separated part that asks, else the sentence. */
function askingPart(sentence: string, maxChars: number): string {
  if (charCount(sentence) <= maxChars) return sentence;
  const parts = (sentence.match(SUB_CLAUSE) ?? []).map((part) => part.trim()).filter((part) => charCount(part.replace(TRAILING_MARKS, "")) >= MIN_CLAUSE_CHARS);
  return [...parts].reverse().find(isQuestion) ?? sentence;
}

/** Cut at `max` characters, back to a soft break in the second half when there is one, with …. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1);
  for (let at = head.length - 1; at >= Math.floor(head.length / 2); at -= 1) {
    if (SOFT_BREAK.test(head[at]!)) return `${head.slice(0, at).join("").replace(TRAILING_MARKS, "")}…`;
  }
  return `${head.join("").replace(TRAILING_MARKS, "")}…`;
}

/**
 * A short topic for a title or a branch purpose (F11 §2, the instant first
 * stage; the first reply's [TOPIC] may replace it): code, links and Markdown
 * marks out; of several sentences the last one that asks something (the
 * background usually comes first), else the first; the polite opening and
 * the question templates' tails off; at most `maxChars`, cut at a soft
 * break. "" when nothing is left (a message of only code or links).
 */
export function summarizeTopic(text: string, maxChars = TOPIC_SUMMARY_MAX_CHARS): string {
  const all = clauses(cleaned(text));
  if (all.length === 0) return "";
  const sentence = all.length >= 2 ? ([...all].reverse().find(isQuestion) ?? all[0]!) : all[0]!;
  const chosen = askingPart(sentence, maxChars);
  const topic = chosen.replace(OPENING, "").replace(TEMPLATE_TAIL, "").replace(TRAILING_MARKS, "").trim();
  return cut(topic || chosen.replace(TRAILING_MARKS, ""), maxChars);
}
