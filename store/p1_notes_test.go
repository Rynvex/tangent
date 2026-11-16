package store_test

import (
	"testing"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestNotes_SourceLabelsAreSnapshotsThatOutliveTheSource(t *testing.T) {
	f := newFixture(t)
	main, first := f.mainLine()
	second := f.reply(main.ID)
	branch := f.branch(main.ID, first.ID)
	inBranch := f.reply(branch.ID)
	write := func(changes ...domain.NoteChange) []domain.Note {
		t.Helper()
		out, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: main.ID, Changes: changes})
		if err != nil {
			t.Fatal(err)
		}
		return out.Created
	}
	notes := write(
		domain.NoteChange{Op: "add", Section: "fact", Text: "a", SourceMessageID: second.ID},
		domain.NoteChange{Op: "add", Section: "fact", Text: "b", SourceLineID: main.ID},
		domain.NoteChange{Op: "add", Section: "fact", Text: "c", SourceMessageID: inBranch.ID},
		domain.NoteChange{Op: "add", Section: "fact", Text: "d"},
	)
	want := []string{"主線 #4", "主線", "查證・check it", ""}
	for i, note := range notes {
		if note.SourceLabel != want[i] {
			t.Errorf("note %d label %q, want %q", i, note.SourceLabel, want[i])
		}
	}
	merged, err := f.store.MergeBranch(f.ctx, store.MergeBranchInput{
		Tenant: tenant, LineID: branch.ID, Card: domain.BranchCard{Question: "q", Conclusion: "c"}, Content: "card",
		ParentTipMessageID: f.parentTip(main.ID), NoteChanges: []domain.NoteChange{{Op: "add", Section: "decided", Text: "from the card"}},
	})
	if err != nil || merged.Notes.Created[0].SourceLabel != "結論卡・check it" {
		t.Fatalf("merge note = %+v %v", merged.Notes, err)
	}
	f.exec(`DELETE FROM tangent_line WHERE id = $1`, branch.ID)
	view, err := f.store.ListNotes(f.ctx, tenant, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	labels := map[string]bool{}
	for _, note := range view.Notes {
		labels[note.SourceLabel] = true
	}
	if !labels["查證・check it"] || !labels["結論卡・check it"] {
		t.Fatalf("labels survive the branch: %v", labels)
	}
}

func TestNotes_SourceLabelsFollowTheConfiguredTemplates(t *testing.T) {
	f := newFixture(t, store.WithNoteSourceLabels(domain.EnglishNoteSourceLabels()))
	main, first := f.mainLine()
	out, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: main.ID, Changes: []domain.NoteChange{
		{Op: "add", Section: "fact", Text: "a", SourceMessageID: first.ID},
	}})
	if err != nil || out.Created[0].SourceLabel != "Main line #2" {
		t.Fatalf("english = %+v %v", out.Created, err)
	}
	f.exec(`UPDATE tangent_note SET source_label = '' WHERE id = $1`, uuid.MustParse(out.Created[0].ID))
	view, _ := f.store.ListNotes(f.ctx, tenant, main.ID)
	if view.Notes[0].SourceLabel != "" {
		t.Fatalf("old notes have no label: %+v", view.Notes[0])
	}
}
