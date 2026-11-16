import { charCount, truncateChars } from "./text";

/** What a selection is, for the first question to ask about it (F10): a name or short phrase, or a sentence / passage. */
export type ExcerptKind = "term" | "sentence";

/** A term is at most this many characters (after the outer quotes come off). */
export const ASK_TERM_MAX_CHARS = 25;
/** A sentence's branch purpose names its first this many characters. */
export const ASK_PURPOSE_HEAD_CHARS = 28;

/** The question templates the branch dialog offers, by what was selected; the first is the default. `general`: no selection. */
export const ASK_TEMPLATES = {
  term: ["explain", "use", "principle", "compare"],
  sentence: ["why", "example", "challenge", "apply"],
  general: ["detail", "example", "challenge", "alternatives"],
} as const;

export type AskTemplateGroup = keyof typeof ASK_TEMPLATES;
export type AskTemplateId = (typeof ASK_TEMPLATES)[AskTemplateGroup][number];

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ["「", "」"],
  ["『", "』"],
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["(", ")"],
  ["（", "）"],
];

/** Sentence punctuation; an ASCII . , : only counts before a space or the end, so `Node.js` or `v1.2` stays a term. */
const SENTENCE_MARK = /[，。！？；：!?;\n]|[.,:](?=\s|$)/;

/** The selection as a question quotes it: trimmed, whitespace runs folded, matching outer quotes or brackets taken off. */
export function askSubject(text: string): string {
  let subject = text.replace(/\s+/g, " ").trim();
  for (;;) {
    const pair = QUOTE_PAIRS.find(([open, close]) => subject.length > open.length + close.length && subject.startsWith(open) && subject.endsWith(close));
    if (!pair) return subject;
    const inner = subject.slice(pair[0].length, subject.length - pair[1].length);
    // 「a」與「b」 starts and ends with quotes that are not one pair.
    if (inner.includes(pair[1]) || inner.includes(pair[0])) return subject;
    subject = inner.trim();
  }
}

/** A name or short phrase (≤ 25 characters, no sentence punctuation) is a term; anything else a sentence. */
export function classifyExcerpt(text: string): ExcerptKind {
  const subject = askSubject(text);
  const length = charCount(subject);
  return length > 0 && length <= ASK_TERM_MAX_CHARS && !SENTENCE_MARK.test(text.trim()) ? "term" : "sentence";
}

/** A sentence's start for its branch purpose (查證：…), with … when cut. */
export function askPurposeHead(text: string, max = ASK_PURPOSE_HEAD_CHARS): string {
  return charCount(text) > max ? `${truncateChars(text, max)}…` : text;
}

export function askTemplatesFor(kind: AskTemplateGroup): readonly AskTemplateId[] {
  return ASK_TEMPLATES[kind];
}
