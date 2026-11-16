package domain

import (
	"strings"
	"unicode"
)

// Untrusted text (a purpose, a selected excerpt, message bodies, the rolling
// summary, card fields, notes) ends up in prompts. These helpers keep it from
// forging prompt structure: it is quoted ("> " on every line) or flattened to
// one line, code fences are neutralised and every protocol marker the library
// parses out of a reply is removed, so an echo can never trigger that
// handling. A host whose own runtime parses further markers out of replies
// (for example [NEEDS-INPUT], [DAG-PROPOSAL], …) passes them as ExtraMarkers
// to the pack, prompt, draft and summary builders; they are then removed from
// every piece of library-rendered data as well.

// Markers the library parses out of model output.
const (
	// SummaryMarker prefixes the JSON digest in a summary reply.
	SummaryMarker = "[SESSION-SUMMARY]"
	// BranchCardMarker prefixes the card JSON in a draft reply.
	BranchCardMarker = "[BRANCH-CARD]"
	// BranchSuggestMarker starts a suggestion line in an assistant reply.
	BranchSuggestMarker = "[BRANCH-SUGGEST]"
)

// agentMarkers are every delimiter the library parses out of a reply, with
// their closing forms. None of them may appear in text shown to a model.
func agentMarkers() []string {
	out := []string{}
	for _, opening := range []string{SummaryMarker, BranchCardMarker, BranchSuggestMarker, LeafDraftMarker, GoalProposeMarker, DriftCheckMarker, RelationSuggestMarker, GroupSummaryMarker, GroupSuggestMarker, IbisTagMarker, FoldSummaryMarker, DivergeMarker, ConvergeMarker, MemoryExtractMarker, MemoryConsolidateMarker, TopicMarker, ChapterCutMarker} {
		out = append(out, opening, "[/"+strings.TrimPrefix(opening, "["))
	}
	return out
}

// ProtocolMarkers lists every marker the library parses (with closing
// forms) and the host's extra markers: what must never reach an operator as
// the start of a streamed line.
func ProtocolMarkers(extra []string) []string {
	return append(agentMarkers(), hostMarkers(extra)...)
}

// StripAgentMarkers removes every protocol marker from text. It repeats until
// nothing changes, so a marker built by removing another ("[BRANCH-[…]CARD]")
// is removed too.
func StripAgentMarkers(text string) string {
	return StripMarkers(text, agentMarkers())
}

// lineBreaks turns every line separator a renderer might honour into "\n", so
// quoting each line cannot be bypassed with a bare CR, VT, FF, NEL, LS or PS.
var lineBreaks = strings.NewReplacer("\r\n", "\n", "\r", "\n", "\v", "\n", "\f", "\n", "\u0085", "\n", "\u2028", "\n", "\u2029", "\n")

// isBidiControl reports the bidirectional embedding, override and isolate
// controls (U+202A-U+202E, U+2066-U+2069), which reorder text on screen.
func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

// isZeroWidth reports the invisible characters that can split a marker
// without showing: zero-width space, non-joiner and joiner, word joiner and
// the byte order mark (zero-width no-break space).
func isZeroWidth(r rune) bool {
	return (r >= 0x200B && r <= 0x200D) || r == 0x2060 || r == 0xFEFF
}

// plainLines normalises line separators, removes the bidirectional controls
// and replaces every other control character except tab with a space, so no
// consumer can read one as a break and no text is displayed reordered. It
// also removes zero-width characters next to ASCII (see dropZeroWidth).
// Every sanitizer runs it before stripping markers, so whatever it removes
// can never join a split marker into a live one.
func plainLines(text string) string {
	return dropZeroWidth(strings.Map(func(r rune) rune {
		if isBidiControl(r) {
			return -1
		}
		if r != '\n' && r != '\t' && unicode.IsControl(r) {
			return ' '
		}
		return r
	}, lineBreaks.Replace(text)))
}

// dropZeroWidth removes every run of zero-width characters that touches an
// ASCII character or either end of the text. Protocol markers are ASCII, so
// no run inside one survives; a run between two non-ASCII characters (an
// emoji ZWJ sequence, a Persian or Indic ZWNJ) is text and stays.
func dropZeroWidth(text string) string {
	if !strings.ContainsFunc(text, isZeroWidth) {
		return text
	}
	runes := []rune(text)
	out := make([]rune, 0, len(runes))
	for i := 0; i < len(runes); {
		if !isZeroWidth(runes[i]) {
			out = append(out, runes[i])
			i++
			continue
		}
		end := i
		for end < len(runes) && isZeroWidth(runes[end]) {
			end++
		}
		if i > 0 && end < len(runes) && runes[i-1] > unicode.MaxASCII && runes[end] > unicode.MaxASCII {
			out = append(out, runes[i:end]...)
		}
		i = end
	}
	return string(out)
}

// MarkerLineStart is a line as marker-line detection sees it: leading white
// space, bidirectional controls and zero-width characters removed, so an
// invisible character before a marker cannot hide the line from the stream
// filter or the reply parser (both use it, so they agree).
func MarkerLineStart(line string) string {
	return strings.TrimLeftFunc(line, func(r rune) bool { return unicode.IsSpace(r) || isBidiControl(r) || isZeroWidth(r) })
}

// cleanUntrusted is the common first pass of untrusted text: normalised
// (plainLines), then every protocol marker and the host's extra markers
// removed, then code fences defused. The order matters: stripping before
// normalising let a marker split by a removed character come back.
func cleanUntrusted(text string, extraMarkers []string) string {
	markers := agentMarkers()
	if len(extraMarkers) > 0 {
		markers = ProtocolMarkers(extraMarkers)
	}
	return strings.ReplaceAll(StripMarkers(plainLines(text), markers), "```", "'''")
}

// branchQuote renders untrusted multi-line text as a quoted block.
func branchQuote(text string) string {
	text = strings.TrimSpace(cleanUntrusted(text, nil))
	if text == "" {
		return "> (empty)"
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = "> " + line
	}
	return strings.Join(lines, "\n")
}

// branchLine renders untrusted text as one flat line (markers removed).
func branchLine(text string) string {
	return flattenWith(text, nil)
}

// flattenWith is branchLine that also removes the host's extra markers
// (after normalising, like the library's own).
func flattenWith(text string, extraMarkers []string) string {
	return strings.Join(strings.Fields(cleanUntrusted(text, extraMarkers)), " ")
}

// CleanCardText neutralises untrusted card text: every kind of line break
// normalised to "\n", bidirectional controls and zero-width characters next
// to ASCII removed, other control characters replaced by spaces, then
// protocol markers removed (repeatedly) and fences defused.
func CleanCardText(text string) string {
	return strings.TrimSpace(cleanUntrusted(text, nil))
}

// CleanSystemText cleans the text of a host system message (shown to
// operators and, labelled "system: ", in later prompts): line separators
// are normalised to "\n", bidirectional controls (and zero-width characters
// next to ASCII) removed and other control characters replaced by spaces,
// then every protocol marker (the library's
// and extraMarkers) is removed and the outer space trimmed. Unlike card text
// it keeps code fences: the message is displayed as written.
func CleanSystemText(text string, extraMarkers []string) string {
	return strings.TrimSpace(StripMarkers(plainLines(text), ProtocolMarkers(extraMarkers)))
}

// QuoteUntrusted renders untrusted multi-line text the way the library quotes
// data in prompts: protocol markers removed, fences defused, every line
// prefixed with "> ". Hosts use it for untrusted data in their PromptSection
// bodies.
func QuoteUntrusted(text string) string { return branchQuote(text) }

// FlattenUntrusted renders untrusted text as one safe line: protocol markers,
// fences, control characters and line breaks removed.
func FlattenUntrusted(text string) string { return branchLine(text) }

// StripMarkers removes every one of markers from text, repeating until
// nothing changes. Empty markers are ignored.
func StripMarkers(text string, markers []string) string {
	for {
		before := text
		for _, marker := range markers {
			if marker != "" {
				text = strings.ReplaceAll(text, marker, "")
			}
		}
		if text == before {
			return text
		}
	}
}

// hostMarkers keeps the host's extra markers that are not empty and not one
// of the library's own (those are always stripped from data and must stay in
// the fixed instruction text).
func hostMarkers(extra []string) []string {
	own := map[string]bool{}
	for _, marker := range agentMarkers() {
		own[marker] = true
	}
	out := []string{}
	for _, marker := range extra {
		if marker != "" && !own[marker] {
			out = append(out, marker)
		}
	}
	return out
}
