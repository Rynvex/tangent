/**
 * The server's card-text cleaning (domain/sanitize.go `CleanCardText`),
 * mirrored so the review can refuse an excerpt the server would change (and
 * then reject as not verbatim). Keep in step with sanitize.go.
 */

/** The markers the library parses out of replies, with their closing forms (domain `agentMarkers`). */
export const PROTOCOL_MARKERS: readonly string[] = /* @__PURE__ */ ["[SESSION-SUMMARY]", "[BRANCH-CARD]", "[BRANCH-SUGGEST]"].flatMap((opening) => [opening, `[/${opening.slice(1)}`]);

/** Removes every marker, repeating until nothing changes (a marker built by removing another goes too). */
export function stripMarkers(text: string, markers: readonly string[] = PROTOCOL_MARKERS): string {
  let current = text;
  for (;;) {
    let next = current;
    for (const marker of markers) if (marker) next = next.split(marker).join("");
    if (next === current) return next;
    current = next;
  }
}

/** Every line separator a renderer might honour becomes "\n" (domain `lineBreaks`). */
const LINE_BREAKS = /\r\n|[\r\v\f\u0085\u2028\u2029]/g;
const isBidiControl = (code: number) => (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
/** Go's unicode.IsControl: C0 and C1 control characters. */
const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);

function plainLines(text: string): string {
  let out = "";
  for (const char of text.replace(LINE_BREAKS, "\n")) {
    const code = char.codePointAt(0) ?? 0;
    if (isBidiControl(code)) continue;
    out += char !== "\n" && char !== "\t" && isControl(code) ? " " : char;
  }
  return out;
}

/** domain.CleanCardText: markers removed, fences defused, breaks normalised, other controls spaced, trimmed. */
export function cleanCardText(text: string): string {
  return plainLines(stripMarkers(text).split("```").join("'''")).trim();
}
