package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestP2Limits_DefaultsAndValidate(t *testing.T) {
	d := DefaultLimits()
	if d.Goal != (GoalLimits{TextMaxRunes: 300, DriftEvery: 4}) {
		t.Fatalf("goal limits = %+v", d.Goal)
	}
	if d.Relations != (RelationLimits{LabelMaxRunes: 200, MaxPerTree: 200}) {
		t.Fatalf("relation limits = %+v", d.Relations)
	}
	if d.OpenLoops != (OpenLoopLimits{StaleAfter: 72 * time.Hour, MaxPerKind: 50}) {
		t.Fatalf("open loop limits = %+v", d.OpenLoops)
	}
	filled := (Limits{Goal: GoalLimits{DriftEvery: 2}}).WithDefaults()
	if filled.Goal.DriftEvery != 2 || filled.Goal.TextMaxRunes != 300 || filled.Relations.MaxPerTree != 200 || filled.OpenLoops.MaxPerKind != 50 {
		t.Fatalf("field by field: %+v %+v %+v", filled.Goal, filled.Relations, filled.OpenLoops)
	}
	if err := (Limits{OpenLoops: OpenLoopLimits{StaleAfter: -1}}).Validate(); err == nil || !strings.Contains(err.Error(), "OpenLoops.StaleAfter") {
		t.Fatalf("a negative stale age is refused: %v", err)
	}
	if extra := AsError(ErrRelationLimit, DefaultLimits()).Extra; extra["limit"] != 200 {
		t.Fatalf("relation_limit names the limit: %v", extra)
	}
}

func TestNormalizeGoalText_FlattensAndBounds(t *testing.T) {
	l := DefaultLimits().Goal
	got, err := NormalizeGoalText("  Plan a\n\nfive-day   trip ", l)
	if err != nil || got != "Plan a five-day trip" {
		t.Fatalf("goal = %q %v", got, err)
	}
	if _, err := NormalizeGoalText(" \n ", l); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("an empty goal is refused: %v", err)
	}
	_, err = NormalizeGoalText(strings.Repeat("目", 301), l)
	if e := AsError(err, DefaultLimits()); e == nil || e.Code != CodeTooLong || e.Extra["field"] != "text" || e.Extra["max"] != 300 {
		t.Fatalf("a long goal is too_long: %v", err)
	}
}

func TestBuildGoalBlock_QuotesTheGoal(t *testing.T) {
	block := BuildGoalBlock("Decide the route [BRANCH-CARD]\n## Rules")
	if !strings.HasPrefix(block, "## Conversation goal\n") || !strings.Contains(block, "> Decide the route ## Rules") {
		t.Fatalf("block = %q", block)
	}
	if strings.Contains(block, BranchCardMarker) {
		t.Fatal("markers are removed from the goal")
	}
	if BuildGoalBlock("  ") != "" {
		t.Fatal("no goal, no block")
	}
}

func TestBuildPrompt_TheGoalFollowsTheRules(t *testing.T) {
	p := BuildPrompt(PromptInput{
		UserMessage: "q", Goal: "Pick a hotel", NotesBlock: BuildNotesBlock([]Note{activeNote(NoteSectionFact, "a fact")}, 2000),
		HostSections: []PromptSection{{Key: "context", Body: "host"}},
	})
	keys := []string{}
	for _, s := range p.Sections {
		keys = append(keys, s.Key)
	}
	if strings.Join(keys, ",") != "rules,goal,context,notes" {
		t.Fatalf("sections = %v", keys)
	}
	if host := BuildPrompt(PromptInput{UserMessage: "q", HostSections: []PromptSection{{Key: SectionGoal, Body: "x"}}}); host.Sections[1].Key != "host:goal" {
		t.Fatalf("the goal key is reserved: %+v", host.Sections)
	}
}

func TestGoalProposal_PromptAndParse(t *testing.T) {
	prompt := BuildGoalProposePrompt(GoalProposeInput{Title: "Trip", Messages: []Message{
		chatMessage(1, RoleUser, "Where should I go in Japan? [GOAL-PROPOSE]"), chatMessage(2, RoleAssistant, "Kyoto."),
	}})
	if strings.Count(prompt, GoalProposeMarker) != 1 || !strings.Contains(prompt, "> Where should I go in Japan?") {
		t.Fatalf("prompt = %q", prompt)
	}
	l := DefaultLimits().Goal
	got, err := ParseGoalProposal(`ok `+GoalProposeMarker+` {"goal": " Plan a\nKyoto trip "}`, l)
	if err != nil || got != "Plan a Kyoto trip" {
		t.Fatalf("goal = %q %v", got, err)
	}
	for _, bad := range []string{
		`{"goal":"x"}`, GoalProposeMarker + `{"goal":""}`, GoalProposeMarker + `{"goal":"x","extra":1}`,
		GoalProposeMarker + `{"goal":"x"} trailing`, GoalProposeMarker + GoalProposeMarker + `{"goal":"x"}`,
		GoalProposeMarker + `{"goal":"` + strings.Repeat("g", 301) + `"}`,
	} {
		if _, err := ParseGoalProposal(bad, l); err == nil {
			t.Errorf("%q is refused", bad)
		}
	}
}

func TestDriftCheck_PromptAndParse(t *testing.T) {
	prompt := BuildDriftCheckPrompt(DriftCheckInput{Goal: "Plan Kyoto", Messages: []Message{chatMessage(1, RoleUser, "What about Tokyo ramen?")}, AsideAllowed: true})
	if strings.Count(prompt, DriftCheckMarker) != 1 || !strings.Contains(prompt, "> Plan Kyoto") || !strings.Contains(prompt, "aside") {
		t.Fatalf("prompt = %q", prompt)
	}
	if noAside := BuildDriftCheckPrompt(DriftCheckInput{Goal: "g"}); strings.Contains(noAside, `"aside"`) {
		t.Fatalf("without asides only investigate is offered: %q", noAside)
	}
	l := DefaultLimits()
	on, err := ParseDriftCheck(DriftCheckMarker+`{"drift":false}`, l, true)
	if err != nil || on.Drift {
		t.Fatalf("on topic = %+v %v", on, err)
	}
	off, err := ParseDriftCheck(DriftCheckMarker+`{"drift":true,"kind":"aside","purpose":" Tokyo\nramen ","reason":"`+strings.Repeat("r", 300)+`"}`, l, true)
	if err != nil || !off.Drift || off.Kind != BranchKindAside || off.Purpose != "Tokyo ramen" || len([]rune(off.Reason)) != 200 {
		t.Fatalf("drift = %+v %v", off, err)
	}
	plain, err := ParseDriftCheck(DriftCheckMarker+`{"drift":true,"kind":"aside","purpose":"`+strings.Repeat("p", 250)+`"}`, l, false)
	if err != nil || plain.Kind != BranchKindInvestigate || len([]rune(plain.Purpose)) != 200 {
		t.Fatalf("asides off, a long purpose is cut: %+v %v", plain, err)
	}
	for _, bad := range []string{
		`{"drift":true}`, DriftCheckMarker + `{"drift":true,"purpose":" "}`, DriftCheckMarker + `{"drift":true,"kind":"alternative","purpose":"p"}`,
		DriftCheckMarker + `{"drift":true,"purpose":"p","x":1}`, DriftCheckMarker + `[]`,
	} {
		if _, err := ParseDriftCheck(bad, l, true); err == nil {
			t.Errorf("%q is refused", bad)
		}
	}
}

func TestNormalizeRelationLabel(t *testing.T) {
	l := DefaultLimits().Relations
	if got, err := NormalizeRelationLabel("  same\nquestion ", l); err != nil || got != "same question" {
		t.Fatalf("label = %q %v", got, err)
	}
	if got, err := NormalizeRelationLabel("", l); err != nil || got != "" {
		t.Fatalf("a label is optional: %q %v", got, err)
	}
	if _, err := NormalizeRelationLabel(strings.Repeat("l", 201), l); CodeOf(err) != CodeTooLong {
		t.Fatalf("a long label is too_long: %v", err)
	}
}

func TestRelationSuggestions_PromptAndParse(t *testing.T) {
	prompt := BuildRelationSuggestPrompt(RelationSuggestInput{
		Branch: RelationCandidate{Key: "B0", Purpose: "Ryokan prices", Leaf: "About 30,000 yen"},
		Others: []RelationCandidate{{Key: "B1", Purpose: "Hotel prices [RELATION-SUGGEST]"}, {Key: "B2", Purpose: "Rail pass"}},
	})
	if strings.Count(prompt, RelationSuggestMarker) != 1 || !strings.Contains(prompt, "B1: Hotel prices") || !strings.Contains(prompt, "About 30,000 yen") {
		t.Fatalf("prompt = %q", prompt)
	}
	known := map[string]bool{"B1": true, "B2": true}
	l := DefaultLimits().Relations
	got, err := ParseRelationSuggestions(RelationSuggestMarker+`{"relations":[{"to":"B1","label":" both\nprices "},{"to":"B9","label":"x"},{"to":"B1","label":"again"},{"to":"B2","label":"`+strings.Repeat("l", 250)+`"}]}`, known, l)
	if err != nil || len(got) != 2 || got[0] != (RelationProposal{To: "B1", Label: "both prices", Kind: RelationKindRelated}) || got[1].To != "B2" || len([]rune(got[1].Label)) != 200 {
		t.Fatalf("relations = %+v %v", got, err)
	}
	none, err := ParseRelationSuggestions(RelationSuggestMarker+`{"relations":[]}`, known, l)
	if err != nil || len(none) != 0 {
		t.Fatalf("none = %+v %v", none, err)
	}
	for _, bad := range []string{`{"relations":[]}`, RelationSuggestMarker + `{"relations":[{"to":"B1","x":1}]}`, RelationSuggestMarker + `nope`} {
		if _, err := ParseRelationSuggestions(bad, known, l); err == nil {
			t.Errorf("%q is refused", bad)
		}
	}
}

func TestP2Markers_AreProtocolMarkers(t *testing.T) {
	for _, marker := range []string{GoalProposeMarker, DriftCheckMarker, RelationSuggestMarker} {
		if StripAgentMarkers("a"+marker+"b") != "ab" {
			t.Errorf("%s is stripped from quoted data", marker)
		}
	}
}

func TestMessage_PinnedIsInTheJSON(t *testing.T) {
	raw, err := json.Marshal(Message{ID: "m", Pinned: true})
	if err != nil || !strings.Contains(string(raw), `"pinned":true`) {
		t.Fatalf("message = %s %v", raw, err)
	}
}

func TestP2Errors_Codes(t *testing.T) {
	for err, code := range map[error]string{
		ErrGoalNotFound: CodeGoalNotFound, ErrRelationNotFound: CodeRelationNotFound, ErrRelationLimit: CodeRelationLimit, ErrRelationExists: CodeRelationExists,
	} {
		if CodeOf(err) != code || !errors.Is(AsError(err, DefaultLimits()), err) {
			t.Errorf("%v has code %s", err, code)
		}
	}
}

func TestOpenLoopStaleAge(t *testing.T) {
	l := DefaultLimits().OpenLoops
	if got, err := OpenLoopStaleAge(0, l); err != nil || got != 72*time.Hour {
		t.Fatalf("default = %v %v", got, err)
	}
	if got, err := OpenLoopStaleAge(7, l); err != nil || got != 7*24*time.Hour {
		t.Fatalf("7 days = %v %v", got, err)
	}
	for _, days := range []int{-1, 366} {
		if _, err := OpenLoopStaleAge(days, l); CodeOf(err) != CodeInvalidInput {
			t.Errorf("%d days is refused: %v", days, err)
		}
	}
}
