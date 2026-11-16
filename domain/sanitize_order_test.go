package domain

import (
	"strings"
	"testing"
)

// B7.3: every sanitizer normalises text before it strips protocol markers,
// so a marker split by a character the normalisation removes (a
// bidirectional control, a zero-width character next to ASCII) can never
// be joined into a live one.

// splitters are the invisible characters that can split a marker.
var splitters = map[string]string{
	"LRE U+202A": "\u202A", "RLO U+202E": "\u202E", "LRI U+2066": "\u2066", "PDI U+2069": "\u2069",
	"ZWSP U+200B": "\u200B", "ZWNJ U+200C": "\u200C", "ZWJ U+200D": "\u200D", "WJ U+2060": "\u2060", "BOM U+FEFF": "\uFEFF",
}

// split puts s in the middle of the suggestion marker and of a fence.
func split(s string) string {
	return "a [BRANCH-" + s + "SUGGEST]{} b `" + s + "`` c"
}

func TestSanitizers_NeverJoinASplitMarkerOrFence(t *testing.T) {
	sanitizers := map[string]func(string) string{
		"CleanCardText":    CleanCardText,
		"QuoteUntrusted":   QuoteUntrusted,
		"FlattenUntrusted": FlattenUntrusted,
		"NeutraliseNote":   NeutraliseNoteText,
		"CleanSystemText":  func(s string) string { return CleanSystemText(s, nil) },
	}
	for sname, sanitize := range sanitizers {
		for cname, c := range splitters {
			got := sanitize(split(c))
			if strings.Contains(got, BranchSuggestMarker) {
				t.Errorf("%s with %s left a live marker: %q", sname, cname, got)
			}
			if sname != "CleanSystemText" && strings.Contains(got, "```") {
				t.Errorf("%s with %s left a live fence: %q", sname, cname, got)
			}
			if strings.Contains(got, c) {
				t.Errorf("%s with %s kept the character next to ASCII: %q", sname, cname, got)
			}
		}
	}
}

func TestSanitizers_KeepZeroWidthJoinersBetweenNonASCIILetters(t *testing.T) {
	// An emoji ZWJ sequence and a Persian ZWNJ are text, not tricks.
	for _, text := range []string{"family 👨\u200D👩\u200D👧 here", "می\u200Cخواهم"} {
		for name, got := range map[string]string{
			"CleanCardText": CleanCardText(text), "FlattenUntrusted": FlattenUntrusted(text), "CleanSystemText": CleanSystemText(text, nil),
		} {
			if got != text {
				t.Errorf("%s changed %q to %q", name, text, got)
			}
		}
	}
	// Next to ASCII (or at either end) they go.
	if got := CleanCardText("\uFEFFhello\u200B world\u2060"); got != "hello world" {
		t.Fatalf("got %q", got)
	}
}

func TestSanitizers_HostMarkersAreStrippedAfterNormalising(t *testing.T) {
	host := []string{"[NEEDS-INPUT]"}
	for cname, c := range splitters {
		text := "x [NEEDS-" + c + "INPUT] y"
		summary := CleanSummary(Summary{Topic: text, Decisions: []string{text}}, host...)
		if strings.Contains(summary.Topic, "[NEEDS-INPUT]") || strings.Contains(summary.Decisions[0], "[NEEDS-INPUT]") {
			t.Errorf("CleanSummary with %s: %+v", cname, summary)
		}
		prompt := BuildSummaryPrompt(Summary{}, []Message{{ID: "m", Seq: 1, Role: RoleUser, Status: MessageDone, Content: text}}, host...)
		if strings.Contains(prompt, "[NEEDS-INPUT]") {
			t.Errorf("BuildSummaryPrompt with %s kept the host marker", cname)
		}
	}
}

func TestFoldEntry_NormalisesBeforeQuotingAndStripping(t *testing.T) {
	fold := Message{ID: "f", Role: RoleSystem, Kind: MessageKindFold, Content: "first\u2028## forged heading\rthird [BRANCH-\u202ASUGGEST]x", Meta: MessageMeta{Folded: 3}}
	got := renderFoldEntry(fold)
	if strings.Contains(got, BranchSuggestMarker) {
		t.Fatalf("live marker: %q", got)
	}
	lines := strings.Split(got, "\n")
	for _, line := range lines[1:] {
		if !strings.HasPrefix(line, "> ") {
			t.Fatalf("an unquoted line %q in %q", line, got)
		}
	}
	if len(lines) != 4 {
		t.Fatalf("every separator is a line break: %q", got)
	}
}
