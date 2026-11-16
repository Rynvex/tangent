package store_test

import (
	"errors"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// B20: attaches under the locks main lines (id order) → target → source tree.

func (f *fixture) attachInput(targetID, sourceID string) store.AttachInput {
	return store.AttachInput{Tenant: tenant, TargetLineID: targetID, SourceLineID: sourceID, Kind: domain.BranchKindInvestigate, Status: domain.AttachStatusOpen, CreatedBy: "chang"}
}

func TestAttach_CrossedAttachesNeverDeadlockAndOneWins(t *testing.T) {
	f := newFixture(t)
	for range 5 {
		a, _ := f.mainLine()
		b, _ := f.mainLine()
		branchOfA := f.branch(a.ID, f.reply(a.ID).ID)
		f.reply(branchOfA.ID)
		errs := race(
			func() error { _, err := f.store.AttachLine(f.ctx, f.attachInput(a.ID, b.ID)); return err },
			func() error { _, err := f.store.AttachLine(f.ctx, f.attachInput(branchOfA.ID, b.ID)); return err },
			func() error { _, err := f.store.AttachLine(f.ctx, f.attachInput(b.ID, a.ID)); return err },
		)
		won := 0
		for _, err := range errs {
			switch {
			case err == nil:
				won++
			case !errors.Is(err, domain.ErrAttachNotMainLine) && !errors.Is(err, domain.ErrAttachSelf):
				t.Fatalf("unexpected: %v", err)
			}
		}
		if won != 1 {
			t.Fatalf("%d attaches won: %v", won, errs)
		}
		// Whatever won, both conversations are one tree with consistent rows.
		roots := f.count(`SELECT count(*)::int FROM tangent_line l WHERE l.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)`,
			[]string{a.ID, b.ID})
		if roots != 1 {
			t.Fatalf("%d main lines left of the two", roots)
		}
		if n := f.count(`SELECT count(*)::int FROM tangent_branch b JOIN tangent_branch p ON p.line_id = b.parent_line_id WHERE p.depth + 1 <> b.depth`); n != 0 {
			t.Fatalf("%d branches with a depth that is not their parent's + 1", n)
		}
	}
}

func TestAttach_ATurnStartedMeanwhileWaitsOrRefuses(t *testing.T) {
	f := newFixture(t)
	target, _ := f.mainLine()
	source, _ := f.mainLine()
	errs := race(
		func() error { _, err := f.store.AttachLine(f.ctx, f.attachInput(target.ID, source.ID)); return err },
		func() error {
			_, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: source.ID, Content: "racing"})
			return err
		},
	)
	switch {
	case errs[0] == nil && errs[1] == nil:
		// The attach went first: the turn runs in the branch.
		if f.line(source.ID).ConversationBranch == nil {
			t.Fatal("the attached line is a branch")
		}
	case errors.Is(errs[0], domain.ErrBranchBusy) && errs[1] == nil:
	default:
		t.Fatalf("errs = %v", errs)
	}
}

func TestAttach_WritesRacingTheAttachLandInTheRightTree(t *testing.T) {
	f := newFixture(t)
	for range 8 {
		target, _ := f.mainLine()
		source, anchor := f.mainLine()
		errs := race(
			func() error { _, err := f.store.AttachLine(f.ctx, f.attachInput(target.ID, source.ID)); return err },
			func() error { _, err := f.store.CreateBranch(f.ctx, f.branchInput(source.ID, anchor.ID)); return err },
			func() error {
				_, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{Tenant: tenant, LineID: source.ID, Changes: []domain.NoteChange{{Op: "add", Section: "fact", Text: "racing"}}})
				return err
			},
		)
		for _, err := range errs {
			if err != nil {
				t.Fatalf("errs = %v", errs)
			}
		}
		if n := f.count(`SELECT count(*)::int FROM tangent_branch WHERE root_line_id = $1`, source.ID); n != 0 {
			t.Fatalf("%d branch rows under the attached line", n)
		}
		if n := f.count(`SELECT count(*)::int FROM tangent_note WHERE root_line_id = $1`, source.ID); n != 0 {
			t.Fatalf("%d notes under the attached line", n)
		}
		if n := f.count(`SELECT count(*)::int FROM tangent_branch b JOIN tangent_branch p ON p.line_id = b.parent_line_id WHERE p.depth + 1 <> b.depth OR p.root_line_id <> b.root_line_id`); n != 0 {
			t.Fatalf("%d branches out of step with their parent", n)
		}
	}
}

func TestAttach_BranchWritesRacingTheAttachLockTheNewRoot(t *testing.T) {
	f := newFixture(t)
	for range 8 {
		target, _ := f.mainLine()
		source, anchor := f.mainLine()
		child := f.branch(source.ID, anchor.ID)
		f.reply(child.ID)
		errs := race(
			func() error { _, err := f.store.AttachLine(f.ctx, f.attachInput(target.ID, source.ID)); return err },
			func() error { _, err := f.store.DiscardBranch(f.ctx, tenant, child.ID); return err },
			func() error {
				_, err := f.store.ProposeSuggestion(f.ctx, store.ProposeInput{Tenant: tenant, LineID: child.ID, Feature: "probe", Kind: "probe", TargetKey: "racing"})
				return err
			},
		)
		for _, err := range errs {
			if err != nil {
				t.Fatalf("errs = %v", errs)
			}
		}
		for _, table := range []string{"tangent_branch", "tangent_suggestion", "tangent_leaf"} {
			if n := f.count(`SELECT count(*)::int FROM `+table+` WHERE root_line_id = $1`, source.ID); n != 0 {
				t.Fatalf("%d %s rows under the attached line", n, table)
			}
		}
		if got := f.branchView(child.ID); got.RootLineID != target.ID || got.Depth != 2 || got.Status != domain.BranchStatusDiscarded {
			t.Fatalf("child = %+v", got)
		}
	}
}
