package store_test

import (
	"errors"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// race runs the writes at once and returns their errors in order: every
// goroutine waits at a start gate until all of them are ready.
func race(writes ...func() error) []error {
	errs := make([]error, len(writes))
	var ready, done sync.WaitGroup
	gate := make(chan struct{})
	ready.Add(len(writes))
	for i, write := range writes {
		done.Go(func() {
			ready.Done()
			<-gate
			errs[i] = write()
		})
	}
	ready.Wait()
	close(gate)
	done.Wait()
	return errs
}

func TestP1Concurrency_ASeedEndsExactlyOnce(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	for range 5 {
		seed := f.seed(main.ID, anchor.ID, "contested")
		in := store.ExpandSeedInput{SeedID: seed.ID, CreateBranchInput: f.branchInput(main.ID, anchor.ID)}
		errs := race(
			func() error { _, err := f.store.ExpandSeed(f.ctx, in); return err },
			func() error { _, err := f.store.DropSeed(f.ctx, tenant, seed.ID); return err },
			func() error {
				_, err := f.store.NoteSeed(f.ctx, store.NoteSeedInput{Tenant: tenant, SeedID: seed.ID})
				return err
			},
		)
		won := 0
		for _, err := range errs {
			switch {
			case err == nil:
				won++
			case !errors.Is(err, domain.ErrSeedNotOpen):
				t.Fatalf("unexpected: %v", err)
			}
		}
		if won != 1 {
			t.Fatalf("%d endings won: %v", won, errs)
		}
	}
	if n := f.count(`SELECT count(*) FROM tangent_branch WHERE origin = 'seed'`); n > 5 {
		t.Fatalf("seed branches = %d", n)
	}
}

func TestP1Concurrency_ADraftAndTheOperatorsLeafNeverMix(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	for range 5 {
		job := f.leafJob(branch.ID)
		errs := race(
			func() error {
				_, err := f.store.FinishLeafDraft(f.ctx, job.ID, domain.LeafInput{Kind: "answer", Line: "ai"}, domain.LeafStatusDraft)
				return err
			},
			func() error {
				_, err := f.store.PutLeaf(f.ctx, store.PutLeafInput{Tenant: tenant, LineID: branch.ID, Leaf: domain.LeafInput{Kind: "decision", Line: "mine"}})
				return err
			},
		)
		if errs[0] != nil || errs[1] != nil {
			t.Fatalf("errs = %v", errs)
		}
		leaf, _ := f.store.GetLeaf(f.ctx, tenant, branch.ID)
		if leaf.AIDrafted != (leaf.Line == "ai") {
			t.Fatalf("a leaf is either the draft or the operator's: %+v", leaf)
		}
	}
}

func TestP1Concurrency_AcceptingWhileTheBranchEndsLeavesOneOutcome(t *testing.T) {
	f := newFixture(t)
	for range 5 {
		_, branch := f.openBranch()
		proposal := f.propose(branch.ID, "b")
		errs := race(
			func() error {
				_, err := f.store.DecideSuggestion(f.ctx, tenant, proposal.Suggestion.ID, domain.SuggestionAccepted)
				return err
			},
			func() error {
				_, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID, expireHook(f, branch.ID))
				return err
			},
		)
		if errs[1] != nil || (errs[0] != nil && !errors.Is(errs[0], domain.ErrSuggestionNotOpen)) {
			t.Fatalf("errs = %v", errs)
		}
		got, _ := f.store.GetSuggestion(f.ctx, tenant, proposal.Suggestion.ID)
		if (errs[0] == nil) != (got.Status == domain.SuggestionAccepted) || (errs[0] != nil && got.Status != domain.SuggestionExpired) {
			t.Fatalf("status %s with accept error %v", got.Status, errs[0])
		}
	}
}
