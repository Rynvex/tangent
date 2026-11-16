package domain

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDivergeTargetPurpose(t *testing.T) {
	l := BranchLimits{PurposeMaxRunes: 30}
	cases := []struct {
		name           string
		target         DivergeTarget
		shared, anchor string
		want           string
		ok             bool
	}{
		{"own", DivergeTarget{Model: "m", Purpose: " Mine\nhere "}, "shared", "anchor", "Mine here", true},
		{"own too long", DivergeTarget{Model: "m", Purpose: strings.Repeat("x", 31)}, "", "", "", false},
		{"shared", DivergeTarget{Model: "gpt-5"}, "Queue design", "anchor", "Queue design · gpt-5", true},
		{"anchor cut to 40", DivergeTarget{Model: "m"}, "", strings.Repeat("字", 50), strings.Repeat("字", 25) + "… · m", true},
		{"long prefix keeps the model", DivergeTarget{Model: "sonnet"}, strings.Repeat("a", 40), "", strings.Repeat("a", 20) + "… · sonnet", true},
		{"no text at all", DivergeTarget{Model: "haiku"}, "", "  ", "haiku", true},
	}
	for _, c := range cases {
		got, ok := DivergeTargetPurpose(c.target, c.shared, c.anchor, l)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("%s: %q %v, want %q %v", c.name, got, ok, c.want, c.ok)
		}
		if ok && utf8.RuneCountInString(got) > l.PurposeMaxRunes {
			t.Errorf("%s: %q is over the limit", c.name, got)
		}
	}
	if got, _ := DivergeTargetPurpose(DivergeTarget{Model: "m"}, "", strings.Repeat("b", 50), BranchLimits{}); got != strings.Repeat("b", 39)+"… · m" {
		t.Errorf("the default limit leaves the anchor's 40 characters: %q", got)
	}
}

func TestBuildDivergeTargetsNote(t *testing.T) {
	targets := []DivergeTarget{{Provider: "openai", Model: "gpt-5"}, {Provider: "anthropic", Model: "haiku"}}
	note := BuildDivergeTargetsNote(1, targets, []string{"A · gpt-5", "Cheap"})
	if !strings.Contains(note, "> Cheap (anthropic/haiku)\n") || !strings.Contains(note, "The sibling branches:\n> A · gpt-5 (openai/gpt-5)") {
		t.Fatalf("note = %q", note)
	}
}

func TestNormalizeSeedTexts(t *testing.T) {
	if _, err := NormalizeSeedTexts(nil, ParkingLimits{}); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("empty: %v", err)
	}
	got, err := NormalizeSeedTexts([]string{" a\nb ", "c"}, ParkingLimits{})
	if err != nil || len(got) != 2 || got[0] != "a b" {
		t.Fatalf("got %v %v", got, err)
	}
}
