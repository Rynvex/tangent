package store_test

import (
	"errors"
	"slices"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) combine(parentID, anchorID string, ids ...string) (store.CombinedBranches, error) {
	f.t.Helper()
	return f.store.CombineBranches(f.ctx, store.CombineInput{
		Tenant: tenant, ParentLineID: parentID, LineIDs: ids, AnchorMessageID: anchorID, Purpose: "together", Kind: domain.BranchKindInvestigate,
	})
}

func TestCombine_OpenChildrenMoveToTheNewBranch(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	a, b := f.branch(main.ID, anchor.ID), f.branch(main.ID, anchor.ID)
	onA := f.reply(a.ID)
	open1 := f.branch(a.ID, onA.ID)
	closed := f.endedBranch(a.ID, onA.ID, "done")
	onB := f.reply(b.ID)
	open2 := f.branch(b.ID, onB.ID)
	grand := f.branch(open2.ID, f.reply(open2.ID).ID)
	out, err := f.combine(main.ID, anchor.ID, a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	newID := out.Created.Line.ID
	want := []string{open1.ID, open2.ID}
	slices.Sort(want)
	if !slices.Equal(out.Reparented, want) {
		t.Fatalf("reparented = %v, want %v", out.Reparented, want)
	}
	for id, wantAnchor := range map[string]string{open1.ID: onA.ID, open2.ID: onB.ID} {
		view := f.branchView(id)
		if view.ParentLineID != newID || view.Depth != 2 || view.AnchorMessageID != wantAnchor || view.Status != domain.BranchStatusOpen {
			t.Fatalf("child %s = %+v", id, view)
		}
	}
	if f.branchView(closed).ParentLineID != a.ID {
		t.Fatal("an ended child stays where it ended")
	}
	if g := f.branchView(grand.ID); g.ParentLineID != open2.ID || g.Depth != 3 {
		t.Fatalf("the grandchild comes along: %+v", g)
	}
	if out.Created.Line.BranchCounts.Open != 2 {
		t.Fatalf("the new branch counts its children: %+v", out.Created.Line.BranchCounts)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: open1.ID, Content: "still going?"}); err != nil {
		t.Fatalf("a moved child can be continued: %v", err)
	}
}

func TestCombine_TheNewBranchKeepsTheOpenBranchCap(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.Branch.MaxOpenPerParent = 2
	f := newFixtureWithLimits(t, limits)
	main, anchor := f.mainLine()
	a, b := f.branch(main.ID, anchor.ID), f.branch(main.ID, anchor.ID)
	onA, onB := f.reply(a.ID), f.reply(b.ID)
	f.branch(a.ID, onA.ID)
	f.branch(a.ID, onA.ID)
	f.branch(b.ID, onB.ID)
	if _, err := f.combine(main.ID, anchor.ID, a.ID, b.ID); !errors.Is(err, domain.ErrBranchLimit) {
		t.Fatalf("three open children over a cap of two: %v", err)
	}
	if f.branchView(a.ID).Status != domain.BranchStatusOpen {
		t.Fatal("nothing changed")
	}
}

func TestP2c1Concurrency_ABranchOpenedUnderACombinedOneEndsUpOnTheNewOne(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	for range 5 {
		a, b := f.branch(main.ID, anchor.ID), f.branch(main.ID, anchor.ID)
		onA := f.reply(a.ID)
		var child string
		errs := race(
			func() error { _, err := f.combine(main.ID, anchor.ID, a.ID, b.ID); return err },
			func() error {
				created, err := f.store.CreateBranch(f.ctx, f.branchInput(a.ID, onA.ID))
				child = created.Line.ID
				return err
			},
		)
		if errs[0] != nil {
			t.Fatalf("combine: %v", errs[0])
		}
		if errs[1] == nil {
			if view := f.branchView(child); view.ParentLineID == a.ID {
				t.Fatalf("a child created first follows the combine: %+v", view)
			}
		} else if !errors.Is(errs[1], domain.ErrBranchParentClosed) && !errors.Is(errs[1], domain.ErrBranchClosed) {
			t.Fatalf("a child created after is refused: %v", errs[1])
		}
		if n := f.count(`SELECT count(*) FROM tangent_branch c JOIN tangent_branch p ON p.line_id = c.parent_line_id
			WHERE c.status = 'open' AND p.status <> 'open' AND p.merged_into_line_id IS NOT NULL`); n != 0 {
			t.Fatalf("%d open branches under a combined one", n)
		}
		f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE parent_line_id = $1 AND status = 'open'`, main.ID)
	}
}
