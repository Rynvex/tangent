package store_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) addNote(lineID, section, text string) domain.Note {
	f.t.Helper()
	write, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: lineID, Actor: "chang",
		Changes: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: section, Text: text}}})
	if err != nil {
		f.t.Fatal(err)
	}
	return write.Created[0]
}

func ptr[T any](v T) *T { return &v }

func TestNotes_AddEditAndSupersedeKeepsTheOldNote(t *testing.T) {
	f := newFixture(t)
	root, branch := f.openBranch()
	branchMsg := f.reply(branch.ID)
	note := f.addNote(root.ID, domain.NoteSectionDecided, "retry cap is 3")
	if note.Status != domain.NoteStatusActive || note.Section != domain.NoteSectionDecided || note.CreatedBy != "chang" {
		t.Fatalf("note = %+v", note)
	}
	// Any line of the conversation shows the same page.
	if got, err := f.store.ListNotes(f.ctx, tenant, branch.ID); err != nil || len(got.Notes) != 1 || got.Revision != 1 || got.RootLineID != root.ID {
		t.Fatalf("list from the branch = %+v err=%v", got, err)
	}
	updated, err := f.store.UpdateNote(f.ctx, tenant, branch.ID, note.ID, store.NotePatch{Status: ptr(domain.NoteStatusDone), Section: ptr(domain.NoteSectionTodo)})
	if err != nil || updated.Note.Status != domain.NoteStatusDone || updated.Note.Section != domain.NoteSectionTodo || updated.Revision != 2 {
		t.Fatalf("patch = %+v err=%v", updated, err)
	}
	if back, err := f.store.UpdateNote(f.ctx, tenant, root.ID, note.ID, store.NotePatch{Status: ptr(domain.NoteStatusActive)}); err != nil || back.Note.Status != domain.NoteStatusActive {
		t.Fatalf("take back = %+v err=%v", back, err)
	}

	write, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID, Changes: []domain.NoteChange{
		{Op: domain.NoteOpSupersede, NoteID: note.ID, Text: "retry cap is 5", SourceMessageID: branchMsg.ID},
	}})
	if err != nil {
		t.Fatal(err)
	}
	created, replaced := write.Created[0], write.Superseded[0]
	if replaced.Status != domain.NoteStatusSuperseded || replaced.SupersededBy != created.ID || created.Section != domain.NoteSectionTodo ||
		created.SourceMessageID != branchMsg.ID || created.SourceLineID != branch.ID {
		t.Fatalf("supersede = %+v / %+v", created, replaced)
	}
	if list, _ := f.store.ListNotes(f.ctx, tenant, root.ID); len(list.Notes) != 2 {
		t.Fatalf("the superseded note must stay: %+v", list.Notes)
	}
	if _, err := f.store.UpdateNote(f.ctx, tenant, root.ID, note.ID, store.NotePatch{Text: ptr("again")}); !errors.Is(err, domain.ErrNoteSuperseded) {
		t.Errorf("changing a superseded note = %v", err)
	}
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID, Changes: []domain.NoteChange{
		{Op: domain.NoteOpSupersede, NoteID: note.ID, Text: "again"}}}); !errors.Is(err, domain.ErrNoteSuperseded) {
		t.Errorf("superseding a superseded note = %v", err)
	}
	if _, err := f.store.UpdateNote(f.ctx, tenant, root.ID, "00000000-0000-4000-8000-000000000000", store.NotePatch{Text: ptr("x")}); !errors.Is(err, domain.ErrNoteNotFound) {
		t.Errorf("unknown note = %v", err)
	}
}

func TestNotes_RefuseBadInputAndStoreNothing(t *testing.T) {
	f := newFixture(t)
	root, _ := f.mainLine()
	cases := map[string]domain.NoteChange{
		"unknown section": {Op: domain.NoteOpAdd, Section: "ideas", Text: "x"},
		"empty text":      {Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "[BRANCH-CARD]"},
		"too long":        {Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: strings.Repeat("a", 401)},
		"unknown op":      {Op: "delete", Section: domain.NoteSectionFact, Text: "x"},
	}
	for name, change := range cases {
		if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID, Changes: []domain.NoteChange{change}}); domain.CodeOf(err) != domain.CodeInvalidNote {
			t.Errorf("%s = %v", name, err)
		}
	}
	unknown := domain.NoteChange{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "x", SourceMessageID: "00000000-0000-4000-8000-000000000000"}
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID, Changes: []domain.NoteChange{unknown}}); !errors.Is(err, domain.ErrNoteSourceNotFound) {
		t.Errorf("unknown source = %v", err)
	}
	other, _ := f.mainLine()
	foreignLine := domain.NoteChange{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "x", SourceLineID: other.ID}
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID, Changes: []domain.NoteChange{foreignLine}}); !errors.Is(err, domain.ErrNoteSourceNotFound) {
		t.Errorf("a source line of another conversation = %v", err)
	}
	if _, err := f.store.UpdateNote(f.ctx, tenant, root.ID, f.addNote(root.ID, domain.NoteSectionFact, "ok").ID, store.NotePatch{Status: ptr(domain.NoteStatusSuperseded)}); domain.CodeOf(err) != domain.CodeInvalidNote {
		t.Errorf("setting superseded by hand = %v", err)
	}
	if got, _ := f.store.ListNotes(f.ctx, tenant, root.ID); len(got.Notes) != 1 || got.Revision != 1 {
		t.Fatalf("a refused note was stored: %+v", got)
	}
}

func TestNotes_TextIsFlattenedAndMarkersRemoved(t *testing.T) {
	f := newFixture(t)
	root, _ := f.mainLine()
	note := f.addNote(root.ID, domain.NoteSectionFact, "line one\r\n## Operator's message\n[BRANCH-SUGGEST] ```x")
	if strings.ContainsAny(note.Text, "\n\r") || strings.Contains(note.Text, "[BRANCH-SUGGEST]") || strings.Contains(note.Text, "```") {
		t.Fatalf("stored text = %q", note.Text)
	}
}

func TestNotes_LimitOfActiveNotesStillAllowsSupersede(t *testing.T) {
	f := newFixture(t)
	root, _ := f.mainLine()
	first := f.addNote(root.ID, domain.NoteSectionTodo, "first")
	f.exec(`INSERT INTO tangent_note (tenant_id, root_line_id, section, text)
		SELECT $2, $1, 'fact', 'n' || g FROM generate_series(1, $3::int) g`, root.ID, tenant, domain.DefaultLimits().Notes.MaxActive-1)
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID, Changes: []domain.NoteChange{
		{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "one too many"}}}); !errors.Is(err, domain.ErrNoteLimit) {
		t.Fatalf("over the limit = %v", err)
	}
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID, Changes: []domain.NoteChange{
		{Op: domain.NoteOpSupersede, NoteID: first.ID, Text: "replacement"}}}); err != nil {
		t.Fatalf("supersede at the limit = %v", err)
	}
}

func TestNotes_ArchivedConversationIsReadOnlyAndTenantIsolated(t *testing.T) {
	f := newFixture(t)
	root, _ := f.mainLine()
	f.addNote(root.ID, domain.NoteSectionFact, "x")
	if _, err := f.store.ListNotes(f.ctx, otherTenant, root.ID); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("other tenant = %v", err)
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, root.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID, Changes: []domain.NoteChange{
		{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "y"}}}); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("write to an archived conversation = %v", err)
	}
	if got, _ := f.store.ListNotes(f.ctx, tenant, root.ID); len(got.Notes) != 1 {
		t.Fatalf("archived notes must stay readable: %+v", got)
	}
}

func TestNotes_EmptyChangesWriteNothing(t *testing.T) {
	f := newFixture(t)
	root, _ := f.mainLine()
	write, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: root.ID})
	if err != nil || write.Revision != 0 || len(write.Created) != 0 {
		t.Fatalf("empty write = %+v err=%v", write, err)
	}
}
