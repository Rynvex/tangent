package store_test

import (
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestSeeds_AnchorLineAndSourceLabel(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	branch := f.branch(main.ID, anchor.ID)
	inBranch := f.reply(branch.ID)
	onMain := f.seed(main.ID, anchor.ID, "on the main line")
	onBranch := f.seed(branch.ID, inBranch.ID, "in the branch")
	empty, _ := f.store.CreateLine(f.ctx, store.CreateLineInput{Tenant: tenant, Title: "empty"})
	bare := f.seed(empty.ID, "", "nothing to hang on")
	if onMain.AnchorLineID != main.ID || onMain.SourceLabel != "主線 #2" {
		t.Fatalf("on main = %+v", onMain)
	}
	if onBranch.AnchorLineID != branch.ID || onBranch.SourceLabel != "查證・check it" {
		t.Fatalf("on branch = %+v", onBranch)
	}
	if bare.AnchorLineID != "" || bare.SourceLabel != "" {
		t.Fatalf("bare = %+v", bare)
	}
	f.exec(`DELETE FROM tangent_message WHERE id = $1`, inBranch.ID)
	got, err := f.store.GetSeed(f.ctx, tenant, onBranch.ID)
	if err != nil || got.AnchorLineID != "" || got.SourceLabel != "查證・check it" {
		t.Fatalf("a gone anchor has no line; the label stays: %+v %v", got, err)
	}
	list, _ := f.store.ListSeeds(f.ctx, store.SeedQuery{Tenant: tenant, LineID: main.ID})
	lines := map[string]string{}
	for _, seed := range list.Seeds {
		lines[seed.ID] = seed.AnchorLineID
	}
	if lines[onMain.ID] != main.ID || lines[onBranch.ID] != "" {
		t.Fatalf("list = %+v", lines)
	}
	dropped, _ := f.store.DropSeed(f.ctx, tenant, onMain.ID)
	if dropped.AnchorLineID != main.ID || dropped.SourceLabel != "主線 #2" {
		t.Fatalf("every seed answer carries them: %+v", dropped)
	}
}

func TestJobs_LatestJobOfAKind(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	if _, ok, err := f.store.LatestJob(f.ctx, tenant, branch.ID, "leaf_draft"); err != nil || ok {
		t.Fatalf("none yet: %v %v", ok, err)
	}
	first := f.leafJob(branch.ID)
	if _, err := f.store.FinishJob(f.ctx, first.ID, store.JobFailed, "the leaf draft run failed"); err != nil {
		t.Fatal(err)
	}
	job, ok, err := f.store.LatestJob(f.ctx, tenant, branch.ID, "leaf_draft")
	if err != nil || !ok || job.ID != first.ID || job.Status != store.JobFailed || job.FinishedAt == nil {
		t.Fatalf("latest = %+v %v %v", job, ok, err)
	}
	time.Sleep(time.Millisecond)
	second := f.leafJob(branch.ID)
	if job, _, _ := f.store.LatestJob(f.ctx, tenant, branch.ID, "leaf_draft"); job.ID != second.ID || job.Status != store.JobPending {
		t.Fatalf("the newer one: %+v", job)
	}
	if _, _, err := f.store.LatestJob(f.ctx, otherTenant, branch.ID, "leaf_draft"); err == nil {
		t.Fatal("another tenant's line")
	}
	_ = domain.LeafStatusDraft
}

func TestSuggestions_TheSweepExpiresWhatADetachedLineLeftInTheOldTree(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	left := f.propose(branch.ID, "b")
	f.detach(branch.ID)
	swept, err := f.store.ExpireSuggestionsOfEndedBranches(f.ctx)
	if err != nil || len(swept) != 1 || swept[0].Suggestion.ID != left.Suggestion.ID {
		t.Fatalf("swept = %+v %v", swept, err)
	}
}

func TestSuggestions_AClosedOrMovedTargetGetsNoProposal(t *testing.T) {
	f := newFixture(t)
	main, merged := f.openBranch()
	if _, err := f.store.MergeBranch(f.ctx, store.MergeBranchInput{
		Tenant: tenant, LineID: merged.ID, Card: domain.BranchCard{Question: "q", Conclusion: "c"}, Content: "c", ParentTipMessageID: f.parentTip(main.ID),
	}); err != nil {
		t.Fatal(err)
	}
	discarded := f.branch(main.ID, f.reply(main.ID).ID)
	if _, err := f.store.DiscardBranch(f.ctx, tenant, discarded.ID); err != nil {
		t.Fatal(err)
	}
	for name, lineID := range map[string]string{"merged": merged.ID, "discarded": discarded.ID} {
		p, err := f.store.ProposeSuggestion(f.ctx, store.ProposeInput{Tenant: tenant, LineID: lineID, Feature: "probe", Kind: "probe", TargetKey: name})
		if err != nil || p.Created {
			t.Errorf("%s: %+v %v", name, p, err)
		}
	}
	detached := f.branch(main.ID, f.reply(main.ID).ID).ID
	f.detach(detached)
	if p, err := f.store.ProposeSuggestion(f.ctx, store.ProposeInput{Tenant: tenant, LineID: detached, Feature: "probe", Kind: "probe", TargetKey: "d"}); err != nil || !p.Created || p.Suggestion.RootLineID != detached {
		t.Fatalf("a detached line is a main line of its own tree now: %+v %v", p, err)
	}
}

func TestSuggestions_ConcurrentProposeAndCloseLeaveNothingOpen(t *testing.T) {
	f := newFixture(t)
	for range 8 {
		_, branch := f.openBranch()
		race(
			func() error {
				_, err := f.store.ProposeSuggestion(f.ctx, store.ProposeInput{Tenant: tenant, LineID: branch.ID, Feature: "probe", Kind: "probe", TargetKey: "t"})
				return err
			},
			func() error {
				_, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID, expireHook(f, branch.ID))
				return err
			},
		)
		if n := f.count(`SELECT count(*) FROM tangent_suggestion WHERE line_id = $1 AND status = 'open'`, branch.ID); n != 0 {
			t.Fatalf("an open suggestion about a discarded branch: %d", n)
		}
	}
}
