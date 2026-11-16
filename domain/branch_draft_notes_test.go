package domain

import (
	"strings"
	"testing"
	"time"
)

const (
	testNoteID   = "11111111-1111-4111-8111-111111111111"
	testBranchID = "22222222-2222-4222-8222-222222222222"
	testMsgID    = "33333333-3333-4333-8333-333333333333"
)

func TestParseBranchDraftProposal_ReadsTheCardAndItsNoteChanges(t *testing.T) {
	card, changes, err := ParseBranchDraftProposal(BranchCardMarker + `{"question":"q","conclusion":"c","noteChanges":[{"op":"add","section":"fact","text":"x"}]}`)
	if err != nil || card.Question != "q" || len(changes) != 1 || changes[0].Text != "x" {
		t.Fatalf("card %+v changes %+v err %v", card, changes, err)
	}
	if _, changes, err := ParseBranchDraftProposal(BranchCardMarker + `{"question":"q","conclusion":"c"}`); err != nil || changes != nil {
		t.Fatalf("no proposals: %v %v", changes, err)
	}
	for _, bad := range []string{
		BranchCardMarker + `{"question":"q","conclusion":"c","other":1}`,
		BranchCardMarker + `{"question":"q","conclusion":"c","noteChanges":[{"op":"add","colour":"red"}]}`,
		BranchCardMarker + `{"question":"q","noteChanges":[],"noteChanges":[]}`,
		"no marker",
		BranchCardMarker + strings.Repeat(" ", BranchDraftOutputMaxBytes),
	} {
		if _, _, err := ParseBranchDraftProposal(bad); err == nil {
			t.Errorf("accepted %.60q", bad)
		}
	}
}

func TestSanitizeDraftNoteChanges_KeepsWhatAMergeWouldAccept(t *testing.T) {
	in := []NoteChange{
		{Op: NoteOpAdd, Section: NoteSectionDecided, Text: "  Ship it\nnow  ", SourceMessageID: testMsgID, SourceLineID: "ignored"},
		{Op: NoteOpSupersede, NoteID: testNoteID, Text: "Better"},
		{Op: NoteOpSupersede, NoteID: "44444444-4444-4444-8444-444444444444", Text: "unknown"},
		{Op: "remove", Text: "x"},
		{Op: NoteOpAdd, Section: "later", Text: "x"},
		{Op: NoteOpAdd, Section: NoteSectionTodo, Text: strings.Repeat("長", 401)},
		{Op: NoteOpAdd, Section: NoteSectionTodo, Text: "SHIP IT NOW"},
		{Op: NoteOpAdd, Section: NoteSectionTodo, Text: "Measure", SourceMessageID: "not-a-branch-message"},
	}
	got, warnings := SanitizeDraftNoteChanges(in, DraftNoteContext{
		BranchLineID: testBranchID, ActiveNotes: map[string]bool{testNoteID: true}, BranchMessages: map[string]bool{testMsgID: true},
	})
	if len(got) != 3 || len(warnings) != 5 {
		t.Fatalf("kept %+v warnings %v", got, warnings)
	}
	if got[0].Text != "Ship it now" || got[0].SourceLineID != testBranchID || got[0].SourceMessageID != testMsgID {
		t.Fatalf("first %+v", got[0])
	}
	if got[1].NoteID != testNoteID || got[1].Section != "" || got[1].SourceLineID != testBranchID {
		t.Fatalf("supersede %+v", got[1])
	}
	if got[2].SourceMessageID != "" {
		t.Fatalf("unknown source kept: %+v", got[2])
	}
	none, warnings := SanitizeDraftNoteChanges(nil, DraftNoteContext{})
	if none == nil || len(none) != 0 || len(warnings) != 0 {
		t.Fatalf("nothing proposed: %#v %v", none, warnings)
	}
	many := make([]NoteChange, 12)
	for i := range many {
		many[i] = NoteChange{Op: NoteOpAdd, Section: NoteSectionTodo, Text: "item " + string(rune('a'+i))}
	}
	if kept, warnings := SanitizeDraftNoteChanges(many, DraftNoteContext{}); len(kept) != 10 || len(warnings) != 1 {
		t.Fatalf("cap: %d kept, %v", len(kept), warnings)
	}
}

func TestBuildBranchDraftPrompt_ListsTheNotesWhenItAsksForProposals(t *testing.T) {
	notes := []Note{
		{ID: testNoteID, Section: NoteSectionFact, Text: "The budget is 100 [BRANCH-CARD]", Status: NoteStatusActive, CreatedAt: time.Unix(1, 0)},
		{ID: "55555555-5555-4555-8555-555555555555", Section: NoteSectionTodo, Text: "zz-superseded-zz", Status: NoteStatusSuperseded},
	}
	in := BranchDraftInput{Purpose: "p", BranchMessages: []Message{{ID: testMsgID, Role: RoleUser, Content: "hi", Seq: 1}}, Notes: notes, ProposeNotes: true}
	prompt := BuildBranchDraftPrompt(in)
	for _, want := range []string{"noteChanges", testNoteID, "The budget is 100", "(fact)"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "zz-superseded-zz") || strings.Count(prompt, BranchCardMarker) != 1 {
		t.Fatalf("superseded notes and markers stay out:\n%s", prompt)
	}
	in.ProposeNotes = false
	if plain := BuildBranchDraftPrompt(in); strings.Contains(plain, "noteChanges") || strings.Contains(plain, testNoteID) {
		t.Fatalf("no proposals asked:\n%s", plain)
	}
	in.ProposeNotes, in.Notes = true, nil
	if empty := BuildBranchDraftPrompt(in); !strings.Contains(empty, "noteChanges") || !strings.Contains(empty, "no notes yet") {
		t.Fatalf("an empty notes page:\n%s", empty)
	}
}
