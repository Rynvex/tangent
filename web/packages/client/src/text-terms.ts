/**
 * The words of a text as the decompose rules see them (domain/decompose_text.go,
 * ported by testing/mock-decompose.ts): lower-case ASCII words and
 * overlapping Han pairs, first appearance first, stopwords left out. Shared
 * by the mock's decompose plan and the import's topic splitting
 * (import-topics.ts), which only change the options.
 */

/**
 * `decomposeStopwords`: function words of English and Chinese that never make a topic. Built in a pure IIFE so a
 * bundle that never reads it (the demo's main entry, through the package's barrel) leaves it out.
 */
export const DECOMPOSE_STOPWORDS: ReadonlySet<string> = /* @__PURE__ */ (() =>
  new Set(
    (
      "the and for that this with you are was what how why can but not have has will would should could from about into your they them their there then than when which also just like more some any use using does did its it's one all out get let here yes " +
      "我們 你們 什麼 什么 這個 这个 那個 那个 可以 如果 一個 一个 沒有 没有 因為 因为 所以 就是 還是 还是 但是 然後 然后 怎麼 怎么 應該 应该 需要 問題 问题 時候 时候 知道 現在 现在 已經 已经 這樣 这样 不是 我想 請問 请问 一下 的是"
    ).split(" "),
  ))();

/** Runes of a text that are read (the start of a long reply is enough). */
export const TERM_SCAN_RUNES = 4000;

export const HAN = /\p{Script=Han}/u;
const ASCII_WORD = /[A-Za-z0-9]/;
const ASCII_PART = /[A-Za-z0-9_-]/;

export interface TermOptions {
  /** Shortest ASCII word kept (3 for decompose). */
  minAsciiRunes?: number;
  /** Whether a word or Han pair is left out (DECOMPOSE_STOPWORDS by default). */
  isStopword?: (term: string) => boolean;
  /** Runes read from the start of the text (TERM_SCAN_RUNES by default). */
  scanRunes?: number;
}

const decomposeStopword = (term: string) => DECOMPOSE_STOPWORDS.has(term);

/** A word with where it first appears (rune index) and whether it is a Han pair (`domain.importTerm`). */
export interface PlacedTerm {
  text: string;
  at: number;
  han: boolean;
}

/** Lower-case ASCII words of `minAsciiRunes` or more letters or digits and overlapping Han pairs, first appearance first, no stopwords. */
export function orderedTerms(text: string, options: TermOptions = {}): string[] {
  return orderedTermsAt(text, options).map((term) => term.text);
}

/** orderedTerms with each word's first position (`domain.importTopicTermsAt`). */
export function orderedTermsAt(text: string, options: TermOptions = {}): PlacedTerm[] {
  const minAscii = options.minAsciiRunes ?? 3;
  const isStopword = options.isStopword ?? decomposeStopword;
  const runes = Array.from(text.toLowerCase()).slice(0, options.scanRunes ?? TERM_SCAN_RUNES);
  const terms: PlacedTerm[] = [];
  const seen = new Set<string>();
  const add = (term: string, at: number, han: boolean) => {
    if (seen.has(term) || isStopword(term)) return;
    seen.add(term);
    terms.push({ text: term, at, han });
  };
  for (let i = 0; i < runes.length; ) {
    const r = runes[i]!;
    if (ASCII_WORD.test(r)) {
      let end = i;
      while (end < runes.length && ASCII_PART.test(runes[end]!)) end += 1;
      const word = runes.slice(i, end).join("").replace(/^[_-]+|[_-]+$/g, "");
      if (word.length >= minAscii) add(word, i, false);
      i = end;
    } else if (HAN.test(r)) {
      if (i + 1 < runes.length && HAN.test(runes[i + 1]!)) add(r + runes[i + 1]!, i, true);
      i += 1;
    } else {
      i += 1;
    }
  }
  return terms;
}
