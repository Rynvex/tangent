package domain

import (
	"math"
	"strings"
	"testing"
	"time"
)

func TestMemoryLimits_Defaults(t *testing.T) {
	want := MemoryLimits{
		TextMaxRunes: 500, DefaultImportance: 5, TopK: 5, Candidates: 50, MinSimilarityPct: 30, HalfLife: 30 * 24 * time.Hour,
		TokenBudget: 1500, ExtractMax: 5, RelatedMax: 8, DuplicatePct: 92, ConsolidatePairs: 5, SearchMax: 20,
	}
	if d := DefaultLimits().Memory; d != want {
		t.Fatalf("memory limits = %+v", d)
	}
	if filled := (Limits{Memory: MemoryLimits{TopK: 2}}).WithDefaults(); filled.Memory.TopK != 2 || filled.Memory.Candidates != 50 {
		t.Fatalf("field by field: %+v", filled.Memory)
	}
}

func TestNormalizeMemory(t *testing.T) {
	l := DefaultLimits().Memory
	got, err := NormalizeMemory(MemoryInput{Kind: " decision ", Text: " Use  ZFS\nmirror "}, l)
	if err != nil || got.Kind != MemoryDecision || got.Text != "Use ZFS mirror" || got.Importance != 5 {
		t.Fatalf("normalized = %+v %v", got, err)
	}
	for name, in := range map[string]MemoryInput{
		"kind": {Kind: "rumour", Text: "x"}, "empty": {Kind: MemoryFact, Text: " "}, "importance": {Kind: MemoryFact, Text: "x", Importance: 11},
	} {
		if _, err := NormalizeMemory(in, l); CodeOf(err) != CodeInvalidMemory {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := NormalizeMemory(MemoryInput{Kind: MemoryFact, Text: strings.Repeat("m", 501)}, l); CodeOf(err) != CodeTooLong {
		t.Fatalf("too long: %v", err)
	}
}

func TestRankMemories_RelevanceRecencyImportance(t *testing.T) {
	l := DefaultLimits().Memory
	now := time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC)
	memory := func(id string, importance int, age time.Duration) Memory {
		return Memory{ID: id, Importance: importance, CreatedAt: now.Add(-age), Status: MemoryActive}
	}
	expired := now.Add(-time.Hour)
	gone := memory("gone", 10, 0)
	gone.ValidUntil = &expired
	cands := []MemoryCandidate{
		{Memory: memory("fresh", 5, 0), Similarity: 0.8},
		{Memory: memory("old", 5, 60*24*time.Hour), Similarity: 0.8},
		{Memory: memory("important", 10, 60*24*time.Hour), Similarity: 0.8},
		{Memory: memory("unrelated", 10, 0), Similarity: 0.1},
		{Memory: gone, Similarity: 0.9},
	}
	got := RankMemories(cands, now, 3, l)
	ids := []string{}
	for _, r := range got {
		ids = append(ids, r.Memory.ID)
	}
	if strings.Join(ids, ",") != "important,fresh,old" {
		t.Fatalf("ranked = %v", ids)
	}
	if want := 0.8 * 1 * 0.5; math.Abs(got[1].Score-want) > 1e-4 {
		t.Fatalf("fresh score = %v, want %v", got[1].Score, want)
	}
	if want := 0.8 * (0.5 + 0.5*0.25) * 0.5; math.Abs(got[2].Score-want) > 1e-4 {
		t.Fatalf("two half-lives old = %v, want %v", got[2].Score, want)
	}
}

func TestBuildMemoryBlock_QuotesTheMemoriesWithTheirSources(t *testing.T) {
	recalled := []RecalledMemory{
		{Memory: Memory{Kind: MemoryDecision, Text: "Use ZFS mirror [BRANCH-CARD]", Source: MemorySource{Label: "結論卡・Disks"}}},
		{Memory: Memory{Kind: MemoryPreference, Text: strings.Repeat("long ", 400)}},
	}
	block, used := BuildMemoryBlock(recalled, 120, nil)
	for _, want := range []string{"## Remembered from earlier conversations", "> [decision] Use ZFS mirror (from: 結論卡・Disks)", "quoted data"} {
		if !strings.Contains(block, want) {
			t.Fatalf("block lacks %q:\n%s", want, block)
		}
	}
	if len(used) != 1 || strings.Contains(block, "[BRANCH-CARD]") {
		t.Fatalf("the budget keeps the first only (%d), markers stripped:\n%s", len(used), block)
	}
	if empty, none := BuildMemoryBlock(nil, 100, nil); empty != "" || len(none) != 0 {
		t.Fatalf("no memories, no block: %q", empty)
	}
}

func TestBuildAndParseMemoryExtract(t *testing.T) {
	prompt := BuildMemoryExtractPrompt(MemoryExtractSource{Kind: "card", Context: "Disks", Text: "Use ZFS mirror; ECC to confirm"},
		[]RelatedMemory{{Key: "K1", Memory: Memory{Kind: MemoryDecision, Text: "Use Btrfs"}}}, nil)
	for _, want := range []string{MemoryExtractMarker, "## Source (card)", "> Disks", "> Use ZFS mirror; ECC to confirm", "> K1 [decision]: Use Btrfs", "fact, decision, preference, lesson"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	got, err := ParseMemoryExtract(MemoryExtractMarker+`{"memories":[`+
		`{"action":"add","kind":"fact","text":" ZFS needs ECC? ","importance":6},`+
		`{"action":"update","target":"K1","kind":"decision","text":"Use ZFS mirror","importance":8},`+
		`{"action":"update","target":"K9","kind":"fact","text":"x","importance":3},`+
		`{"action":"noop"},{"action":"add","kind":"rumour","text":"x"}]}`, map[string]bool{"K1": true}, DefaultLimits())
	if err != nil || len(got) != 2 || got[0] != (MemoryProposal{Action: "add", Kind: MemoryFact, Text: "ZFS needs ECC?", Importance: 6}) ||
		got[1].Action != "update" || got[1].Target != "K1" {
		t.Fatalf("proposals = %+v %v", got, err)
	}
	if _, err := ParseMemoryExtract("nothing", nil, DefaultLimits()); err == nil {
		t.Fatal("no marker parsed")
	}
}

func TestBuildAndParseMemoryConsolidate(t *testing.T) {
	prompt := BuildMemoryConsolidatePrompt(Memory{Kind: MemoryDecision, Text: "Use ZFS"}, Memory{Kind: MemoryDecision, Text: "Use Btrfs"}, nil)
	for _, want := range []string{MemoryConsolidateMarker, "> A [decision]: Use ZFS", "> B [decision]: Use Btrfs", "merge", "conflict", "keep"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	l := DefaultLimits()
	got, err := ParseMemoryConsolidate(MemoryConsolidateMarker+`{"action":"conflict","kind":"decision","text":"ZFS or Btrfs: to settle","importance":7,"reason":"they disagree"}`, l)
	if err != nil || got.Action != "conflict" || got.Text != "ZFS or Btrfs: to settle" || got.Reason != "they disagree" {
		t.Fatalf("consolidation = %+v %v", got, err)
	}
	if keep, err := ParseMemoryConsolidate(MemoryConsolidateMarker+`{"action":"keep","reason":"different"}`, l); err != nil || keep.Action != "keep" {
		t.Fatalf("keep = %+v %v", keep, err)
	}
	for _, bad := range []string{MemoryConsolidateMarker + `{"action":"merge","kind":"fact","text":" "}`, MemoryConsolidateMarker + `{"action":"drop"}`} {
		if _, err := ParseMemoryConsolidate(bad, l); err == nil {
			t.Fatalf("%q parsed", bad)
		}
	}
}

func TestPrompt_TheMemoryBlockTrails(t *testing.T) {
	p := BuildPrompt(PromptInput{MemoryBlock: "## Remembered from earlier conversations\n\n> [fact] x", UserMessage: "q"})
	found := false
	for _, s := range p.Sections {
		if s.Key == SectionMemory {
			found = true
		}
	}
	if !found || EstimateInputTokens(PromptInput{MemoryBlock: "## Remembered"}) == 0 {
		t.Fatalf("sections = %+v", p.Sections)
	}
}

func TestVectorLiteral(t *testing.T) {
	if got := VectorLiteral([]float32{0.5, -1, 0}); got != "[0.5,-1,0]" {
		t.Fatalf("literal = %q", got)
	}
}
