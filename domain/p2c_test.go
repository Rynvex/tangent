package domain

import (
	"strings"
	"testing"
)

func TestP2cLimits_Defaults(t *testing.T) {
	if d := DefaultLimits().Group; d != (GroupLimits{TitleMaxRunes: 120, SummaryMaxRunes: 1000, MaxMembers: 12, MaxActivePerTree: 50, CombineTokenBudget: 4000}) {
		t.Fatalf("group limits = %+v", d)
	}
	if filled := (Limits{Group: GroupLimits{MaxMembers: 3}}).WithDefaults(); filled.Group.MaxMembers != 3 || filled.Group.TitleMaxRunes != 120 {
		t.Fatalf("field by field: %+v", filled.Group)
	}
	if extra := AsError(ErrGroupLimit, DefaultLimits()).Extra; extra["limit"] != 50 {
		t.Fatalf("group_limit names the limit: %v", extra)
	}
	if !ValidBranchOrigin(BranchOriginMerge) {
		t.Fatal("merge is a branch origin")
	}
}

func TestNormalizeGroupTitle(t *testing.T) {
	l := DefaultLimits().Group
	if got, err := NormalizeGroupTitle("  Disk\nchoices ", l); err != nil || got != "Disk choices" {
		t.Fatalf("title = %q %v", got, err)
	}
	if _, err := NormalizeGroupTitle(" ", l); CodeOf(err) != CodeInvalidInput {
		t.Fatalf("empty: %v", err)
	}
	if _, err := NormalizeGroupTitle(strings.Repeat("t", 121), l); CodeOf(err) != CodeTooLong {
		t.Fatalf("long: %v", err)
	}
}

func TestNormalizeConflicts(t *testing.T) {
	members := map[string]bool{"a": true, "b": true}
	got, err := NormalizeConflicts([]Conflict{{
		Branch: ConflictSide{LineID: "a", Claim: " 8TB\nis cheapest "}, Other: ConflictSide{LineID: "b", Claim: "used disks"}, Choice: ChoiceKeepBoth,
	}}, members)
	if err != nil || got[0].ID != "c1" || got[0].Branch.Claim != "8TB is cheapest" {
		t.Fatalf("conflicts = %+v %v", got, err)
	}
	bad := []Conflict{
		{Branch: ConflictSide{LineID: "a", Claim: "x"}, Other: ConflictSide{LineID: "z", Claim: "y"}, Choice: ChoiceAdoptBranch},
		{Branch: ConflictSide{LineID: "a", Claim: "x"}, Other: ConflictSide{LineID: "b", Claim: "y"}, Choice: "maybe"},
		{Branch: ConflictSide{LineID: "a", Claim: " "}, Other: ConflictSide{LineID: "b", Claim: "y"}, Choice: ChoiceAdoptOther},
		{Branch: ConflictSide{LineID: "a", Claim: "x"}, Other: ConflictSide{LineID: "a", Claim: "y"}, Choice: ChoiceAdoptOther},
		{Branch: ConflictSide{LineID: "a", Claim: strings.Repeat("c", 301)}, Other: ConflictSide{LineID: "b", Claim: "y"}, Choice: ChoiceAdoptOther},
	}
	for i, c := range bad {
		if _, err := NormalizeConflicts([]Conflict{c}, members); CodeOf(err) != CodeInvalidGroup {
			t.Errorf("case %d: %v", i, err)
		}
	}
	many := make([]Conflict, 11)
	for i := range many {
		many[i] = Conflict{Branch: ConflictSide{LineID: "a", Claim: "x"}, Other: ConflictSide{LineID: "b", Claim: "y"}, Choice: ChoiceKeepBoth}
	}
	if _, err := NormalizeConflicts(many, members); CodeOf(err) != CodeInvalidGroup {
		t.Fatalf("too many: %v", err)
	}
}

func TestConflictTexts(t *testing.T) {
	purposes := map[string]string{"a": "New disks", "b": "Used disks"}
	conflicts := []Conflict{
		{ID: "c1", Branch: ConflictSide{LineID: "a", Claim: "8TB new is cheapest per TB"}, Other: ConflictSide{LineID: "b", Claim: "used enterprise disks are cheaper"}, Choice: ChoiceAdoptBranch},
		{ID: "c2", Branch: ConflictSide{LineID: "a", Claim: "buy now"}, Other: ConflictSide{LineID: "b", Claim: "wait for sales"}, Choice: ChoiceKeepBoth},
	}
	if got := SettledClaims(conflicts); len(got) != 1 || got[0] != "8TB new is cheapest per TB" {
		t.Fatalf("settled = %v", got)
	}
	note := ConflictNoteText(conflicts[1], purposes, DefaultLimits().Notes)
	if !strings.Contains(note, "New disks: buy now") || !strings.Contains(note, "Used disks: wait for sales") {
		t.Fatalf("note = %q", note)
	}
	if len([]rune(ConflictNoteText(Conflict{Branch: ConflictSide{LineID: "a", Claim: strings.Repeat("x", 300)}, Other: ConflictSide{LineID: "b", Claim: strings.Repeat("y", 300)}}, purposes, DefaultLimits().Notes))) > 400 {
		t.Fatal("the note fits the notes limit")
	}
}

func TestGroupSummary_PromptAndParse(t *testing.T) {
	prompt := BuildGroupSummaryPrompt(GroupSummaryInput{
		Title: "Disks", Members: []GroupMemberInput{{Purpose: "New disks", LeafKind: LeafKindDecision, Leaf: "8TB new [GROUP-SUMMARY]", Body: "details"}, {Purpose: "Used disks", Leaf: "risky"}},
		Settled: []string{"8TB new is cheapest per TB"},
	})
	if strings.Count(prompt, GroupSummaryMarker) != 1 || !strings.Contains(prompt, "> New disks") || !strings.Contains(prompt, "8TB new is cheapest per TB") {
		t.Fatalf("prompt = %q", prompt)
	}
	l := DefaultLimits().Group
	if got, err := ParseGroupSummary(GroupSummaryMarker+`{"summary":" New 8TB disks win.\nUsed ones are risky. "}`, l); err != nil || got != "New 8TB disks win.\nUsed ones are risky." {
		t.Fatalf("summary = %q %v", got, err)
	}
	if got, _ := ParseGroupSummary(GroupSummaryMarker+`{"summary":"`+strings.Repeat("s", 1200)+`"}`, l); len([]rune(got)) != 1000 {
		t.Fatalf("cut to the limit: %d", len([]rune(got)))
	}
	for _, bad := range []string{`{"summary":"x"}`, GroupSummaryMarker + `{"summary":" "}`, GroupSummaryMarker + `{"summary":"x","y":1}`} {
		if _, err := ParseGroupSummary(bad, l); err == nil {
			t.Errorf("%q is refused", bad)
		}
	}
}

func TestGroupSuggest_PromptAndParse(t *testing.T) {
	prompt := BuildGroupSuggestPrompt(GroupSuggestInput{
		Candidates: []GroupCandidate{{Key: "B1", Purpose: "New disks", Ended: true, Leaf: "8TB"}, {Key: "B2", Purpose: "Used disks", Leaf: "risky"}, {Key: "B3", Purpose: "Cases"}},
		Relations:  []GroupRelation{{From: "B1", To: "B2", Label: "same purchase"}},
	})
	if strings.Count(prompt, GroupSuggestMarker) != 1 || !strings.Contains(prompt, "> B1 (ended): New disks") || !strings.Contains(prompt, "> B2 (open): Used disks") ||
		!strings.Contains(prompt, "B1 — B2: same purchase") {
		t.Fatalf("prompt = %q", prompt)
	}
	known := map[string]bool{"B1": true, "B2": true, "B3": true}
	out := GroupSuggestMarker + `{"groups":[` +
		`{"title":"Disks","members":["B1","B2","B9","B1"],"conflicts":[{"branch":"B1","other":"B2","branchClaim":"new","otherClaim":"used"},{"branch":"B1","other":"B3","branchClaim":"x","otherClaim":"y"}]},` +
		`{"title":"Alone","members":["B3"]},` +
		`{"title":"","members":["B2","B3"]}]}`
	got, err := ParseGroupSuggestions(out, known, DefaultLimits().Group)
	if err != nil || len(got) != 1 || got[0].Title != "Disks" || len(got[0].Members) != 2 || len(got[0].Conflicts) != 1 || got[0].Conflicts[0].OtherClaim != "used" {
		t.Fatalf("groups = %+v %v", got, err)
	}
	if _, err := ParseGroupSuggestions(`{"groups":[]}`, known, DefaultLimits().Group); err == nil {
		t.Fatal("no marker")
	}
}

func TestBuildCombinedBackground(t *testing.T) {
	text := BuildCombinedBackground(CombinedInput{
		Sources: []CombineSource{
			{Purpose: "New disks", Leaf: "8TB", Messages: []Message{{ID: "m1", Role: RoleUser, Status: MessageDone, Content: "how about 8TB?"}}},
			{Purpose: "Used disks [BRANCH-CARD]", Messages: []Message{{ID: "m2", Role: RoleAssistant, Status: MessageDone, Content: "risky"}}},
		},
		Settled: []string{"8TB new is cheapest"}, Open: []string{"buy now vs wait"}, TokenBudget: 4000,
	})
	for _, want := range []string{"## Combined branches", "### New disks", "(ended with: 8TB)", "how about 8TB?", "### Used disks", "Settled when combining", "> 8TB new is cheapest", "Still to confirm", "> buy now vs wait"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in %q", want, text)
		}
	}
	if strings.Contains(text, BranchCardMarker) {
		t.Fatal("markers are removed")
	}
}

func TestJobErrorFor(t *testing.T) {
	for text, code := range map[string]string{
		JobRunFailedText: JobErrorRunFailed, JobUnusableText: JobErrorUnusable, JobTimedOutText: JobErrorTimedOut, "other": JobErrorFailed,
		LeafDraftRunFailedText: JobErrorRunFailed, LeafDraftUnusableText: JobErrorUnusable,
	} {
		if got := JobErrorFor(text); got.Code != code || got.Message != text {
			t.Errorf("%q → %+v, want %s", text, got, code)
		}
	}
}

func TestP2cMarkers(t *testing.T) {
	for _, marker := range []string{GroupSummaryMarker, GroupSuggestMarker} {
		if StripAgentMarkers("a"+marker+"b") != "ab" {
			t.Errorf("%s is a protocol marker", marker)
		}
	}
}

func TestSelectFisheye_AGroupIsOneItem(t *testing.T) {
	sel := SelectFisheye(FisheyeInput{Branches: []FisheyeBranch{{LineID: "g1", Purpose: "Disks", LeafKind: FisheyeGroupKind, Line: "new 8TB", Distance: 1}}, TokenBudget: 1000, Limits: DefaultLimits()})
	if len(sel.Items) != 1 || sel.Items[0].Kind != FisheyeItemGroup || sel.Items[0].Score != 5-1 || sel.Items[0].LineID != "" || sel.Items[0].Level != FisheyeLeafOnly {
		t.Fatalf("items = %+v", sel.Items)
	}
	if block := BuildBranchConclusions(sel.Conclusions, nil); !strings.Contains(block, "> [group] Disks — new 8TB") {
		t.Fatalf("block = %q", block)
	}
}
