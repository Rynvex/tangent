package tangent_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// draftWithNotes is a drafting model's output with note proposals.
func draftWithNotes(t *testing.T, changes []map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"question": "Which cache?", "conclusion": "Use the LRU cache.", "noteChanges": changes})
	if err != nil {
		t.Fatal(err)
	}
	return domain.BranchCardMarker + "\n" + string(raw)
}

// proposalsWithMistakes are three proposals a merge accepts (the last with
// a source that is no branch message) among five it would refuse.
func proposalsWithMistakes(replyID, existingNote string) []map[string]any {
	return []map[string]any{
		{"op": "add", "section": "decided", "text": "Use the LRU cache", "sourceMessageId": replyID},
		{"op": "supersede", "noteId": existingNote, "section": "fact", "text": "The budget is 120"},
		{"op": "supersede", "noteId": uuid.NewString(), "text": "an unknown note"},
		{"op": "delete", "text": "not an operation"},
		{"op": "add", "section": "someday", "text": "not a section"},
		{"op": "add", "section": "todo", "text": "   "},
		{"op": "add", "section": "todo", "text": "use the LRU cache"},
		{"op": "add", "section": "todo", "text": "Measure it", "sourceMessageId": uuid.NewString()},
	}
}

func TestB5_DraftsProposeNoteChangesWhenNotesAreOn(t *testing.T) {
	e := newEnv(t)
	main, branch, reply := e.draftable()
	written, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "The budget is 100"}})
	if err != nil {
		t.Fatal(err)
	}
	existing := written.Created[0].ID
	job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	prompt := job.Prompt.UserMessage
	if !strings.Contains(prompt, "noteChanges") || !strings.Contains(prompt, existing) || !strings.Contains(prompt, "The budget is 100") {
		t.Fatalf("the draft prompt carries the notes and asks for proposals:\n%s", prompt)
	}
	if err := e.engine.FinishJob(e.ctx, job.ID, draftWithNotes(t, proposalsWithMistakes(reply.ID, existing)), nil); err != nil {
		t.Fatal(err)
	}
	detail, err := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	if err != nil || detail.Draft.Status != domain.BranchDraftReady {
		t.Fatalf("draft %+v, %v", detail.Draft, err)
	}
	got := detail.Draft.NoteChanges
	if len(got) != 3 {
		t.Fatalf("kept proposals %+v (warnings %v)", got, detail.Draft.Warnings)
	}
	if got[0].Op != domain.NoteOpAdd || got[0].SourceLineID != branch.Line.ID || got[0].SourceMessageID != reply.ID {
		t.Fatalf("add %+v", got[0])
	}
	if got[1].Op != domain.NoteOpSupersede || got[1].NoteID != existing || got[1].SourceLineID != branch.Line.ID {
		t.Fatalf("supersede %+v", got[1])
	}
	if got[2].SourceMessageID != "" {
		t.Fatalf("a source that is not a branch message is dropped: %+v", got[2])
	}
	if len(detail.Draft.Warnings) < 5 {
		t.Fatalf("every dropped proposal is named: %v", detail.Draft.Warnings)
	}
	merged, err := e.engine.MergeBranch(e.ctx, scopeA, branch.Line.ID, tangent.MergeInput{
		Card: *detail.Draft.Card, ParentTipMessageID: detail.ParentTipMessageID, NoteChanges: got,
	})
	if err != nil {
		t.Fatalf("the proposals merge as they are: %v", err)
	}
	if len(merged.Notes.Created) != 3 || len(merged.Notes.Superseded) != 1 {
		t.Fatalf("notes written %+v", merged.Notes)
	}
}

func TestB5_DraftsProposeNothingWhenNotesAreOff(t *testing.T) {
	e := newEnvWith(t, []tangent.Feature{tangent.CardDraft()})
	_, branch, _ := e.draftable()
	job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(job.Prompt.UserMessage, "noteChanges") {
		t.Fatal("without notes the prompt asks for no proposals")
	}
	raw := draftWithNotes(t, []map[string]any{{"op": "add", "section": "decided", "text": "ignored"}})
	if err := e.engine.FinishJob(e.ctx, job.ID, raw, nil); err != nil {
		t.Fatal(err)
	}
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	if detail.Draft.Status != domain.BranchDraftReady || detail.Draft.NoteChanges == nil || len(detail.Draft.NoteChanges) != 0 {
		t.Fatalf("draft %+v", detail.Draft)
	}
}

func TestB5_TooManyProposalsAreCut(t *testing.T) {
	e := newEnv(t)
	_, branch, _ := e.draftable()
	job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	most := e.engine.Limits().Notes.MaxChangesPerMerge
	var changes []map[string]any
	for i := range most + 3 {
		changes = append(changes, map[string]any{"op": "add", "section": "todo", "text": "item " + string(rune('a'+i))})
	}
	if err := e.engine.FinishJob(e.ctx, job.ID, draftWithNotes(t, changes), nil); err != nil {
		t.Fatal(err)
	}
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	if len(detail.Draft.NoteChanges) != most {
		t.Fatalf("%d proposals kept, want %d", len(detail.Draft.NoteChanges), most)
	}
}
