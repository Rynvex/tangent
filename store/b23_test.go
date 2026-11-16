package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// B23: keep, continue and delete under the locks root → parent → line →
// the lines below it in id order.

// answeredAside is an aside on the anchor with its one answer.
func (f *fixture) answeredAside(rootID, anchorID string) domain.LineView {
	f.t.Helper()
	aside := f.aside(rootID, anchorID)
	f.answer(f.busy(aside.ID).Pending.ID, "the answer")
	return aside
}

func (f *fixture) continueInput(aside domain.LineView, anchorID string) store.ContinueAsideInput {
	return store.ContinueAsideInput{
		Tenant: tenant, LineID: aside.ID, Kind: domain.BranchKindInvestigate, CreatedBy: "chang",
		ParentLineID: aside.ConversationBranch.ParentLineID, AnchorMessageID: anchorID,
		Pack: domain.BranchPack{Rendered: "pack text", AnchorMessageID: anchorID},
	}
}

func TestB23_AKeptAsideIsSkippedByThePurgeEvenWhenItWasListed(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	root, anchor := f.mainLine()
	aside := f.answeredAside(root.ID, anchor.ID)
	clock.now = time.Now().Add(2 * domain.DefaultLimits().Branch.AsideRetention)
	for range 8 {
		errs := race(
			func() error { _, err := f.store.PurgeExpiredAsides(f.ctx, 0); return err },
			func() error { _, err := f.store.KeepBranch(f.ctx, tenant, aside.ID, true); return err },
		)
		if errors.Is(errs[1], domain.ErrBranchNotFound) && errs[0] == nil {
			// The purge went first.
			if _, err := f.store.GetLine(f.ctx, tenant, aside.ID); !errors.Is(err, domain.ErrLineNotFound) {
				t.Fatalf("keep refused but the aside is there: %v", err)
			}
			aside = f.answeredAside(root.ID, anchor.ID)
			continue
		}
		if errs[0] != nil || errs[1] != nil {
			t.Fatalf("errs = %v", errs)
		}
		// The keep went first: the purge, which may have listed the aside
		// before, re-reads it under the lock and leaves it.
		if view := f.branchView(aside.ID); view.KeptAt == nil {
			t.Fatalf("kept aside = %+v", view)
		}
		if _, err := f.store.KeepBranch(f.ctx, tenant, aside.ID, false); err != nil {
			t.Fatal(err)
		}
	}
}

func TestB23_ContinueRacingThePurgeEndsAsOneOfThem(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	root, anchor := f.mainLine()
	clock.now = time.Now().Add(2 * domain.DefaultLimits().Branch.AsideRetention)
	for range 10 {
		aside := f.answeredAside(root.ID, anchor.ID)
		var continued store.ContinuedAside
		errs := race(
			func() error { _, err := f.store.PurgeExpiredAsides(f.ctx, 0); return err },
			func() (err error) {
				continued, err = f.store.ContinueAside(f.ctx, f.continueInput(aside, anchor.ID))
				return err
			},
		)
		if errs[0] != nil {
			t.Fatalf("purge: %v", errs[0])
		}
		if _, err := f.store.GetLine(f.ctx, tenant, aside.ID); !errors.Is(err, domain.ErrLineNotFound) {
			t.Fatalf("the aside is gone either way: %v", err)
		}
		switch {
		case errs[1] == nil:
			// The continue won: its exchange lives on in the new branch.
			if got := f.texts(continued.Line.ID); len(got) != 2 || got[1] != "the answer" {
				t.Fatalf("the new branch = %v", got)
			}
			if _, err := f.store.DiscardBranch(f.ctx, tenant, continued.Line.ID); err != nil {
				t.Fatal(err)
			}
		case errors.Is(errs[1], domain.ErrBranchNotFound):
			// The purge won: nothing was created.
		default:
			t.Fatalf("continue: %v", errs[1])
		}
		if n := f.count(`SELECT count(*)::int FROM tangent_branch WHERE root_line_id = $1 AND status = 'open'`, root.ID); n != 0 {
			t.Fatalf("%d open branches left", n)
		}
		if n := f.count(`SELECT count(*)::int FROM tangent_message m WHERE NOT EXISTS (SELECT 1 FROM tangent_line l WHERE l.id = m.line_id)`); n != 0 {
			t.Fatalf("%d messages without a line", n)
		}
	}
}

func TestB23_TwoContinuesOfOneAsideMakeOneBranch(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	for range 6 {
		aside := f.answeredAside(root.ID, anchor.ID)
		in := f.continueInput(aside, anchor.ID)
		errs := race(
			func() error { _, err := f.store.ContinueAside(f.ctx, in); return err },
			func() error { _, err := f.store.ContinueAside(f.ctx, in); return err },
			func() error { _, err := f.store.DeleteBranch(f.ctx, tenant, aside.ID); return err },
		)
		won := 0
		for _, err := range errs {
			switch {
			case err == nil:
				won++
			case !errors.Is(err, domain.ErrBranchNotFound) && !errors.Is(err, domain.ErrLineNotFound):
				t.Fatalf("errs = %v", errs)
			}
		}
		if won != 1 {
			t.Fatalf("%d writes won: %v", won, errs)
		}
		f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE root_line_id = $1 AND status = 'open'`, root.ID)
	}
}

func TestB23_DeleteRacingADetachFollowsTheBranchToItsNewTree(t *testing.T) {
	f := newFixture(t)
	for range 8 {
		root, anchor := f.mainLine()
		parent := f.branch(root.ID, anchor.ID)
		ended := f.branch(parent.ID, f.reply(parent.ID).ID)
		f.reply(ended.ID)
		if _, err := f.store.DiscardBranch(f.ctx, tenant, ended.ID); err != nil {
			t.Fatal(err)
		}
		errs := race(
			func() error { _, err := f.store.DeleteBranch(f.ctx, tenant, ended.ID); return err },
			func() error {
				_, err := f.store.Detach(f.ctx, store.DetachInput{Tenant: tenant, LineID: parent.ID, BuildCapsule: func(store.DetachBase) domain.OriginCapsule {
					return domain.OriginCapsule{}
				}})
				return err
			},
		)
		if errs[0] != nil || errs[1] != nil {
			t.Fatalf("errs = %v", errs)
		}
		if _, err := f.store.GetLine(f.ctx, tenant, ended.ID); !errors.Is(err, domain.ErrLineNotFound) {
			t.Fatalf("the deleted branch: %v", err)
		}
		if f.line(parent.ID).ConversationBranch != nil {
			t.Fatal("the detached branch is a main line")
		}
		if n := f.count(`SELECT count(*)::int FROM tangent_branch WHERE root_line_id = ANY($1::uuid[])`, []string{root.ID, parent.ID}); n != 0 {
			t.Fatalf("%d branch rows left in the two trees", n)
		}
	}
}

func TestB23_DeleteRacingAnAttachOfItsTree(t *testing.T) {
	f := newFixture(t)
	for range 8 {
		target, _ := f.mainLine()
		source, anchor := f.mainLine()
		ended := f.branch(source.ID, anchor.ID)
		f.reply(ended.ID)
		if _, err := f.store.DiscardBranch(f.ctx, tenant, ended.ID); err != nil {
			t.Fatal(err)
		}
		errs := race(
			func() error { _, err := f.store.DeleteBranch(f.ctx, tenant, ended.ID); return err },
			func() error { _, err := f.store.AttachLine(f.ctx, f.attachInput(target.ID, source.ID)); return err },
		)
		if errs[0] != nil || errs[1] != nil {
			t.Fatalf("errs = %v", errs)
		}
		if _, err := f.store.GetLine(f.ctx, tenant, ended.ID); !errors.Is(err, domain.ErrLineNotFound) {
			t.Fatalf("the deleted branch: %v", err)
		}
		if n := f.count(`SELECT count(*)::int FROM tangent_branch WHERE root_line_id = $1`, source.ID); n != 0 {
			t.Fatalf("%d branch rows under the attached line", n)
		}
		if view := f.branchView(source.ID); view.RootLineID != target.ID {
			t.Fatalf("the attached line = %+v", view)
		}
	}
}
