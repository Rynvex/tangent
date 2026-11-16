/**
 * Cleans the decompose plan's `suggestedTags` for display (F13). Before
 * B18.1 the server cut Chinese into overlapping two-character pairs, so a
 * conversation about 微分幾何 got ["微分", "分幾", "幾何", "何在", "研究"];
 * since B18.1 the server runs these same rules (domain.cleanSuggestedTags,
 * keep the two in step) and cleaning its answer again changes nothing. Here:
 * - ASCII / number words (postgres, mvcc, raid10) are kept as they are;
 * - tags already used on other conversations are kept;
 * - Han pairs that fall inside one topic word of the title (the title cut at
 *   punctuation and connectives such as 的、在、與) are joined back into the
 *   words they overlap in ("微分" + "分幾" + "幾何" → "微分幾何");
 * - other Han pairs are joined when they chain in the list (at most six
 *   characters), and a pair that starts or ends with a function character
 *   ("何在") is dropped.
 * `normalizeDecomposePlan` keeps the server's list untouched; only the UI
 * calls this.
 */
import { normalizeTag, TAG_MAX_RUNES } from "./b18-routes";

const HAN_ONLY = /^\p{Script=Han}+$/u;
const HAS_ASCII_WORD = /[a-z0-9]/;
/** Single characters that join or qualify words rather than name a topic. */
const FUNCTION_CHARS = /* @__PURE__ */ new Set(/* @__PURE__ */ Array.from("的了在是和與与及跟或就也都把被嗎吗呢吧啊很這这那個个們们之於于對对從从到會会還还又並并且則则但若中裡里要怎麼么什嘛呀"));
/** Words that split a title into topic words, longest first. */
const CONNECTIVES = ["為什麼", "为什么", "怎麼樣", "怎么样", "怎麼", "怎么", "如何", "什麼", "什么", "還是", "还是", "以及", "關於", "关于", "有關", "有关", "比較", "比较", "vs"];
const MAX_SEGMENT_RUNES = 8;
/** A tag joined from a chain of pairs the title does not name is at most this long. */
const MAX_CHAIN_RUNES = 6;

/** The title's topic words: runs of Han characters between punctuation, ASCII, connectives and function characters. */
export function titleTopicWords(title: string): string[] {
  let text = title;
  for (const connective of CONNECTIVES) text = text.split(connective).join(" ");
  const words: string[] = [];
  for (const run of text.split(/[^\p{Script=Han}]+/u)) {
    let current = "";
    for (const char of Array.from(run)) {
      if (FUNCTION_CHARS.has(char)) {
        if (Array.from(current).length >= 2) words.push(current);
        current = "";
      } else current += char;
    }
    if (Array.from(current).length >= 2) words.push(current);
  }
  return words.filter((word) => Array.from(word).length <= MAX_SEGMENT_RUNES);
}

/**
 * Joins the terms found in `word` into the stretches they cover by overlapping ("微分","分幾","幾何" in "微分幾何" → "微分幾何").
 * A term of any length matches, so an already joined word joins to itself.
 */
function joinInWord(word: string, terms: readonly string[]): string[] {
  const chars = Array.from(word);
  const spans = terms
    .flatMap((term) => {
      const length = Array.from(term).length;
      const out: Array<[number, number]> = [];
      for (let i = 0; i + length <= chars.length; i += 1) if (chars.slice(i, i + length).join("") === term) out.push([i, i + length - 1]);
      return out;
    })
    .sort((a, b) => a[0] - b[0]);
  const joined: Array<[number, number]> = [];
  for (const span of spans) {
    const last = joined.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else joined.push([...span]);
  }
  return joined.map(([from, to]) => chars.slice(from, to + 1).join(""));
}

const touchesFunction = (pair: string) => {
  const chars = Array.from(pair);
  return FUNCTION_CHARS.has(chars[0]!) || FUNCTION_CHARS.has(chars.at(-1)!);
};

/**
 * The tags worth showing, in the server's order (a joined word takes its
 * first pair's place), without repeats and without `exclude` (the line's
 * own tags).
 */
export function filterSuggestedTags(rawTags: readonly string[], title: string, existingTenantTags: readonly string[] = [], exclude: readonly string[] = []): string[] {
  return cleanSuggestedTags(rawTags, title, existingTenantTags, exclude, Number.POSITIVE_INFINITY);
}

/** `filterSuggestedTags` that stops at `limit` tags (the mock's decompose takes the first five, as `domain.cleanSuggestedTags`). */
export function cleanSuggestedTags(rawTags: readonly string[], title: string, existingTenantTags: readonly string[], exclude: readonly string[], limit: number): string[] {
  const existing = new Set(existingTenantTags.map(normalizeTag));
  const skip = new Set(exclude.map(normalizeTag));
  const words = titleTopicWords(title);
  // What would be dropped (fragments, own tags, too long) leaves the list before anything chains, so cleaning again changes nothing.
  const fragment = (tag: string) => !existing.has(tag) && !HAS_ASCII_WORD.test(tag) && HAN_ONLY.test(tag) && !words.some((word) => word.includes(tag)) && touchesFunction(tag);
  const tags = [...new Set(rawTags.map(normalizeTag).filter(Boolean))].filter((tag) => !skip.has(tag) && Array.from(tag).length <= TAG_MAX_RUNES && !fragment(tag));
  const out: string[] = [];
  const add = (tag: string) => {
    if (tag && !out.includes(tag) && !skip.has(tag) && Array.from(tag).length <= TAG_MAX_RUNES) out.push(tag);
  };
  const handled = new Set<string>();
  for (let i = 0; i < tags.length && out.length < limit; i += 1) {
    const tag = tags[i]!;
    if (handled.has(tag)) continue;
    if (existing.has(tag) || HAS_ASCII_WORD.test(tag) || !HAN_ONLY.test(tag)) {
      add(tag);
      continue;
    }
    const word = words.find((candidate) => candidate.includes(tag));
    if (word) {
      // Every Han term inside the word joins, a tag the tenant uses included, so the word is never cut short ("微分" + "分幾"
      // with a used "幾何" must not give "微分幾"); a used tag is still kept on its own as well (B19, domain.cleanSuggestedTags).
      const inWord = tags.filter((other) => HAN_ONLY.test(other) && word.includes(other));
      for (const other of inWord) if (!existing.has(other)) handled.add(other);
      for (const joined of joinInWord(word, inWord)) add(joined);
      continue;
    }
    // A chain of pairs in the list (a[1] = b[0]) is one word the title does not name.
    let joined = tag;
    for (let j = i + 1; j < tags.length; j += 1) {
      const next = tags[j]!;
      const length = Array.from(joined).length;
      if (!HAN_ONLY.test(next) || handled.has(next) || Array.from(next).length !== 2 || Array.from(joined).at(-1) !== Array.from(next)[0] || length + 1 > MAX_CHAIN_RUNES) break;
      joined += Array.from(next)[1];
      handled.add(next);
    }
    add(joined);
  }
  return out.slice(0, limit);
}
