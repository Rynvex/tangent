package domain

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeTermKey_DropsSpaceFoldsWidthAndCase(t *testing.T) {
	cases := map[string]string{
		"Prompt Cache":    "promptcache",
		"  prompt\tcache": "promptcache",
		"ＡＰＩ":             "api",
		"連線　池":            "連線池",
		"MVCC":            "mvcc",
		"":                "",
		" 　 ":             "",
	}
	for in, want := range cases {
		if got := NormalizeTermKey(in); got != want {
			t.Errorf("NormalizeTermKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCleanTerm_OneLineWithinTheLimitAndItsKey(t *testing.T) {
	l := DefaultLimits().Glossary
	term, key, err := CleanTerm("  Write-ahead\r\n  log [NEEDS-INPUT] ", l, []string{"[NEEDS-INPUT]"})
	if err != nil {
		t.Fatal(err)
	}
	if term != "Write-ahead log" || key != "write-aheadlog" {
		t.Fatalf("term %q key %q", term, key)
	}
	if _, _, err := CleanTerm(" \n [SESSION-SUMMARY] ", l, nil); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("empty term: %v", err)
	} else if field := AsError(err, DefaultLimits()).Extra["field"]; field != "term" {
		t.Fatalf("field %v", field)
	}
	if _, _, err := CleanTerm(strings.Repeat("詞", l.TermMaxRunes), l, nil); err != nil {
		t.Fatalf("at the limit: %v", err)
	}
	if _, _, err := CleanTerm(strings.Repeat("詞", l.TermMaxRunes+1), l, nil); CodeOf(err) != CodeTooLong {
		t.Fatalf("too long: %v", err)
	}
}

func TestCleanTermExplanation_KeepsLinesWithinTheLimit(t *testing.T) {
	l := DefaultLimits().Glossary
	got, err := CleanTermExplanation(" first\r\nsecond\u0007 ", l, nil)
	if err != nil || got != "first\nsecond" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := CleanTermExplanation("  ", l, nil); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("empty: %v", err)
	} else if field := AsError(err, DefaultLimits()).Extra["field"]; field != "explanation" {
		t.Fatalf("field %v", field)
	}
	if _, err := CleanTermExplanation(strings.Repeat("a", l.ExplanationMaxRunes+1), l, nil); CodeOf(err) != CodeTooLong {
		t.Fatalf("too long: %v", err)
	}
}

func TestGlossaryLimits_DefaultsAndValidation(t *testing.T) {
	got := DefaultLimits().Glossary
	want := GlossaryLimits{TermMaxRunes: 60, ExplanationMaxRunes: 1000, MaxPerTree: 300, TokenBudget: 300}
	if got != want {
		t.Fatalf("defaults %+v", got)
	}
	if filled := (Limits{Glossary: GlossaryLimits{MaxPerTree: 5}}).WithDefaults().Glossary; filled.MaxPerTree != 5 || filled.TermMaxRunes != 60 {
		t.Fatalf("field by field: %+v", filled)
	}
	if err := (Limits{Glossary: GlossaryLimits{TokenBudget: -1}}).Validate(); err == nil {
		t.Fatal("a negative glossary limit was accepted")
	}
}

func TestTermErrors_CodesAndExtras(t *testing.T) {
	if CodeOf(ErrTermNotFound) != "term_not_found" || CodeOf(ErrTermLimit) != "term_limit" || CodeOf(ErrTermExists) != "term_exists" {
		t.Fatal("codes")
	}
	limit := AsError(ErrTermLimit, Limits{Glossary: GlossaryLimits{MaxPerTree: 7}})
	if limit.Extra["limit"] != 7 {
		t.Fatalf("term_limit extra %v", limit.Extra)
	}
	existing := Term{ID: "t1", Term: "MVCC"}
	exists := AsError(TermExists(existing), DefaultLimits())
	if exists.Code != CodeTermExists || exists.Extra["term"] != existing || !errors.Is(exists, ErrTermExists) {
		t.Fatalf("term_exists %+v", exists)
	}
}

func TestBuildGlossaryBlock_TermsOnlySortedWithinTheBudget(t *testing.T) {
	block := BuildGlossaryBlock([]string{"WAL", "mvcc", "B-tree"}, 300, nil)
	if !strings.Contains(block, "Terms the user has already asked about: B-tree, mvcc, WAL\n") {
		t.Fatalf("block:\n%s", block)
	}
	if !strings.HasPrefix(block, "## Glossary\n\n") || !strings.Contains(block, "do not explain them again unless the user asks") {
		t.Fatalf("block:\n%s", block)
	}
	if BuildGlossaryBlock(nil, 300, nil) != "" || BuildGlossaryBlock([]string{"x"}, 3, nil) != "" {
		t.Fatal("an empty or unaffordable block must be empty")
	}
}

func TestBuildGlossaryBlock_KeepsTheMostRecentWhenOverBudget(t *testing.T) {
	recentFirst := make([]string, 0, 400)
	for i := range 400 {
		recentFirst = append(recentFirst, "名詞"+string(rune('A'+i%26))+strings.Repeat("x", i%7)+string(rune(0x4E00+i)))
	}
	block := BuildGlossaryBlock(recentFirst, 300, nil)
	if got := EstimateTokens(block); got > 300 || got < 250 {
		t.Fatalf("block costs %d tokens", got)
	}
	if !strings.Contains(block, recentFirst[0]) || strings.Contains(block, recentFirst[399]) {
		t.Fatal("the most recent term must stay and the oldest go")
	}
}

func TestBuildGlossaryBlock_FlattensUntrustedTerms(t *testing.T) {
	block := BuildGlossaryBlock([]string{"a\nb [SESSION-SUMMARY] ```", "[NEEDS-INPUT]c"}, 300, []string{"[NEEDS-INPUT]"})
	if strings.Contains(block, "[SESSION-SUMMARY]") || strings.Contains(block, "[NEEDS-INPUT]") || strings.Contains(block, "```") {
		t.Fatalf("block:\n%s", block)
	}
	if strings.Count(block, "\n") != strings.Count(BuildGlossaryBlock([]string{"x"}, 300, nil), "\n") {
		t.Fatalf("a term broke the line:\n%s", block)
	}
}

func TestBuildPrompt_GlossaryAfterMemoryBeforeReplyLines(t *testing.T) {
	p := BuildPrompt(PromptInput{UserMessage: "hi", MemoryBlock: "## Remembered\n\nm\n", GlossaryBlock: "## Glossary\n\ng\n", RequestTopicSummary: true})
	order := []string{}
	for _, s := range p.Sections {
		order = append(order, s.Key)
	}
	joined := strings.Join(order, ",")
	if !strings.Contains(joined, SectionMemory+","+SectionGlossary+","+SectionReplyLines) {
		t.Fatalf("order %s", joined)
	}
	if EstimateInputTokens(PromptInput{GlossaryBlock: "## Glossary\n\ng\n"}) == 0 {
		t.Fatal("the glossary block must count in the shared budget")
	}
	host := BuildPrompt(PromptInput{HostSections: []PromptSection{{Key: SectionGlossary, Body: "h"}}})
	for _, s := range host.Sections {
		if s.Body == "h" && s.Key != "host:"+SectionGlossary {
			t.Fatalf("a host section kept the reserved key: %+v", s)
		}
	}
}
