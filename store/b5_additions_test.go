package store_test

import (
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestB5_ACompletedTurnReturnsTheCardsItDelivered(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	card := f.card(line.ID)
	failing := f.busy(line.ID)
	failed, err := f.store.CompleteTurn(f.ctx, store.CompleteTurnInput{TurnID: failing.Pending.ID, Outcome: domain.ResolveTurnOutcome("", "boom")})
	if err != nil || len(failed.DeliveredCards) != 0 {
		t.Fatalf("a failed turn delivers nothing: %+v, %v", failed.DeliveredCards, err)
	}
	ok := f.busy(line.ID)
	done := f.answer(ok.Pending.ID, "fine")
	if len(done.DeliveredCards) != 1 || done.DeliveredCards[0].ID != card.ID || !done.DeliveredCards[0].Meta.Delivered {
		t.Fatalf("delivered cards %+v", done.DeliveredCards)
	}
	again := f.answer(f.busy(line.ID).Pending.ID, "again")
	if len(again.DeliveredCards) != 0 {
		t.Fatalf("a delivered card is not delivered twice: %+v", again.DeliveredCards)
	}
}

func TestB5_RenameBranchChangesOpenAndEndedBranches(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	view, err := f.store.RenameBranch(f.ctx, tenant, branch.ID, "  a better purpose  ")
	if err != nil {
		t.Fatal(err)
	}
	if view.Purpose != "a better purpose" || view.LineID != branch.ID {
		t.Fatalf("renamed %+v", view)
	}
	if line := f.line(branch.ID); line.Title != "a better purpose" {
		t.Fatalf("the branch line keeps its title in step: %q", line.Title)
	}
	if _, err := f.store.RenameBranch(f.ctx, tenant, branch.ID, " "); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("an empty purpose: %v", err)
	}
	long := string(make([]rune, domain.DefaultLimits().Branch.PurposeMaxRunes+1))
	if _, err := f.store.RenameBranch(f.ctx, tenant, branch.ID, long); err == nil {
		t.Fatal("a purpose over the limit is refused")
	}
	if _, err := f.store.RenameBranch(f.ctx, otherTenant, branch.ID, "x y"); domain.CodeOf(err) != domain.CodeBranchNotFound {
		t.Fatalf("another tenant: %v", err)
	}
	if _, err := f.store.RenameBranch(f.ctx, tenant, parent.ID, "x y"); domain.CodeOf(err) != domain.CodeBranchNotFound {
		t.Fatalf("a main line: %v", err)
	}
	failing := failingHook(errHookB5)
	if _, err := f.store.RenameBranch(f.ctx, tenant, branch.ID, "rolled back", failing); err == nil {
		t.Fatal("a failing hook rolls back")
	}
	if got := f.branchView(branch.ID).Purpose; got != "a better purpose" {
		t.Fatalf("after the rollback: %q", got)
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, parent.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.RenameBranch(f.ctx, tenant, branch.ID, "archived"); domain.CodeOf(err) != domain.CodeArchived {
		t.Fatalf("an archived tree: %v", err)
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, parent.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID); err != nil {
		t.Fatal(err)
	}
	// B13: an ended branch can be renamed too.
	view, err = f.store.RenameBranch(f.ctx, tenant, branch.ID, "renamed after it ended")
	if err != nil || view.Purpose != "renamed after it ended" || view.Status != domain.BranchStatusDiscarded {
		t.Fatalf("an ended branch: %+v %v", view, err)
	}
	if line := f.line(branch.ID); line.Title != "renamed after it ended" {
		t.Fatalf("the ended branch's line follows: %q", line.Title)
	}
}

// B13: a promoted branch (its messages went to the main line) and the
// previous main line keep their names.
func TestB13_RenameRefusesPromotedAndPreviousMainLine(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	f.exchange(root.ID, "tail q", "tail a")
	alt := f.branch(root.ID, anchor.ID)
	out, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.RenameBranch(f.ctx, tenant, out.PromotedID, "x y"); domain.CodeOf(err) != domain.CodeBranchClosed {
		t.Fatalf("a promoted branch: %v", err)
	}
	if out.PreviousID == "" {
		t.Fatal("the promotion leaves a previous main line")
	}
	if _, err := f.store.RenameBranch(f.ctx, tenant, out.PreviousID, "x y"); domain.CodeOf(err) != domain.CodeBranchClosed {
		t.Fatalf("the previous main line: %v", err)
	}
}

var errHookB5 = errors.New("hook refuses")

// The promotion walks every subtree on the old tail at once (B5: one query
// instead of two per tail branch): an open branch below a closed one still
// blocks it, and every subtree goes one level down.
func TestB5_PromoteChecksAndShiftsEveryTailSubtreeAtOnce(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	first := f.exchange(root.ID, "tail q1", "tail a1")
	second := f.exchange(root.ID, "tail q2", "tail a2")
	closedTop := f.branch(root.ID, first.ID)
	openBelow := f.branch(closedTop.ID, f.exchange(closedTop.ID, "below q", "below a").ID)
	other := f.branch(root.ID, second.ID)
	for _, id := range []string{closedTop.ID, other.ID} {
		if _, err := f.store.DiscardBranch(f.ctx, tenant, id); err != nil {
			t.Fatal(err)
		}
	}
	alt := f.branch(root.ID, anchor.ID)
	var openTail *domain.BranchOpenTailError
	if _, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID); !errors.As(err, &openTail) || len(openTail.LineIDs) != 1 || openTail.LineIDs[0] != openBelow.ID {
		t.Fatalf("an open branch below a closed one on the tail: %v", err)
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, openBelow.ID); err != nil {
		t.Fatal(err)
	}
	out, err := f.store.PromoteBranch(f.ctx, tenant, alt.ID)
	if err != nil {
		t.Fatal(err)
	}
	for id, depth := range map[string]int{closedTop.ID: 2, other.ID: 2, openBelow.ID: 3} {
		if view := f.branchView(id); view.Depth != depth || (depth == 2 && view.ParentLineID != out.PreviousID) {
			t.Fatalf("%s: %+v, want depth %d", id, view, depth)
		}
	}
}

func TestB5_BranchViewsReadsManyBranchesInTheGivenOrder(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	a, b := f.branch(root.ID, anchor.ID), f.branch(root.ID, anchor.ID)
	views, err := f.store.BranchViews(f.ctx, tenant, []string{b.ID, "not-an-id", root.ID, a.ID})
	if err != nil || len(views) != 2 || views[0].LineID != b.ID || views[1].LineID != a.ID || views[0].Purpose != "check it" {
		t.Fatalf("views %+v, %v", views, err)
	}
	if other, err := f.store.BranchViews(f.ctx, otherTenant, []string{a.ID}); err != nil || len(other) != 0 {
		t.Fatalf("another tenant: %+v, %v", other, err)
	}
	if none, err := f.store.BranchViews(f.ctx, tenant, nil); err != nil || len(none) != 0 {
		t.Fatalf("no ids: %+v, %v", none, err)
	}
}
