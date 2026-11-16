package store_test

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) mergeInput(branchID, tip string) store.MergeBranchInput {
	return store.MergeBranchInput{
		Tenant: tenant, LineID: branchID, Card: domain.BranchCard{Question: "q", Conclusion: "the cap is 3"},
		Content: "card", ParentTipMessageID: tip, Actor: "chang",
	}
}

func TestBranchEnd_OtherTenantCannotEndOrDraft(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	in := f.mergeInput(branch.ID, f.parentTip(parent.ID))
	in.Tenant = otherTenant
	if _, err := f.store.MergeBranch(f.ctx, in); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("merge from another tenant = %v", err)
	}
	if _, err := f.store.DiscardBranch(f.ctx, otherTenant, branch.ID); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("discard from another tenant = %v", err)
	}
	if _, err := f.store.ClaimBranchDraft(f.ctx, otherTenant, branch.ID); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("draft from another tenant = %v", err)
	}
	if _, err := f.store.PromoteBranch(f.ctx, otherTenant, branch.ID); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("promote from another tenant = %v", err)
	}
	view := f.branchView(branch.ID)
	if view.Status != domain.BranchStatusOpen || view.DraftStatus != domain.BranchDraftNone {
		t.Fatalf("branch = %+v", view)
	}
}

func TestBranchEnd_MergeWritesTheCardAsTheParentsTail(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	merged, err := f.store.MergeBranch(f.ctx, f.mergeInput(branch.ID, f.parentTip(parent.ID)))
	if err != nil {
		t.Fatal(err)
	}
	if merged.ParentLineID != parent.ID || merged.RootLineID != parent.ID || merged.Card.Kind != domain.MessageKindBranchCard ||
		merged.Card.Role != domain.RoleSystem || merged.Card.Meta.BranchLineID != branch.ID || merged.Card.Meta.Card == nil ||
		merged.Branch.Status != domain.BranchStatusMerged || merged.Branch.CardMessageID != merged.Card.ID ||
		merged.Branch.ConclusionLine == "" || merged.Branch.ClosedAt == nil {
		t.Fatalf("merged = %+v", merged)
	}
	texts := f.texts(parent.ID)
	if texts[len(texts)-1] != "card" || f.line(parent.ID).Unread != 1 {
		t.Fatalf("parent = %v", texts)
	}
	if got := f.texts(branch.ID); len(got) != 2 {
		t.Fatalf("the branch keeps its messages: %v", got)
	}
}

func TestBranchEnd_MergeAndDiscardAreExclusive(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	in := f.mergeInput(branch.ID, f.parentTip(parent.ID))
	in.ConfirmParentMoved = true
	var wg sync.WaitGroup
	results := make([]error, 2)
	wg.Add(2)
	go func() { defer wg.Done(); _, results[0] = f.store.MergeBranch(f.ctx, in) }()
	go func() { defer wg.Done(); _, results[1] = f.store.DiscardBranch(f.ctx, tenant, branch.ID) }()
	wg.Wait()
	succeeded := 0
	for _, err := range results {
		if err == nil {
			succeeded++
		} else if !errors.Is(err, domain.ErrBranchClosed) {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("exactly one ending must win, got %d (%v)", succeeded, results)
	}
	view := f.branchView(branch.ID)
	if (view.Status == domain.BranchStatusMerged) != (f.cardsIn(parent.ID) == 1) {
		t.Fatalf("status %q with %d card(s) in the parent", view.Status, f.cardsIn(parent.ID))
	}
}

func TestBranchEnd_ConcurrentMergesIntoOneParentKeepEveryCard(t *testing.T) {
	f := newFixture(t)
	parent, anchor := f.mainLine()
	var branches []string
	for range 6 {
		branches = append(branches, f.branch(parent.ID, anchor.ID).ID)
	}
	tip := f.parentTip(parent.ID)
	var wg sync.WaitGroup
	errs := make([]error, len(branches))
	for i, id := range branches {
		wg.Add(1)
		go func() {
			defer wg.Done()
			in := f.mergeInput(id, tip)
			in.ConfirmParentMoved = true
			_, errs[i] = f.store.MergeBranch(f.ctx, in)
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatalf("a concurrent merge failed: %v", err)
		}
	}
	if got := f.cardsIn(parent.ID); got != len(branches) {
		t.Fatalf("cards in the parent = %d, want %d", got, len(branches))
	}
}

func TestBranchEnd_AnEndedBranchCannotBeEndedOrDraftedAgain(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	in := f.mergeInput(branch.ID, f.parentTip(parent.ID))
	if _, err := f.store.MergeBranch(f.ctx, in); err != nil {
		t.Fatal(err)
	}
	in.ConfirmParentMoved = true
	if _, err := f.store.MergeBranch(f.ctx, in); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("second merge = %v", err)
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("discard after merge = %v", err)
	}
	if _, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("draft after merge = %v", err)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: branch.ID, Content: "more"}); !errors.Is(err, domain.ErrBranchClosed) {
		t.Fatalf("turn after merge = %v", err)
	}
	if got := f.cardsIn(parent.ID); got != 1 {
		t.Fatalf("cards = %d", got)
	}
}

func TestBranchEnd_ParentBusyAndParentMoved(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	tip := f.parentTip(parent.ID)

	turn := f.busy(parent.ID)
	if _, err := f.store.MergeBranch(f.ctx, f.mergeInput(branch.ID, tip)); !errors.Is(err, domain.ErrBranchParentBusy) {
		t.Fatalf("merge while the parent answers = %v", err)
	}
	f.answer(turn.Pending.ID, "moved on")

	var moved *domain.ParentMovedError
	if _, err := f.store.MergeBranch(f.ctx, f.mergeInput(branch.ID, tip)); !errors.As(err, &moved) || moved.MovedMessages != 2 || moved.MovedCards != 0 {
		t.Fatalf("merge after the parent moved = %v", err)
	}
	// Another card counts as the parent moving on too.
	f.card(parent.ID)
	if _, err := f.store.MergeBranch(f.ctx, f.mergeInput(branch.ID, tip)); !errors.As(err, &moved) || moved.MovedMessages != 3 || moved.MovedCards != 1 {
		t.Fatalf("merge after another card = %v", err)
	}
	if _, err := f.store.MergeBranch(f.ctx, f.mergeInput(branch.ID, branch.ID)); !errors.Is(err, domain.ErrBranchParentTipUnknown) {
		t.Fatalf("a tip that is not a message = %v", err)
	}
	foreign := f.reply(branch.ID)
	if _, err := f.store.MergeBranch(f.ctx, f.mergeInput(branch.ID, foreign.ID)); !errors.Is(err, domain.ErrBranchParentTipUnknown) {
		t.Fatalf("a tip from the branch itself = %v", err)
	}
	if f.cardsIn(parent.ID) != 1 || f.branchView(branch.ID).Status != domain.BranchStatusOpen {
		t.Fatal("a refused merge changed something")
	}
	in := f.mergeInput(branch.ID, tip)
	in.ConfirmParentMoved = true
	if _, err := f.store.MergeBranch(f.ctx, in); err != nil {
		t.Fatalf("a confirmed merge = %v", err)
	}
}

func TestBranchEnd_RefusedWhileTheBranchAnswers(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	f.busy(branch.ID)
	if _, err := f.store.MergeBranch(f.ctx, f.mergeInput(branch.ID, f.parentTip(parent.ID))); !errors.Is(err, domain.ErrBranchBusy) {
		t.Fatalf("merge while the branch answers = %v", err)
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID); !errors.Is(err, domain.ErrBranchBusy) {
		t.Fatalf("discard while the branch answers = %v", err)
	}
}

func TestBranchEnd_NestedBranchBringsTheCardBackToItsOwnParent(t *testing.T) {
	f := newFixture(t)
	root, branch := f.openBranch()
	nested := f.branch(branch.ID, f.reply(branch.ID).ID)
	f.reply(nested.ID)
	merged, err := f.store.MergeBranch(f.ctx, f.mergeInput(nested.ID, f.parentTip(branch.ID)))
	if err != nil {
		t.Fatal(err)
	}
	if merged.ParentLineID != branch.ID || merged.RootLineID != root.ID || f.cardsIn(branch.ID) != 1 || f.cardsIn(root.ID) != 0 {
		t.Fatalf("merged = %+v", merged)
	}
	// A merge below a closed branch is refused.
	other := f.branch(branch.ID, f.reply(branch.ID).ID)
	f.reply(other.ID)
	if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.MergeBranch(f.ctx, f.mergeInput(other.ID, f.parentTip(branch.ID))); !errors.Is(err, domain.ErrBranchParentClosed) {
		t.Fatalf("merge into a closed branch = %v", err)
	}
}

func TestBranchEnd_DiscardKeepsTheBranchAndWritesNothingToTheParent(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	before := len(f.texts(parent.ID))
	view, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID)
	if err != nil || view.Status != domain.BranchStatusDiscarded || view.ClosedAt == nil {
		t.Fatalf("discard = %+v err=%v", view, err)
	}
	if len(f.texts(parent.ID)) != before || len(f.texts(branch.ID)) != 2 {
		t.Fatal("discard must not move or write messages")
	}
}

func TestBranchEnd_MergeWritesTheNoteChangesWithTheCardInOneStep(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	branchMsg := f.reply(branch.ID)
	old := f.addNote(parent.ID, domain.NoteSectionToConfirm, "is the cap 5?")
	in := f.mergeInput(branch.ID, f.parentTip(parent.ID))
	in.NoteChanges = []domain.NoteChange{
		{Op: domain.NoteOpAdd, Section: domain.NoteSectionDecided, Text: "the cap is 3", SourceMessageID: branchMsg.ID},
		{Op: domain.NoteOpSupersede, NoteID: old.ID, Section: domain.NoteSectionFact, Text: "the cap is 3, confirmed"},
	}
	merged, err := f.store.MergeBranch(f.ctx, in)
	if err != nil || merged.Notes.Revision != 2 || len(merged.Notes.Created) != 2 || len(merged.Notes.Superseded) != 1 {
		t.Fatalf("merge = %+v err=%v", merged.Notes, err)
	}
	for _, note := range merged.Notes.Created {
		if note.SourceLineID != branch.ID || note.SourceCardMessageID != merged.Card.ID {
			t.Errorf("a proposed note does not cite the branch and card: %+v", note)
		}
	}
	if merged.Notes.Superseded[0].Status != domain.NoteStatusSuperseded || merged.Notes.Superseded[0].SupersededBy == "" {
		t.Fatalf("old note = %+v", merged.Notes.Superseded[0])
	}
}

func TestBranchEnd_ARefusedNoteProposalLeavesCardAndNotesUntouched(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	f.addNote(parent.ID, domain.NoteSectionFact, "kept")
	before := len(f.texts(parent.ID))
	tooMany := []domain.NoteChange{}
	for range domain.DefaultLimits().Notes.MaxChangesPerMerge + 1 {
		tooMany = append(tooMany, domain.NoteChange{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "n"})
	}
	cases := []struct {
		name    string
		changes []domain.NoteChange
		code    string
	}{
		{"unknown note to supersede", []domain.NoteChange{
			{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "would be written first"},
			{Op: domain.NoteOpSupersede, NoteID: "00000000-0000-4000-8000-000000000000", Text: "x"}}, domain.CodeNoteNotFound},
		{"bad section", []domain.NoteChange{{Op: domain.NoteOpAdd, Section: "nope", Text: "x"}}, domain.CodeInvalidNote},
		{"too long", []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: strings.Repeat("b", 401)}}, domain.CodeInvalidNote},
		{"too many", tooMany, domain.CodeInvalidNote},
		{"source outside the conversation", []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "x",
			SourceMessageID: "00000000-0000-4000-8000-000000000000"}}, domain.CodeNoteSourceNotFound},
	}
	for _, tc := range cases {
		in := f.mergeInput(branch.ID, f.parentTip(parent.ID))
		in.NoteChanges = tc.changes
		if _, err := f.store.MergeBranch(f.ctx, in); domain.CodeOf(err) != tc.code {
			t.Errorf("%s = %v, want %s", tc.name, err, tc.code)
		}
	}
	notes, _ := f.store.ListNotes(f.ctx, tenant, parent.ID)
	if len(notes.Notes) != 1 || len(f.texts(parent.ID)) != before || f.branchView(branch.ID).Status != domain.BranchStatusOpen {
		t.Fatal("a refused proposal changed the notes, reached the parent or ended the branch")
	}
}
