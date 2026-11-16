/**
 * Finding a conversation's glossary terms in a reply (F19 §2.3). Pure and on
 * its own: it loads only once a conversation has terms.
 *
 * A term matches where the text spells its key (`termKey`: spaces removed,
 * full-width ASCII folded, lower case), so `mvcc`, `ＭＶＣＣ` and `MVCC` are
 * one term; spaces are skipped only where the term itself has one. A term
 * written in a script with spaces (Latin, Cyrillic…) matches whole words
 * only. Where several terms match at one place the longest wins; each term
 * is reported once, at its first appearance, and a text gets at most
 * `TERM_MARKS_PER_MESSAGE` matches.
 */

/** At most this many terms are marked in one message. */
export const TERM_MARKS_PER_MESSAGE = 20;

/** What the matcher needs of a term. */
export interface TermName {
  id: string;
  /** As written; says where a space may appear. */
  term: string;
  termKey: string;
}

interface Pattern {
  id: string;
  key: string;
  /** Key offsets a space of the text may come before (the term has a space there). */
  gaps: ReadonlySet<number>;
}

/** The terms of one glossary, ready to be found; make it once per glossary. */
export interface TermMatcher {
  /** How many terms it finds. */
  readonly size: number;
  /** Patterns by the first code unit of their key, longest key first. */
  readonly byFirst: ReadonlyMap<string, readonly Pattern[]>;
}

/** A term found in a text: `text.slice(start, end)` is how it is spelled there. */
export interface TermMatch {
  start: number;
  end: number;
  termId: string;
}

/** What a scan has used up: carried from one run of a message's text to the next. */
export interface TermScanState {
  /** Terms already reported (or passed over as already reported). */
  seen: ReadonlySet<string>;
  /** Matches still allowed. */
  left: number;
}

export function newTermScan(max: number = TERM_MARKS_PER_MESSAGE): TermScanState {
  return { seen: new Set(), left: max };
}

const FULL_WIDTH_FIRST = 0xff01;
const FULL_WIDTH_LAST = 0xff5e;
const FULL_WIDTH_OFFSET = FULL_WIDTH_FIRST - 0x21;
const IDEOGRAPHIC_SPACE = 0x3000;
const NO_BREAK_SPACE = 0xa0;

/** A space inside a line (never a line break: a term does not continue on the next line). */
function isInlineSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === NO_BREAK_SPACE || code === IDEOGRAPHIC_SPACE;
}

/** One character as the key spells it (domain.NormalizeTermKey per rune); ASCII is the common case. */
function keyOf(code: number, char: string): string {
  if (code < 0x80) return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : char;
  if (code >= FULL_WIDTH_FIRST && code <= FULL_WIDTH_LAST) return String.fromCharCode(code - FULL_WIDTH_OFFSET).toLowerCase();
  return char.toLowerCase();
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** Scripts written without spaces between words: a term may start or end anywhere in them. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** A character that makes up words separated by spaces (so a term next to one is inside a longer word). */
function isWordChar(code: number, char: string): boolean {
  if (code < 0x80) return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
  return LETTER_OR_DIGIT.test(char) && !UNSPACED_SCRIPT.test(char);
}

const charAt = (text: string, index: number): { code: number; char: string } => {
  const code = text.codePointAt(index) ?? 0;
  return { code, char: code > 0xffff ? String.fromCodePoint(code) : text.charAt(index) };
};

/** The character that ends just before `index` (null at the start). */
function charBefore(text: string, index: number): { code: number; char: string } | null {
  if (index <= 0) return null;
  const low = text.charCodeAt(index - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
  return charAt(text, start);
}

/**
 * A text as the keys spell it: every character folded like a key, the spaces
 * inside a line taken out (a term may be written with or without them), with
 * the way back to the text for each code unit. Made once per run of text, so
 * a term is tried with one native string comparison.
 */
interface Folded {
  folded: string;
  /** Per code unit of `folded`: where its character starts in the text. */
  from: Int32Array;
  /** Per code unit: `AT_START` where a character starts, `AFTER_SPACE` where a space was taken out just before it, `WIDE` for a character of two code units. */
  flags: Uint8Array;
}

const AT_START = 1;
const AFTER_SPACE = 2;
const WIDE = 4;
/** A character folds to at most this many code units (lower-casing can lengthen one). */
const FOLD_GROWTH = 3;
/** `String.fromCharCode` takes its arguments in pieces of this size. */
const DECODE_CHUNK = 8192;
/** CJK radicals, kana and ideographs: no case, no width to fold, by far the most common characters outside ASCII here. */
const CASELESS_FIRST = 0x2e80;
const CASELESS_LAST = 0x9fff;

function decode(codes: Uint16Array, length: number): string {
  if (length <= DECODE_CHUNK) return String.fromCharCode.apply(null, codes.subarray(0, length) as unknown as number[]);
  const pieces: string[] = [];
  for (let at = 0; at < length; at += DECODE_CHUNK) pieces.push(String.fromCharCode.apply(null, codes.subarray(at, Math.min(at + DECODE_CHUNK, length)) as unknown as number[]));
  return pieces.join("");
}

function fold(text: string): Folded {
  const codes = new Uint16Array(text.length * FOLD_GROWTH);
  const from = new Int32Array(text.length * FOLD_GROWTH);
  const flags = new Uint8Array(text.length * FOLD_GROWTH + 1);
  let size = 0;
  let space = 0;
  for (let index = 0; index < text.length; ) {
    const unit = text.charCodeAt(index);
    if (isInlineSpace(unit)) {
      space = AFTER_SPACE;
      index += 1;
      continue;
    }
    // The two common cases need no string work: ASCII (lower-cased by arithmetic) and caseless CJK.
    if (unit < 0x80 || (unit >= CASELESS_FIRST && unit <= CASELESS_LAST)) {
      codes[size] = unit >= 0x41 && unit <= 0x5a ? unit + 0x20 : unit;
      from[size] = index;
      flags[size] = AT_START | space;
      size += 1;
      space = 0;
      index += 1;
      continue;
    }
    const code = text.codePointAt(index) ?? unit;
    const wide = code > 0xffff;
    // A line break stays as it is: no key holds one, so no term continues on the next line.
    const spelled = keyOf(code, wide ? String.fromCodePoint(code) : text.charAt(index));
    for (let at = 0; at < spelled.length; at += 1) {
      codes[size] = spelled.charCodeAt(at);
      from[size] = index;
      flags[size] = (at === 0 ? AT_START | space : 0) | (wide ? WIDE : 0);
      size += 1;
    }
    space = 0;
    index += wide ? 2 : 1;
  }
  return { folded: decode(codes, size), from, flags };
}

/** Where the character behind code unit `at` of the folded text ends in the text. */
const endInText = (text: Folded, at: number): number => (text.from[at] ?? 0) + ((text.flags[at] ?? 0) & WIDE ? 2 : 1);

function patternOf(term: TermName): Pattern | null {
  let key = "";
  const gaps = new Set<number>();
  for (const char of term.term) {
    const code = char.codePointAt(0) ?? 0;
    if (/\s/u.test(char)) {
      if (key !== "") gaps.add(key.length);
      continue;
    }
    key += keyOf(code, char);
  }
  // A stored key that the term does not spell (it should not happen) is still found by the key alone.
  if (key !== term.termKey) return term.termKey === "" ? null : { id: term.id, key: term.termKey, gaps: new Set() };
  return key === "" ? null : { id: term.id, key, gaps };
}

export function createTermMatcher(terms: readonly TermName[]): TermMatcher {
  const byFirst = new Map<string, Pattern[]>();
  let size = 0;
  for (const term of terms) {
    const pattern = patternOf(term);
    if (!pattern) continue;
    size += 1;
    const first = pattern.key.charAt(0);
    byFirst.set(first, [...(byFirst.get(first) ?? []), pattern]);
  }
  for (const [first, list] of byFirst) byFirst.set(first, [...list].sort((a, b) => b.key.length - a.key.length));
  return { size, byFirst };
}

/** Where `pattern` ends in the folded text when it is spelled from `at`, or -1: on a character, with spaces only where the term has one. */
function endOfMatch(text: Folded, at: number, pattern: Pattern): number {
  const { key, gaps } = pattern;
  if (!text.folded.startsWith(key, at)) return -1;
  const end = at + key.length;
  if (end < text.folded.length && ((text.flags[end] ?? 0) & AT_START) === 0) return -1;
  for (let unit = at + 1; unit < end; unit += 1) if (((text.flags[unit] ?? 0) & AFTER_SPACE) !== 0 && !gaps.has(unit - at)) return -1;
  return end;
}

/** False when the match would be a piece of a longer word (`WAL` in `WALL`). */
function onWordEdges(text: string, start: number, end: number): boolean {
  const first = charAt(text, start);
  const before = charBefore(text, start);
  if (before && isWordChar(first.code, first.char) && isWordChar(before.code, before.char)) return false;
  const last = charBefore(text, end);
  if (end >= text.length || !last) return true;
  const after = charAt(text, end);
  return !(isWordChar(last.code, last.char) && isWordChar(after.code, after.char));
}

/**
 * The terms in one run of plain text, left to right: the longest term at each
 * place; a term seen before is passed over (its place is not given to a
 * shorter term inside it). Returns the state the next run continues from.
 */
export function scanTerms(matcher: TermMatcher, text: string, state: TermScanState = newTermScan()): { matches: TermMatch[]; state: TermScanState } {
  if (matcher.size === 0 || state.left <= 0 || text === "") return { matches: [], state };
  const matches: TermMatch[] = [];
  const seen = new Set(state.seen);
  let left = state.left;
  const folded = fold(text);
  const { folded: spelled, from, flags } = folded;
  let at = 0;
  while (at < spelled.length && left > 0) {
    const candidates = ((flags[at] ?? 0) & AT_START) !== 0 ? matcher.byFirst.get(spelled.charAt(at)) : undefined;
    let end = -1;
    let found: Pattern | undefined;
    if (candidates) {
      for (const pattern of candidates) {
        const stop = endOfMatch(folded, at, pattern);
        if (stop < 0 || !onWordEdges(text, from[at] ?? 0, endInText(folded, stop - 1))) continue;
        end = stop;
        found = pattern;
        break;
      }
    }
    if (!found) {
      at += 1;
      continue;
    }
    if (!seen.has(found.id)) {
      seen.add(found.id);
      matches.push({ start: from[at] ?? 0, end: endInText(folded, end - 1), termId: found.id });
      left -= 1;
    }
    at = end;
  }
  return { matches, state: { seen, left } };
}

/** A fence line (``` or ~~~, at most three spaces in): its marker, or null. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Inline pieces that are never plain text: code spans, images and links with their targets, autolinks and bare addresses. */
const INLINE_SKIP = /(`+)[\s\S]*?\1|!?\[[^\]\n]*\]\([^)\n]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]|<(?:https?:\/\/|mailto:)[^>\s]*>|https?:\/\/[^\s<>)\]]+/g;

/**
 * The stretches of a Markdown source that render as plain text: everything
 * but fenced code, code spans, links (their words too) and addresses.
 */
export function markdownPlainRuns(source: string): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let offset = 0;
  let fence: string | null = null;
  let blockStart = 0;
  const flush = (end: number) => {
    if (end <= blockStart) return;
    const block = source.slice(blockStart, end);
    let from = 0;
    for (const skip of block.matchAll(INLINE_SKIP)) {
      if (skip.index > from) runs.push({ start: blockStart + from, end: blockStart + skip.index });
      from = skip.index + skip[0].length;
    }
    if (from < block.length) runs.push({ start: blockStart + from, end });
  };
  for (const line of source.split("\n")) {
    const marker = FENCE.exec(line)?.[1] ?? null;
    if (fence === null && marker) {
      flush(offset);
      fence = marker;
    } else if (fence !== null && marker && marker.charAt(0) === fence.charAt(0) && marker.length >= fence.length && line.trim() === marker) {
      fence = null;
      blockStart = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  // An unclosed fence runs to the end (a reply cut short): nothing after it is plain.
  if (fence === null) flush(source.length);
  return runs;
}

/** The terms a Markdown reply shows outside code and links, with offsets into the source. */
export function matchTermsInMarkdown(matcher: TermMatcher, source: string, max: number = TERM_MARKS_PER_MESSAGE): TermMatch[] {
  if (matcher.size === 0 || source === "") return [];
  const out: TermMatch[] = [];
  let state = newTermScan(max);
  for (const run of markdownPlainRuns(source)) {
    if (state.left <= 0) break;
    const scanned = scanTerms(matcher, source.slice(run.start, run.end), state);
    state = scanned.state;
    for (const match of scanned.matches) out.push({ start: run.start + match.start, end: run.start + match.end, termId: match.termId });
  }
  return out;
}

/** Whether any term appears in the reply (the cheap question a transcript asks of every message). */
export function hasTermInMarkdown(matcher: TermMatcher, source: string): boolean {
  return matchTermsInMarkdown(matcher, source, 1).length > 0;
}
