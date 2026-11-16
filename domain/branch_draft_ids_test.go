package domain

import (
	"fmt"
	"strings"
	"testing"
)

const (
	draftBranch1 = "aaaaaaaa-0000-4000-8000-000000000001"
	draftBranch2 = "aaaaaaaa-0000-4000-8000-000000000002"
	draftMain1   = "bbbbbbbb-0000-4000-8000-000000000001"
	draftMain2   = "bbbbbbbb-0000-4000-8000-000000000002"
)

func draftIDsInput() BranchDraftInput {
	return BranchDraftInput{
		Purpose: "check the cap",
		// Out of seq order on purpose: numbering follows seq.
		BranchMessages: []Message{
			{ID: draftBranch2, Seq: 7, Role: RoleAssistant, Content: "The retry cap is 3.\nRun `go test ./retry`."},
			{ID: draftBranch1, Seq: 6, Role: RoleUser, Content: "What is the cap?"},
		},
		ParentSince: []Message{
			{ID: draftMain2, Seq: 41, Role: RoleAssistant, Content: "We set the cap to 5."},
			{ID: draftMain1, Seq: 40, Role: RoleUser, Content: "Change the cap?"},
		},
	}
}

func draftIDsRefs() BranchCardRefs {
	return BranchCardRefs{
		Messages:          map[string]string{draftBranch1: "What is the cap?", draftBranch2: "The retry cap is 3.\nRun `go test ./retry`."},
		ParentAfterAnchor: map[string]bool{draftMain1: true, draftMain2: true},
	}
}

func TestBuildBranchDraftPrompt_HeadingsUseShortIDsInSeqOrder(t *testing.T) {
	prompt := BuildBranchDraftPrompt(draftIDsInput())
	for _, want := range []string{"### [B1] branch message (operator)", "### [B2] branch message (agent)", "### [M1] main-line message (operator)", "### [M2] main-line message (agent)"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	if strings.Index(prompt, "[B1]") > strings.Index(prompt, "[B2]") || strings.Index(prompt, "[M1]") > strings.Index(prompt, "[M2]") {
		t.Fatal("messages must be numbered and shown oldest first")
	}
	for _, id := range []string{draftBranch1, draftBranch2, draftMain1, draftMain2} {
		if strings.Contains(prompt, id) {
			t.Fatalf("full id %s is still in the prompt", id)
		}
	}
	for _, want := range []string{`"messageId":"B1"`, `"mainLineMessageId":"M1"`, "short", "1-3 lines"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("instructions lack %q", want)
		}
	}
}

func TestDraftShortIDs_MapShortIDsBackToMessageIDs(t *testing.T) {
	ids := NewDraftShortIDs(draftIDsInput())
	card := BranchCard{
		Question: "q", Conclusion: "c",
		Evidence:      []BranchCardEvidence{{MessageID: "B2", Note: "states it"}, {MessageID: " [b1] ", Note: "asks"}},
		NeedsDecision: []BranchCardDecision{{BranchClaim: "3", MainLineClaim: "5", MainLineMessageID: "M2"}},
		Excerpts:      []BranchCardExcerpt{{MessageID: "B2", Text: "Run `go test ./retry`."}},
	}
	resolved := ids.ResolveCard(card)
	if resolved.Evidence[0].MessageID != draftBranch2 || resolved.Evidence[1].MessageID != draftBranch1 ||
		resolved.NeedsDecision[0].MainLineMessageID != draftMain2 || resolved.Excerpts[0].MessageID != draftBranch2 {
		t.Fatalf("resolved = %+v", resolved)
	}
	if card.Evidence[0].MessageID != "B2" {
		t.Fatal("ResolveCard must not change the card it was given")
	}
	got, warnings, ok := SanitizeBranchDraft(resolved, draftIDsRefs())
	if !ok || len(warnings) != 0 || len(got.Evidence) != 2 || len(got.Excerpts) != 1 || got.NeedsDecision[0].MainLineMessageID != draftMain2 {
		t.Fatalf("sanitised = %+v warnings %v", got, warnings)
	}
	if _, problems := ValidateBranchCard(got, draftIDsRefs()); len(problems) != 0 {
		t.Fatalf("a resolved card must validate: %+v", problems)
	}
}

func TestDraftShortIDs_RealIDsStillWork(t *testing.T) {
	ids := NewDraftShortIDs(draftIDsInput())
	card := BranchCard{
		Question: "q", Conclusion: "c",
		Evidence:      []BranchCardEvidence{{MessageID: draftBranch1}, {MessageID: "B2"}},
		NeedsDecision: []BranchCardDecision{{BranchClaim: "3", MainLineMessageID: draftMain1}},
	}
	got, warnings, ok := SanitizeBranchDraft(ids.ResolveCard(card), draftIDsRefs())
	if !ok || len(warnings) != 0 || got.Evidence[0].MessageID != draftBranch1 || got.Evidence[1].MessageID != draftBranch2 || got.NeedsDecision[0].MainLineMessageID != draftMain1 {
		t.Fatalf("mixed ids: %+v %v", got, warnings)
	}
}

func TestDraftShortIDs_UnknownOrMisplacedShortIDsAreDropped(t *testing.T) {
	ids := NewDraftShortIDs(draftIDsInput())
	card := BranchCard{
		Question: "q", Conclusion: "c",
		// B999 does not exist; M1 is a main-line message, never evidence; B1x is not a short id.
		Evidence:      []BranchCardEvidence{{MessageID: "B999"}, {MessageID: "M1"}, {MessageID: "B1x"}, {MessageID: "B1"}},
		Excerpts:      []BranchCardExcerpt{{MessageID: "B3", Text: "What is the cap?"}},
		NeedsDecision: []BranchCardDecision{{BranchClaim: "3", MainLineMessageID: "M9"}, {BranchClaim: "4", MainLineMessageID: "B1"}},
	}
	got, warnings, ok := SanitizeBranchDraft(ids.ResolveCard(card), draftIDsRefs())
	if !ok {
		t.Fatal("the draft keeps its question and conclusion")
	}
	if len(got.Evidence) != 1 || got.Evidence[0].MessageID != draftBranch1 || len(got.Excerpts) != 0 {
		t.Fatalf("only B1 is real evidence: %+v", got)
	}
	if got.NeedsDecision[0].MainLineMessageID != "" || got.NeedsDecision[1].MainLineMessageID != "" {
		t.Fatalf("unknown or branch-side ids are cleared from decisions: %+v", got.NeedsDecision)
	}
	if len(warnings) < 6 {
		t.Fatalf("every drop is reported: %v", warnings)
	}
}

func TestDraftShortIDs_NoteSourcesMapToBranchMessages(t *testing.T) {
	ids := NewDraftShortIDs(draftIDsInput())
	in := []NoteChange{{Op: NoteOpAdd, Section: NoteSectionFact, Text: "cap 3", SourceMessageID: "B2"}, {Op: NoteOpAdd, Section: NoteSectionFact, Text: "x", SourceMessageID: "M1"}}
	got := ids.ResolveNoteChanges(in)
	if got[0].SourceMessageID != draftBranch2 || got[1].SourceMessageID != "M1" || in[0].SourceMessageID != "B2" {
		t.Fatalf("resolved = %+v (input %+v)", got, in)
	}
	if ids.ResolveNoteChanges(nil) != nil {
		t.Fatal("no proposals stay nil")
	}
}

// The ids are a function of the input: rebuilding the same input (as the
// engine does when the run finishes) gives the same mapping, and only the
// last BranchDraftParentSinceMessages main-line messages are numbered, as
// the prompt shows them.
func TestDraftShortIDs_AreDeterministicAndFollowThePromptWindow(t *testing.T) {
	in := draftIDsInput()
	in.ParentSince = nil
	for i := 1; i <= BranchDraftParentSinceMessages+5; i++ {
		in.ParentSince = append(in.ParentSince, Message{ID: fmt.Sprintf("cccccccc-0000-4000-8000-%012d", i), Seq: int64(100 + i), Role: RoleUser, Content: fmt.Sprint("since ", i)})
	}
	a, b := NewDraftShortIDs(in), NewDraftShortIDs(in)
	card := BranchCard{NeedsDecision: []BranchCardDecision{{MainLineMessageID: "M1"}}}
	first, second := a.ResolveCard(card), b.ResolveCard(card)
	if first.NeedsDecision[0].MainLineMessageID != second.NeedsDecision[0].MainLineMessageID {
		t.Fatal("the mapping must be deterministic")
	}
	if got, want := first.NeedsDecision[0].MainLineMessageID, "cccccccc-0000-4000-8000-000000000006"; got != want {
		t.Fatalf("M1 = %s, want the oldest message of the window %s", got, want)
	}
	prompt := BuildBranchDraftPrompt(in)
	if !strings.Contains(prompt, fmt.Sprintf("[M%d]", BranchDraftParentSinceMessages)) || strings.Contains(prompt, fmt.Sprintf("[M%d]", BranchDraftParentSinceMessages+1)) {
		t.Fatal("the prompt numbers exactly the window")
	}
}
