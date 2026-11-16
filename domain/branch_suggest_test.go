package domain

import (
	"strings"
	"testing"
)

func TestExtractBranchSuggestions_RemovesLinesAndKeepsValidOnes(t *testing.T) {
	l := DefaultLimits().Branch
	long := strings.Repeat("x", l.PurposeMaxRunes+1)
	content := "Answer.\n" +
		BranchSuggestMarker + `{"purpose":"  a [BRANCH-CARD]\nb ","kind":"investigate","excerpt":"` + strings.Repeat("e", l.ExcerptMaxRunes+1) + `"}` + "\n" +
		BranchSuggestMarker + `{"purpose":"` + long + `","kind":"investigate"}` + "\n" +
		BranchSuggestMarker + `{"purpose":"bad kind","kind":"merge"}` + "\n" +
		BranchSuggestMarker + `{"purpose":"ok","kind":"alternative","excerpt":"q"}` + " [/BRANCH-SUGGEST]\n" +
		"tail " + BranchSuggestMarker + " inline"
	cleaned, got := ExtractBranchSuggestions(content, l)
	if strings.Contains(cleaned, "BRANCH-SUGGEST") || !strings.HasPrefix(cleaned, "Answer.") {
		t.Fatalf("cleaned = %q", cleaned)
	}
	if len(got) != 1 || got[0] != (BranchSuggestion{Purpose: "ok", Kind: "alternative", Excerpt: "q"}) {
		t.Fatalf("suggestions = %+v", got)
	}
}

func TestExtractBranchSuggestions_SanitisesAndCaps(t *testing.T) {
	l := DefaultLimits().Branch
	var lines []string
	for range 5 {
		lines = append(lines, BranchSuggestMarker+`{"purpose":"p [SESSION-SUMMARY] q","kind":"aside"}`)
	}
	_, got := ExtractBranchSuggestions(strings.Join(lines, "\n"), l)
	if len(got) != BranchSuggestMax || got[0].Purpose != "p q" {
		t.Fatalf("suggestions = %+v", got)
	}
	if text, none := ExtractBranchSuggestions("nothing here", l); text != "nothing here" || none != nil {
		t.Fatalf("plain text changed: %q %v", text, none)
	}
}

func TestStripAgentMarkers_RemovesTheSuggestionMarker(t *testing.T) {
	if got := StripAgentMarkers("a" + BranchSuggestMarker + "b[/BRANCH-SUGGEST]c"); got != "abc" {
		t.Fatalf("got %q", got)
	}
}

func TestFindBranchSuggestion(t *testing.T) {
	meta := MessageMeta{Suggestions: []BranchSuggestion{{Purpose: "a", Kind: BranchKindInvestigate}, {Purpose: "b", Kind: BranchKindAlternative, Excerpt: "x"}}}
	if got, ok := FindBranchSuggestion(meta, "b", BranchKindAlternative); !ok || got.Excerpt != "x" {
		t.Fatalf("found = %+v %v", got, ok)
	}
	if _, ok := FindBranchSuggestion(meta, "b", BranchKindInvestigate); ok {
		t.Fatal("kind must match too")
	}
}

// Regression: a single ReplaceAll left a live marker behind when one marker
// was nested in another, and the closing form survived on kept lines.
func TestExtractBranchSuggestions_NestedAndClosingMarkersDoNotSurvive(t *testing.T) {
	content := "Answer [BRANCH-[BRANCH-SUGGEST]SUGGEST] here [/BRANCH-SUGGEST] done.\n" + BranchSuggestMarker + `{"purpose":"ok","kind":"investigate"}`
	cleaned, got := ExtractBranchSuggestions(content, DefaultLimits().Branch)
	if strings.Contains(cleaned, "BRANCH-SUGGEST") || cleaned != "Answer  here  done." || len(got) != 1 {
		t.Fatalf("cleaned = %q suggestions = %+v", cleaned, got)
	}
}
