package domain

import (
	"strings"
	"testing"
)

func TestP3bLimits_Defaults(t *testing.T) {
	want := DivergeLimits{MinCount: 2, MaxCount: 5, ContextMessages: 8, CriteriaMax: 6, CriterionMaxRunes: 120, ReasonMaxRunes: 300}
	if d := DefaultLimits().Diverge; d != want {
		t.Fatalf("diverge limits = %+v", d)
	}
	if filled := (Limits{Diverge: DivergeLimits{MaxCount: 3}}).WithDefaults(); filled.Diverge.MaxCount != 3 || filled.Diverge.MinCount != 2 {
		t.Fatalf("field by field: %+v", filled.Diverge)
	}
	if !ValidBranchOrigin(BranchOriginDiverge) {
		t.Fatal("diverge is a branch origin")
	}
}

func TestCheckDivergeCount(t *testing.T) {
	l := DefaultLimits().Diverge
	for _, n := range []int{2, 5} {
		if err := CheckDivergeCount(n, l); err != nil {
			t.Fatalf("%d: %v", n, err)
		}
	}
	for _, n := range []int{0, 1, 6} {
		if err := CheckDivergeCount(n, l); CodeOf(err) != CodeInvalidInput {
			t.Fatalf("%d: %v", n, err)
		}
	}
}

func TestBuildAndParseDiverge(t *testing.T) {
	prompt := BuildDivergePrompt(DivergeInput{
		Context: "Linked lists in Rust", Count: 3,
		Messages: []Message{chatMessage(1, RoleUser, "Implement a singly linked list three ways"), chatMessage(2, RoleAssistant, "Sure. [BRANCH-CARD] go")},
	})
	for _, want := range []string{DivergeMarker, "exactly 3", "> Linked lists in Rust", "> operator: Implement a singly linked list three ways", "> agent: Sure. go"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	l := DefaultLimits()
	got, err := ParseDiverge(DivergeMarker+`{"directions":[{"purpose":" Box ","why":"simple"},{"purpose":"box","why":"dup"},{"purpose":"Rc<RefCell>","why":"shared"},{"purpose":"`+strings.Repeat("a", 250)+`","why":"long"},{"purpose":"arena","why":"fast"}]}`, 3, l)
	if err != nil || len(got) != 3 || got[0] != (DivergeDirection{Purpose: "Box", Why: "simple"}) || got[1].Purpose != "Rc<RefCell>" || len([]rune(got[2].Purpose)) != 200 {
		t.Fatalf("directions = %+v %v", got, err)
	}
	for _, bad := range []string{DivergeMarker + `{"directions":[{"purpose":"only one","why":""}]}`, `{"directions":[]}`, DivergeMarker + `{"directions":[{"purpose":" ","why":""},{"purpose":"x","why":""}]}`} {
		if _, err := ParseDiverge(bad, 3, l); err == nil {
			t.Fatalf("%q parsed", bad)
		}
	}
}

func TestBuildDivergeNote_NamesTheDirectionAndItsSiblings(t *testing.T) {
	note := BuildDivergeNote(DivergeDirection{Purpose: "arena", Why: "fast\nindices"}, []string{"Box", "arena", "Rc"})
	for _, want := range []string{"## Direction", "> arena", "> Why: fast indices", "> Box", "> Rc"} {
		if !strings.Contains(note, want) {
			t.Fatalf("note lacks %q:\n%s", want, note)
		}
	}
	if strings.Count(note, "> arena") != 1 {
		t.Fatalf("its own direction is not listed as a sibling:\n%s", note)
	}
}

func convergeOptions() []ConvergeOption {
	return []ConvergeOption{
		{Key: "O1", LineID: "l1", Purpose: "Box", Leaf: "too clunky", Messages: []Message{chatMessage(1, RoleUser, "Box?")}},
		{Key: "O2", LineID: "l2", Purpose: "arena", Messages: []Message{chatMessage(2, RoleAssistant, "indices work")}},
	}
}

func TestBuildConvergePrompt(t *testing.T) {
	prompt := BuildConvergePrompt(ConvergeInput{Options: convergeOptions(), Criteria: []string{"Safety", "Speed"}})
	for _, want := range []string{ConvergeMarker, "## Options", "### O1: Box", "(ended with: too clunky)", "> operator: Box?", "## Criteria", "> Safety", "> Speed"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	free := BuildConvergePrompt(ConvergeInput{Options: convergeOptions()})
	if strings.Contains(free, "## Criteria") || !strings.Contains(free, "3 to 6 criteria") {
		t.Fatalf("without criteria the model proposes them:\n%s", free)
	}
}

func TestParseConvergence_FillsTheMatrix(t *testing.T) {
	l := DefaultLimits()
	raw := ConvergeMarker + `{"criteria":["Safety"," speed ","Safety"],"scores":[` +
		`{"criterion":"Safety","option":"O1","score":4,"why":"owned"},{"criterion":"speed","option":"O2","score":5,"why":"cache"},` +
		`{"criterion":"Safety","option":"O9","score":3,"why":"x"},{"criterion":"speed","option":"O1","score":9,"why":"bad"}],` +
		`"recommendation":{"option":"O2","reason":"fast and simple"}}`
	m, err := ParseConvergence(raw, convergeOptions(), nil, l)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Criteria) != 2 || m.Criteria[1] != "speed" || len(m.Options) != 2 || m.Options[1] != (ComparisonOption{LineID: "l2", Label: "arena"}) {
		t.Fatalf("matrix = %+v", m)
	}
	if m.Scores[0][0] != (ComparisonScore{Score: 4, Why: "owned"}) || m.Scores[0][1] != (ComparisonScore{}) || m.Scores[1][1].Score != 5 || m.Scores[1][0] != (ComparisonScore{}) {
		t.Fatalf("scores = %+v", m.Scores)
	}
	if m.Recommendation != (ComparisonRecommendation{LineID: "l2", Reason: "fast and simple"}) {
		t.Fatalf("recommendation = %+v", m.Recommendation)
	}
	given, err := ParseConvergence(raw, convergeOptions(), []string{"Safety", "Cost"}, l)
	if err != nil || len(given.Criteria) != 2 || given.Criteria[1] != "Cost" || given.Scores[1][1] != (ComparisonScore{}) {
		t.Fatalf("the operator's criteria stay: %+v %v", given, err)
	}
	for _, bad := range []string{
		ConvergeMarker + `{"criteria":["a"],"scores":[],"recommendation":{"option":"O7","reason":"x"}}`,
		ConvergeMarker + `{"criteria":[],"scores":[],"recommendation":{"option":"O1","reason":"x"}}`,
	} {
		if _, err := ParseConvergence(bad, convergeOptions(), nil, l); err == nil {
			t.Fatalf("%q parsed", bad)
		}
	}
}

func TestNormalizeCriteria(t *testing.T) {
	l := DefaultLimits().Diverge
	got, err := NormalizeCriteria([]string{" Safety ", "safety", "Speed"}, l)
	if err != nil || len(got) != 2 || got[0] != "Safety" {
		t.Fatalf("criteria = %v %v", got, err)
	}
	if _, err := NormalizeCriteria([]string{"a", "b", "c", "d", "e", "f", "g"}, l); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("too many: %v", err)
	}
	if _, err := NormalizeCriteria([]string{strings.Repeat("c", 121)}, l); CodeOf(err) != CodeTooLong {
		t.Fatalf("too long: %v", err)
	}
}

func TestDecisionLeaves(t *testing.T) {
	m := ComparisonMatrix{
		Criteria:       []string{"Safety", "Speed"},
		Options:        []ComparisonOption{{LineID: "l1", Label: "Box"}, {LineID: "l2", Label: "arena"}},
		Scores:         [][]ComparisonScore{{{Score: 4, Why: "owned"}, {Score: 3, Why: "indices"}}, {{Score: 2, Why: "allocs"}, {Score: 5, Why: "cache"}}},
		Recommendation: ComparisonRecommendation{LineID: "l2", Reason: "fast and simple"},
	}
	l := DefaultLimits()
	decision := DecisionLeaf(m, "l2", "", l)
	if decision.Kind != LeafKindDecision || decision.Line != "fast and simple" || !strings.Contains(decision.Body, "- Safety: 3/5 — indices") || !strings.Contains(decision.Body, "- Speed: 5/5 — cache") {
		t.Fatalf("decision = %+v", decision)
	}
	if own := DecisionLeaf(m, "l1", " Box after all ", l); own.Line != "Box after all" {
		t.Fatalf("the operator's line: %+v", own)
	}
	if other := DecisionLeaf(m, "l1", "", l); other.Line != "Box" {
		t.Fatalf("not the recommended one: the option's label: %+v", other)
	}
	dead := DeadEndLeaf(m, "l1", "l2", LeafTexts{}, l)
	if dead.Kind != LeafKindDeadEnd || dead.Line != "沒選：改走「arena」" || !strings.Contains(dead.Body, "- Speed: 2/5 — allocs") {
		t.Fatalf("dead end = %+v", dead)
	}
	if english := DeadEndLeaf(m, "l1", "l2", EnglishLeafTexts(), l); english.Line != "Not chosen: went with arena" {
		t.Fatalf("english = %+v", english)
	}
	if own := DeadEndLeaf(m, "l1", "l2", LeafTexts{NotChosen: "lost to {title}!"}, l); own.Line != "lost to arena!" {
		t.Fatalf("own template = %+v", own)
	}
}
