package domain

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestNormalizeSearchQuery_TrimsAndBoundsTheLength(t *testing.T) {
	got, err := NormalizeSearchQuery("  分岔  ")
	if err != nil || got != "分岔" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, short := range []string{"", "   ", "a", " 字 "} {
		if _, err := NormalizeSearchQuery(short); CodeOf(err) != CodeInvalidInput {
			t.Fatalf("%q: code %q, want invalid_input", short, CodeOf(err))
		}
	}
	_, err = NormalizeSearchQuery(strings.Repeat("長", SearchQueryMaxRunes+1))
	if CodeOf(err) != CodeTooLong {
		t.Fatalf("code %q, want too_long", CodeOf(err))
	}
	var refusal *Error
	if !errors.As(err, &refusal) || refusal.Extra["field"] != "q" || refusal.Extra["max"] != SearchQueryMaxRunes {
		t.Fatalf("refusal %+v", refusal)
	}
	if _, err := NormalizeSearchQuery(strings.Repeat("長", SearchQueryMaxRunes)); err != nil {
		t.Fatal(err)
	}
}

func TestClampSearchLimit(t *testing.T) {
	cases := map[int]int{-1: SearchDefaultLimit, 0: SearchDefaultLimit, 1: 1, 50: 50, 51: SearchMaxLimit, 1000: SearchMaxLimit}
	for in, want := range cases {
		if got := ClampSearchLimit(in); got != want {
			t.Errorf("ClampSearchLimit(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestSearchLikePattern_EscapesWildcards(t *testing.T) {
	cases := map[string]string{
		"abc":     `%abc%`,
		"50%":     `%50\%%`,
		"a_b":     `%a\_b%`,
		`c:\path`: `%c:\\path%`,
		"中文":      `%中文%`,
	}
	for in, want := range cases {
		if got := SearchLikePattern(in); got != want {
			t.Errorf("SearchLikePattern(%q) = %q, want %q", in, got, want)
		}
	}
}

// highlighted returns the highlighted pieces of a snippet, reading the
// ranges as UTF-16 offsets (as a browser does).
func highlighted(t *testing.T, snippet string, ranges []TextRange) []string {
	t.Helper()
	units := utf16.Encode([]rune(snippet))
	out := []string{}
	for _, r := range ranges {
		if r.Start < 0 || r.End > len(units) || r.Start >= r.End {
			t.Fatalf("range %+v outside a snippet of %d units", r, len(units))
		}
		out = append(out, string(utf16.Decode(units[r.Start:r.End])))
	}
	return out
}

func TestSearchSnippet_ShortTextKeepsEverythingAndMarksEveryHit(t *testing.T) {
	snippet, ranges := SearchSnippet("Rust and rust and RUST", "rust", 120)
	if snippet != "Rust and rust and RUST" {
		t.Fatalf("snippet %q", snippet)
	}
	if got := highlighted(t, snippet, ranges); strings.Join(got, ",") != "Rust,rust,RUST" {
		t.Fatalf("highlights %v", got)
	}
}

func TestSearchSnippet_CentresALongTextOnTheFirstHit(t *testing.T) {
	text := strings.Repeat("前面的內容。", 40) + "我們決定用分岔對話來整理想法" + strings.Repeat("後面的內容。", 40)
	snippet, ranges := SearchSnippet(text, "分岔對話", 40)
	if !strings.HasPrefix(snippet, "…") || !strings.HasSuffix(snippet, "…") {
		t.Fatalf("a cut snippet is marked at both ends: %q", snippet)
	}
	if n := len([]rune(snippet)); n != 42 {
		t.Fatalf("snippet has %d runes, want 40 plus two ellipses", n)
	}
	if got := highlighted(t, snippet, ranges); len(got) != 1 || got[0] != "分岔對話" {
		t.Fatalf("highlights %v", got)
	}
	middle := ranges[0].Start + (ranges[0].End-ranges[0].Start)/2
	if middle < 15 || middle > 27 {
		t.Fatalf("the hit is not centred: %+v in %q", ranges[0], snippet)
	}
}

func TestSearchSnippet_HitsNearTheEdgesAndLineBreaks(t *testing.T) {
	text := "Kyoto\nin autumn" + strings.Repeat(" filler", 50)
	snippet, ranges := SearchSnippet(text, "kyoto in", 30)
	if strings.HasPrefix(snippet, "…") || !strings.HasSuffix(snippet, "…") {
		t.Fatalf("a hit at the start keeps the start: %q", snippet)
	}
	if strings.ContainsAny(snippet, "\n\r\t") {
		t.Fatalf("line breaks stay in the snippet: %q", snippet)
	}
	if got := highlighted(t, snippet, ranges); len(got) != 1 || got[0] != "Kyoto in" {
		t.Fatalf("highlights %v (line breaks match a space)", got)
	}
	tail := strings.Repeat("filler ", 50) + "the END"
	snippet, ranges = SearchSnippet(tail, "end", 30)
	if !strings.HasPrefix(snippet, "…") || strings.HasSuffix(snippet, "…") {
		t.Fatalf("a hit at the end keeps the end: %q", snippet)
	}
	if got := highlighted(t, snippet, ranges); len(got) != 1 || got[0] != "END" {
		t.Fatalf("highlights %v", got)
	}
}

func TestSearchSnippet_OffsetsCountUTF16UnitsAndMixedText(t *testing.T) {
	text := "🎉 慶祝 release v2 發佈 🎉 release notes"
	snippet, ranges := SearchSnippet(text, "release", 120)
	if got := highlighted(t, snippet, ranges); strings.Join(got, ",") != "release,release" {
		t.Fatalf("highlights %v", got)
	}
	if ranges[0].Start != 6 { // the emoji is two UTF-16 units
		t.Fatalf("first range %+v, want start 6", ranges[0])
	}
}

func TestSearchSnippet_NoHitKeepsTheStartWithoutHighlights(t *testing.T) {
	snippet, ranges := SearchSnippet(strings.Repeat("abc ", 100), "zzz", 20)
	if len(ranges) != 0 || !strings.HasPrefix(snippet, "abc") || !strings.HasSuffix(snippet, "…") {
		t.Fatalf("snippet %q ranges %v", snippet, ranges)
	}
	if snippet, ranges := SearchSnippet("", "x", 20); snippet != "" || len(ranges) != 0 {
		t.Fatalf("empty text: %q %v", snippet, ranges)
	}
}

// snippetPad is filler around the clusters of the grapheme tests.
var snippetPad = strings.Repeat("a", 20)

// padRunes is n runes of filler.
func padRunes(n int) string { return strings.Repeat("a", n) }

// With width 10 and the two-rune query "QQ", the window starts 4 runes
// before the match and ends 4 runes after it. Each case puts a cluster
// across one or both cuts: startL+startR straddle the start cut, endL+endR
// the end cut. The window must widen to keep each cluster whole.
func TestSearchSnippet_NeverCutsInsideAGrapheme(t *testing.T) {
	const zwj = "‍"
	cases := []struct {
		name                       string
		startL, startR, endL, endR string
	}{
		{name: "combining mark at the start", startL: "e", startR: "́"},
		{name: "combining mark at the end", endL: "e", endR: "́"},
		{name: "skin tone at the start", startL: "👋", startR: "\U0001F3FD"},
		{name: "skin tone at the end", endL: "👋", endR: "\U0001F3FD"},
		{name: "ZWJ family, start cut before a ZWJ", startL: "👨", startR: zwj + "👩" + zwj + "👧"},
		{name: "ZWJ family, start cut after a ZWJ", startL: "👨" + zwj, startR: "👩" + zwj + "👧"},
		{name: "ZWJ family, end cut after a ZWJ", endL: "👨" + zwj, endR: "👩" + zwj + "👧"},
		{name: "ZWJ family, end cut before a ZWJ", endL: "👨", endR: zwj + "👩" + zwj + "👧"},
		{name: "variation selector at the start", startL: "❤", startR: "️"},
		{name: "variation selector at the end", endL: "❤", endR: "️"},
		{name: "tag sequence at the start", startL: "🏴\U000E0067\U000E0062", startR: "\U000E0073\U000E0063\U000E0074\U000E007F"},
		{name: "both ends", startL: "👋", startR: "\U0001F3FD", endL: "👨" + zwj, endR: "👩" + zwj + "👧"},
		{name: "plain text", startL: "", startR: ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before := padRunes(4 - len([]rune(c.startR)))
			after := padRunes(4 - len([]rune(c.endL)))
			text := snippetPad + c.startL + c.startR + before + "QQ" + after + c.endL + c.endR + snippetPad
			snippet, ranges := SearchSnippet(text, "qq", 10)
			want := "…" + c.startL + c.startR + before + "QQ" + after + c.endL + c.endR + "…"
			if snippet != want {
				t.Fatalf("snippet %q (%U), want %q", snippet, []rune(snippet), want)
			}
			if got := highlighted(t, snippet, ranges); len(got) != 1 || got[0] != "QQ" {
				t.Fatalf("highlights %v", got)
			}
		})
	}
}

func TestSearchSnippet_GraphemeWideningIsBounded(t *testing.T) {
	marks := strings.Repeat("́", 500)
	text := "e" + marks + "QQ" + marks + snippetPad
	snippet, ranges := SearchSnippet(text, "qq", 10)
	if n := len([]rune(snippet)); n > 10+2*snippetGraphemeMaxShift+2 {
		t.Fatalf("snippet of %d runes: the widening ran away", n)
	}
	if got := highlighted(t, snippet, ranges); len(got) != 1 || got[0] != "QQ" {
		t.Fatalf("highlights %v", got)
	}
}

// ToLower alone misses these: the long s and the final sigma are already
// lower case, but fold together with s and Σ (as strings.EqualFold does).
func TestSearchSnippet_MatchesSimpleFoldEquivalents(t *testing.T) {
	cases := map[string][2]string{
		"long s":      {"Meſſage sent", "message"},
		"final sigma": {"ΣΟΦΟΣ λόγος", "σοφος"},
		"kelvin sign": {"273 K here", "273 k"},
	}
	for name, c := range cases {
		snippet, ranges := SearchSnippet(c[0], c[1], 120)
		if got := highlighted(t, snippet, ranges); len(got) != 1 || !strings.EqualFold(got[0], c[1]) {
			t.Errorf("%s: highlights %v in %q", name, got, snippet)
		}
	}
}
