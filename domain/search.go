package domain

import (
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Search over a tenant's conversations (the search feature): main-line
// titles, branch purposes and finished operator and assistant messages.
// Matching is a case-insensitive substring (ILIKE), so Chinese, which has no
// word breaks, matches like any other text.

// Kinds of search hit.
const (
	SearchKindTitle   = "title"
	SearchKindPurpose = "purpose"
	SearchKindMessage = "message"
)

// Bounds of a search request.
const (
	SearchQueryMinRunes = 2
	SearchQueryMaxRunes = 200
	SearchDefaultLimit  = 20
	SearchMaxLimit      = 50
	// SearchSnippetRunes is how much text a hit shows around its match.
	SearchSnippetRunes = 120
)

// snippetEllipsis marks a snippet cut at either end.
const snippetEllipsis = "…"

// snippetGraphemeMaxShift bounds how far a snippet cut moves to keep a
// grapheme whole (an emoji ZWJ sequence with skin tones fits easily), so a
// run of stray combining marks cannot widen the window without end.
const snippetGraphemeMaxShift = 32

// TextRange is a highlighted range of a snippet, in UTF-16 code units (the
// offsets JavaScript strings use): Start inclusive, End exclusive.
type TextRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// SearchHit is one match. MessageID, Seq and Role are set for message hits
// only. Snippet is plain text (never HTML); Highlights mark the query in it.
// Score is the similarity of the matched text to the query (0..1), and At
// the time of the hit (the message, or the line's last activity), which
// orders hits of equal score.
type SearchHit struct {
	LineID     string      `json:"lineId"`
	RootLineID string      `json:"rootLineId"`
	Kind       string      `json:"kind"`
	MessageID  string      `json:"messageId,omitempty"`
	Seq        int64       `json:"seq,omitempty"`
	Role       string      `json:"role,omitempty"`
	Snippet    string      `json:"snippet"`
	Highlights []TextRange `json:"highlights"`
	Score      float64     `json:"score"`
	// RootTitle is the title of the hit's conversation; Purpose the purpose
	// of the branch it is in ("" on a main line).
	RootTitle string    `json:"rootTitle"`
	Purpose   string    `json:"purpose"`
	At        time.Time `json:"at"`
}

// NormalizeSearchQuery trims a query and checks its length: at least
// SearchQueryMinRunes (invalid_input), at most SearchQueryMaxRunes
// (too_long, field "q").
func NormalizeSearchQuery(query string) (string, error) {
	query = strings.TrimSpace(query)
	if n := utf8.RuneCountInString(query); n < SearchQueryMinRunes {
		return "", NewError(CodeInvalidInput, fmt.Sprintf("a search needs at least %d characters", SearchQueryMinRunes), nil)
	}
	if err := CheckRunes("q", query, SearchQueryMaxRunes); err != nil {
		return "", err
	}
	return query, nil
}

// ClampSearchLimit is the number of hits a search returns: the default for
// zero or less, at most SearchMaxLimit.
func ClampSearchLimit(limit int) int {
	if limit <= 0 {
		return SearchDefaultLimit
	}
	return min(limit, SearchMaxLimit)
}

// SearchLikePattern is the ILIKE pattern of a substring query, with the
// pattern's own wildcards and the escape character escaped (backslash, the
// default escape).
func SearchLikePattern(query string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(query)
	return "%" + escaped + "%"
}

// SearchSnippet cuts text to about width runes centred on the first
// case-insensitive match of query (never inside a grapheme), marks every
// match inside it and puts an ellipsis at each cut end. Line breaks and
// tabs show as spaces. A text without a match keeps its start and has no
// highlights.
func SearchSnippet(text, query string, width int) (string, []TextRange) {
	runes := []rune(text)
	for i, r := range runes {
		if r == '\n' || r == '\r' || r == '\t' {
			runes[i] = ' '
		}
	}
	matches := findFolded(runes, []rune(query))
	start, end := snippetWindow(runes, matches, len([]rune(query)), width)
	out := []rune{}
	if start > 0 {
		out = append(out, []rune(snippetEllipsis)...)
	}
	offset := len(out) - start
	out = append(out, runes[start:end]...)
	if end < len(runes) {
		out = append(out, []rune(snippetEllipsis)...)
	}
	return string(out), highlightRanges(out, matches, offset, start, end, len([]rune(query)))
}

// findFolded returns the rune positions of non-overlapping case-insensitive
// matches of query in text.
func findFolded(text, query []rune) []int {
	if len(query) == 0 || len(query) > len(text) {
		return nil
	}
	var out []int
	for i := 0; i+len(query) <= len(text); {
		if foldedAt(text, query, i) {
			out = append(out, i)
			i += len(query)
			continue
		}
		i++
	}
	return out
}

func foldedAt(text, query []rune, at int) bool {
	for j, q := range query {
		if !foldEqual(text[at+j], q) {
			return false
		}
	}
	return true
}

// foldEqual reports whether two runes are equal under simple case folding,
// as strings.EqualFold compares them.
func foldEqual(a, b rune) bool {
	if a == b {
		return true
	}
	for r := unicode.SimpleFold(a); r != a; r = unicode.SimpleFold(r) {
		if r == b {
			return true
		}
	}
	return false
}

// snippetWindow is the [start, end) rune window: the whole text when it
// fits, else about width runes centred on the first match (or the start),
// widened so neither cut falls inside a grapheme.
func snippetWindow(runes []rune, matches []int, queryRunes, width int) (int, int) {
	length := len(runes)
	if width <= 0 || length <= width {
		return 0, length
	}
	start := 0
	if len(matches) > 0 {
		start = matches[0] + queryRunes/2 - width/2
	}
	start = max(0, min(start, length-width))
	end := start + width
	for shift := 0; shift < snippetGraphemeMaxShift && splitsGrapheme(runes, start); shift++ {
		start--
	}
	for shift := 0; shift < snippetGraphemeMaxShift && splitsGrapheme(runes, end); shift++ {
		end++
	}
	return start, end
}

// zeroWidthJoiner glues emoji into one grapheme (a ZWJ sequence).
const zeroWidthJoiner = '\u200d'

// splitsGrapheme reports whether a cut before runes[at] falls inside a
// grapheme: the rune there extends the one before, or that one is a ZWJ.
// It approximates the Unicode rules with the standard library only.
func splitsGrapheme(runes []rune, at int) bool {
	if at <= 0 || at >= len(runes) {
		return false
	}
	return extendsGrapheme(runes[at]) || runes[at-1] == zeroWidthJoiner
}

// extendsGrapheme reports a rune that continues the grapheme before it:
// combining marks, variation selectors, the ZWJ, skin-tone modifiers and
// emoji tag characters.
func extendsGrapheme(r rune) bool {
	switch {
	case unicode.In(r, unicode.Mn, unicode.Me, unicode.Mc):
		return true
	case r >= 0xFE00 && r <= 0xFE0F, r == zeroWidthJoiner:
		return true
	case r >= 0x1F3FB && r <= 0x1F3FF, r >= 0xE0020 && r <= 0xE007F:
		return true
	}
	return false
}

// highlightRanges turns the matches inside [start, end) into UTF-16 ranges
// of the snippet out, where text rune i sits at out rune i+offset.
func highlightRanges(out []rune, matches []int, offset, start, end, queryRunes int) []TextRange {
	ranges := []TextRange{}
	for _, at := range matches {
		if at < start || at+queryRunes > end {
			continue
		}
		from := utf16Len(out[:at+offset])
		ranges = append(ranges, TextRange{Start: from, End: from + utf16Len(out[at+offset:at+offset+queryRunes])})
	}
	return ranges
}

func utf16Len(runes []rune) int { return len(utf16.Encode(runes)) }
