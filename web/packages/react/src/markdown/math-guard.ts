// Markdown renderer component).
import { splitSegments } from "./segments";

/**
 * A valid inline formula follows the Pandoc rule: the opening `$` is not
 * followed by whitespace, the closing `$` is not preceded by whitespace and is
 * not followed by a digit. `$5 and $10` therefore stays a price.
 */
const INLINE_MATH = /\$(?![\s$])(?:\\.|[^$\n\\])*?(?<!\s)\$(?!\d)/y;
const CODE_SPAN = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

function escapeProseDollars(prose: string): string {
  let out = "";
  let index = 0;
  while (index < prose.length) {
    const char = prose[index];
    if (char === "\\") {
      out += prose.slice(index, index + 2);
      index += 2;
    } else if (char !== "$") {
      out += char;
      index += 1;
    } else if (prose[index + 1] === "$") {
      const close = prose.indexOf("$$", index + 2);
      const end = close === -1 ? prose.length : close + 2;
      out += prose.slice(index, end);
      index = end;
    } else {
      INLINE_MATH.lastIndex = index;
      const match = INLINE_MATH.exec(prose);
      if (match) {
        out += match[0];
        index += match[0].length;
      } else {
        out += "\\$";
        index += 1;
      }
    }
  }
  return out;
}

function escapeOutsideCodeSpans(text: string): string {
  let out = "";
  let last = 0;
  for (const span of text.matchAll(CODE_SPAN)) {
    out += escapeProseDollars(text.slice(last, span.index)) + span[0];
    last = (span.index ?? 0) + span[0].length;
  }
  return out + escapeProseDollars(text.slice(last));
}

/**
 * Backslash-escapes every `$` that is not part of a plausible formula, so the
 * math parser only sees real `$…$` and `$$…$$`. Code is left untouched.
 */
export function escapeCurrencyDollars(source: string): string {
  if (!source.includes("$")) return source;
  return splitSegments(source)
    .map((segment) => (segment.kind === "fence" ? segment.text : escapeOutsideCodeSpans(segment.text)))
    .join("");
}
