package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) propose(lineID, target string, mutate ...func(*store.ProposeInput)) store.Proposal {
	f.t.Helper()
	in := store.ProposeInput{Tenant: tenant, LineID: lineID, Feature: "probe", Kind: "probe", TargetKey: target, Payload: json.RawMessage(`{"why":"x"}`)}
	for _, m := range mutate {
		m(&in)
	}
	proposal, err := f.store.ProposeSuggestion(f.ctx, in)
	if err != nil {
		f.t.Fatal(err)
	}
	return proposal
}

func TestSuggestions_OneOpenPerTargetAndTheTreeSeesThem(t *testing.T) {
	f := newFixture(t)
	main, branch := f.openBranch()
	first := f.propose(branch.ID, "branch:"+branch.ID)
	if !first.Created || first.Suggestion.Status != domain.SuggestionOpen || first.Suggestion.RootLineID != main.ID ||
		first.Suggestion.LineID != branch.ID || string(first.Suggestion.Payload) != `{"why": "x"}` || first.Suggestion.DecidedAt != nil {
		t.Fatalf("first = %+v", first)
	}
	if again := f.propose(branch.ID, "branch:"+branch.ID); again.Created {
		t.Fatalf("a second open suggestion for the same target: %+v", again)
	}
	other := f.propose(main.ID, "line:"+main.ID)
	list, err := f.store.ListSuggestions(f.ctx, store.SuggestionQuery{Tenant: tenant, LineID: branch.ID, Features: []string{"probe"}})
	if err != nil || list.RootLineID != main.ID || len(list.Suggestions) != 2 || list.Suggestions[0].ID != other.Suggestion.ID {
		t.Fatalf("list = %+v %v", list, err)
	}
	if none, _ := f.store.ListSuggestions(f.ctx, store.SuggestionQuery{Tenant: tenant, LineID: main.ID, Features: []string{"rebalance"}}); len(none.Suggestions) != 0 {
		t.Fatalf("other features' suggestions are left out: %+v", none)
	}
	if _, err := f.store.ListSuggestions(f.ctx, store.SuggestionQuery{Tenant: otherTenant, LineID: main.ID, Features: []string{"probe"}}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	if got := f.line(main.ID); got.OpenSuggestions != 2 || f.line(branch.ID).OpenSuggestions != 0 {
		t.Fatalf("main line counts %d", got.OpenSuggestions)
	}
	if _, err := f.store.GetSuggestion(f.ctx, otherTenant, first.Suggestion.ID); !errors.Is(err, domain.ErrSuggestionGone) {
		t.Fatalf("another tenant's suggestion: %v", err)
	}
}

func TestSuggestions_DismissCoolsDownAndPermanentNeverReturns(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	main, _ := f.mainLine()
	target := "line:" + main.ID
	first := f.propose(main.ID, target)
	dismissed, err := f.store.DecideSuggestion(f.ctx, tenant, first.Suggestion.ID, domain.SuggestionDismissed)
	if err != nil || dismissed.Status != domain.SuggestionDismissed || dismissed.DecidedAt == nil {
		t.Fatalf("dismissed = %+v %v", dismissed, err)
	}
	if _, err := f.store.DecideSuggestion(f.ctx, tenant, first.Suggestion.ID, domain.SuggestionAccepted); !errors.Is(err, domain.ErrSuggestionNotOpen) {
		t.Fatalf("a decided suggestion stays decided: %v", err)
	}
	if again := f.propose(main.ID, target); again.Created {
		t.Fatal("raised again during the cooldown")
	}
	clock.now = clock.now.Add(8 * 24 * time.Hour)
	if again := f.propose(main.ID, target); !again.Created {
		t.Fatal("raised again after the cooldown")
	}
	permanent := func(in *store.ProposeInput) { in.Kind, in.Permanent = "keep", true }
	kept := f.propose(main.ID, target, permanent)
	if _, err := f.store.DecideSuggestion(f.ctx, tenant, kept.Suggestion.ID, domain.SuggestionDismissed); err != nil {
		t.Fatal(err)
	}
	clock.now = clock.now.Add(365 * 24 * time.Hour)
	if again := f.propose(main.ID, target, permanent); again.Created {
		t.Fatal("a permanent dismissal is never raised again")
	}
	short := func(in *store.ProposeInput) { in.Kind, in.Cooldown = "short", time.Minute }
	s := f.propose(main.ID, target, short)
	if _, err := f.store.DecideSuggestion(f.ctx, tenant, s.Suggestion.ID, domain.SuggestionDismissed); err != nil {
		t.Fatal(err)
	}
	clock.now = clock.now.Add(2 * time.Minute)
	if again := f.propose(main.ID, target, short); !again.Created {
		t.Fatal("a feature's own cooldown applies")
	}
}

func TestSuggestions_RefusalsAndArchivedTrees(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	for name, in := range map[string]store.ProposeInput{
		"no feature": {Tenant: tenant, LineID: main.ID, Kind: "k", TargetKey: "t"},
		"no target":  {Tenant: tenant, LineID: main.ID, Feature: "f", Kind: "k"},
		"payload":    {Tenant: tenant, LineID: main.ID, Feature: "f", Kind: "k", TargetKey: "t", Payload: json.RawMessage(`[1]`)},
	} {
		if _, err := f.store.ProposeSuggestion(f.ctx, in); domain.CodeOf(err) != domain.CodeInvalidInput {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := f.store.ProposeSuggestion(f.ctx, store.ProposeInput{Tenant: otherTenant, LineID: main.ID, Feature: "f", Kind: "k", TargetKey: "t"}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("another tenant's line: %v", err)
	}
	if _, err := f.store.DecideSuggestion(f.ctx, tenant, "not-an-id", domain.SuggestionDismissed); !errors.Is(err, domain.ErrSuggestionGone) {
		t.Fatalf("bad id: %v", err)
	}
	open := f.propose(main.ID, "t")
	if _, err := f.store.DecideSuggestion(f.ctx, tenant, open.Suggestion.ID, domain.SuggestionExpired); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("only accept or dismiss: %v", err)
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, main.ID, true); err != nil {
		t.Fatal(err)
	}
	if p := f.propose(main.ID, "t2"); p.Created {
		t.Fatal("an archived conversation gets no new suggestions")
	}
}

func TestSuggestions_AHookFailureKeepsItOpenAndAcceptRunsInTheSameTransaction(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	open := f.propose(main.ID, "t")
	if _, err := f.store.DecideSuggestion(f.ctx, tenant, open.Suggestion.ID, domain.SuggestionAccepted, failingHook(errors.New("no"))); err == nil {
		t.Fatal("the hook refused")
	}
	if got, _ := f.store.GetSuggestion(f.ctx, tenant, open.Suggestion.ID); got.Status != domain.SuggestionOpen {
		t.Fatalf("rolled back: %+v", got)
	}
	marked := func(ctx context.Context, tx store.Tx, _ any) error {
		_, err := store.MarkSuggestionAccepted(ctx, tx, open.Suggestion.ID)
		return err
	}
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{
		Tenant: tenant, LineID: main.ID, Changes: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: "fact", Text: "x"}},
	}, marked); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.store.GetSuggestion(f.ctx, tenant, open.Suggestion.ID); got.Status != domain.SuggestionAccepted {
		t.Fatalf("accepted with the write: %+v", got)
	}
	if _, err := f.store.ApplyNoteChanges(f.ctx, store.ApplyNotesInput{
		Tenant: tenant, LineID: main.ID, Changes: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: "fact", Text: "y"}},
	}, marked); !errors.Is(err, domain.ErrSuggestionNotOpen) {
		t.Fatalf("accepting twice rolls the write back: %v", err)
	}
	if n := f.count(`SELECT count(*) FROM tangent_note WHERE root_line_id = $1`, main.ID); n != 1 {
		t.Fatalf("notes = %d", n)
	}
}

func TestSuggestions_EndedLinesExpireTheirSuggestions(t *testing.T) {
	f := newFixture(t)
	main, branch := f.openBranch()
	child := f.branch(branch.ID, f.reply(branch.ID).ID)
	onBranch := f.propose(branch.ID, "a")
	onChild := f.propose(child.ID, "b")
	onMain := f.propose(main.ID, "c")
	var expired []domain.Suggestion
	hook := func(ctx context.Context, tx store.Tx, _ any) error {
		ids, err := f.store.LinesEndedWith(ctx, tx, branch.ID, true)
		if err != nil {
			return err
		}
		expired, err = store.ExpireSuggestions(ctx, tx, ids)
		return err
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID, hook); err != nil {
		t.Fatal(err)
	}
	if len(expired) != 2 || expired[0].Status != domain.SuggestionExpired {
		t.Fatalf("expired = %+v", expired)
	}
	for id, want := range map[string]string{onBranch.Suggestion.ID: "expired", onChild.Suggestion.ID: "expired", onMain.Suggestion.ID: "open"} {
		if got, _ := f.store.GetSuggestion(f.ctx, tenant, id); got.Status != want {
			t.Errorf("%s: %s, want %s", id, got.Status, want)
		}
	}
	if ids, err := f.store.LinesEndedWith(f.ctx, f.pool, branch.ID, false); err != nil || len(ids) != 1 || ids[0] != branch.ID {
		t.Fatalf("a promotion ends only the branch itself: %v %v", ids, err)
	}
}

func TestSuggestions_TheSweepExpiresWhatAClosedBranchLeftOpen(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	left := f.propose(branch.ID, "a")
	if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID); err != nil {
		t.Fatal(err)
	}
	swept, err := f.store.ExpireSuggestionsOfEndedBranches(f.ctx)
	if err != nil || len(swept) != 1 || swept[0].Tenant != tenant || swept[0].Suggestion.ID != left.Suggestion.ID {
		t.Fatalf("swept = %+v %v", swept, err)
	}
	if again, _ := f.store.ExpireSuggestionsOfEndedBranches(f.ctx); len(again) != 0 {
		t.Fatalf("swept twice: %+v", again)
	}
}

func TestSuggestions_ConcurrentProposalsLeaveOneOpen(t *testing.T) {
	f := newFixture(t)
	main, _ := f.mainLine()
	var wg sync.WaitGroup
	created := make(chan bool, 8)
	for range 8 {
		wg.Go(func() {
			p, err := f.store.ProposeSuggestion(f.ctx, store.ProposeInput{Tenant: tenant, LineID: main.ID, Feature: "probe", Kind: "probe", TargetKey: "same"})
			if err != nil {
				t.Error(err)
			}
			created <- p.Created
		})
	}
	wg.Wait()
	close(created)
	n := 0
	for c := range created {
		if c {
			n++
		}
	}
	if n != 1 || f.count(`SELECT count(*) FROM tangent_suggestion WHERE status = 'open'`) != 1 {
		t.Fatalf("%d created", n)
	}
}

// expireHook expires, in the write's transaction, the suggestions about a
// branch that ends and the lines below it (what the engine's inbox does).
func expireHook(f *fixture, lineID string) store.TxHook {
	return func(ctx context.Context, tx store.Tx, _ any) error {
		ids, err := f.store.LinesEndedWith(ctx, tx, lineID, true)
		if err != nil {
			return err
		}
		_, err = store.ExpireSuggestions(ctx, tx, ids)
		return err
	}
}
