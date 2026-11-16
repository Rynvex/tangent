package store_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestJobs_Lifecycle(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	job, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "leaf", Feature: "leaf", LineID: line.ID, Input: json.RawMessage(`{"uptoSeq":4}`)})
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != store.JobPending || job.Feature != "leaf" || job.LineID != line.ID || job.TenantID != tenant || string(job.Input) != `{"uptoSeq": 4}` {
		t.Fatalf("job = %+v", job)
	}
	if pending, ok, err := f.store.PendingJob(f.ctx, tenant, line.ID, "leaf"); err != nil || !ok || pending.ID != job.ID {
		t.Fatalf("pending job = %+v ok=%v err=%v", pending, ok, err)
	}
	failed, err := f.store.FinishJob(f.ctx, job.ID, store.JobFailed, "runner down")
	if err != nil || failed.Status != store.JobFailed || failed.Error != "runner down" || failed.FinishedAt == nil {
		t.Fatalf("finish = %+v err=%v", failed, err)
	}
	if _, err := f.store.FinishJob(f.ctx, job.ID, store.JobDone, ""); !errors.Is(err, domain.ErrJobNotPending) {
		t.Fatalf("finishing twice = %v", err)
	}
	if _, ok, _ := f.store.PendingJob(f.ctx, tenant, line.ID, "leaf"); ok {
		t.Fatal("a finished job is not pending")
	}
	if _, err := f.store.FinishJob(f.ctx, "00000000-0000-4000-8000-000000000000", store.JobDone, ""); !errors.Is(err, domain.ErrJobNotFound) {
		t.Fatalf("unknown job = %v", err)
	}
	other, _ := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "leaf"})
	if _, err := f.store.FinishJob(f.ctx, other.ID, store.JobSuperseded, ""); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("finishing as superseded = %v", err)
	}
	if other.Feature != "core" || other.LineID != "" {
		t.Fatalf("defaults = %+v", other)
	}
	if _, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: otherTenant, Kind: "leaf", LineID: line.ID}); !errors.Is(err, domain.ErrLineNotFound) {
		t.Fatalf("a job on another tenant's line = %v", err)
	}
	if _, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("a job without a kind = %v", err)
	}
}

func TestJobs_SupersedeReplacesThePendingJobOfTheSameKind(t *testing.T) {
	f := newFixture(t)
	line, _ := f.mainLine()
	first, _ := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "summary", LineID: line.ID})
	second, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "summary", LineID: line.ID, Supersede: true})
	if err != nil {
		t.Fatal(err)
	}
	if old, _ := f.store.GetJob(f.ctx, first.ID); old.Status != store.JobSuperseded {
		t.Fatalf("old job = %+v", old)
	}
	if _, err := f.store.FinishJob(f.ctx, first.ID, store.JobDone, ""); !errors.Is(err, domain.ErrJobNotPending) {
		t.Fatalf("a superseded job cannot finish: %v", err)
	}
	if pending, ok, _ := f.store.PendingJob(f.ctx, tenant, line.ID, "summary"); !ok || pending.ID != second.ID {
		t.Fatalf("pending = %+v", pending)
	}
}

func TestDraft_ClaimBlocksTurnsAndFinishStoresTheOutcome(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	claim, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if claim.Job.Kind != store.JobKindCardDraft || claim.Job.Status != store.JobPending || claim.Branch.DraftStatus != domain.BranchDraftDrafting ||
		claim.ParentTipMessageID != f.parentTip(parent.ID) || claim.UptoSeq == 0 {
		t.Fatalf("claim = %+v", claim)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: branch.ID, Content: "x"}); !errors.Is(err, domain.ErrBranchDrafting) {
		t.Fatalf("a turn while drafting = %v", err)
	}
	if _, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID); !errors.Is(err, domain.ErrBranchDrafting) {
		t.Fatalf("a second claim = %v", err)
	}
	card := domain.BranchCard{Question: "q", Conclusion: "c"}
	view, err := f.store.FinishBranchDraft(f.ctx, claim.Job.ID, domain.BranchDraftOutcome{Status: domain.BranchDraftReady, Card: &card, Provider: "anthropic", Model: "haiku"})
	if err != nil || view.DraftStatus != domain.BranchDraftReady {
		t.Fatalf("finish = %+v err=%v", view, err)
	}
	draft, err := f.store.GetBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil || draft.Status != domain.BranchDraftReady || draft.Card == nil || draft.Card.Conclusion != "c" || draft.Model != "haiku" ||
		draft.UptoSeq != claim.UptoSeq || draft.ParentTipMessageID != claim.ParentTipMessageID || draft.StartedAt == nil || draft.Warnings == nil {
		t.Fatalf("draft = %+v err=%v", draft, err)
	}
	if job, _ := f.store.GetJob(f.ctx, claim.Job.ID); job.Status != store.JobDone {
		t.Fatalf("job = %+v", job)
	}
	if _, err := f.store.BeginTurn(f.ctx, store.BeginTurnInput{Tenant: tenant, LineID: branch.ID, Content: "x"}); err != nil {
		t.Fatalf("a turn after the draft = %v", err)
	}
}

func TestDraft_AFailedDraftStoresOnlyTheFixedReason(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	claim, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.FinishBranchDraft(f.ctx, claim.Job.ID, domain.DraftFailed(domain.DraftUnusableText)); err != nil {
		t.Fatal(err)
	}
	draft, _ := f.store.GetBranchDraft(f.ctx, tenant, branch.ID)
	if draft.Status != domain.BranchDraftFailed || draft.Error != domain.DraftUnusableText || draft.Card != nil || !draft.ManualCardAvailable {
		t.Fatalf("draft = %+v", draft)
	}
	if job, _ := f.store.GetJob(f.ctx, claim.Job.ID); job.Status != store.JobFailed || job.Error != domain.DraftUnusableText {
		t.Fatalf("job = %+v", job)
	}
}

func TestDraft_OnlyTheCurrentJobCanFinishIt(t *testing.T) {
	clock := &fakeClock{now: time.Now()}
	f := newFixture(t, store.WithClock(clock.Now))
	_, branch := f.openBranch()
	first, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The first draft times out; a new claim supersedes its job.
	clock.now = clock.now.Add(domain.DefaultLimits().Branch.DraftTimeout + time.Second)
	if view := f.branchView(branch.ID); view.DraftStatus != domain.BranchDraftFailed {
		t.Fatalf("a timed-out draft reads as failed: %+v", view)
	}
	if draft, _ := f.store.GetBranchDraft(f.ctx, tenant, branch.ID); draft.Error != domain.DraftTimeoutText {
		t.Fatalf("timed-out draft = %+v", draft)
	}
	second, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil {
		t.Fatalf("a new claim after the timeout = %v", err)
	}
	card := domain.BranchCard{Question: "q", Conclusion: "late"}
	if _, err := f.store.FinishBranchDraft(f.ctx, first.Job.ID, domain.BranchDraftOutcome{Status: domain.BranchDraftReady, Card: &card}); !errors.Is(err, domain.ErrDraftNotPending) {
		t.Fatalf("the superseded job's result = %v", err)
	}
	if job, _ := f.store.GetJob(f.ctx, first.Job.ID); job.Status != store.JobSuperseded {
		t.Fatalf("first job = %+v", job)
	}
	if draft, _ := f.store.GetBranchDraft(f.ctx, tenant, branch.ID); draft.Status != domain.BranchDraftDrafting {
		t.Fatalf("the current draft must be untouched: %+v", draft)
	}

	// The second draft times out too, and its late report is ignored.
	clock.now = clock.now.Add(domain.DefaultLimits().Branch.DraftTimeout + time.Second)
	if _, err := f.store.FinishBranchDraft(f.ctx, second.Job.ID, domain.BranchDraftOutcome{Status: domain.BranchDraftReady, Card: &card}); !errors.Is(err, domain.ErrDraftNotPending) {
		t.Fatalf("a late report = %v", err)
	}
	if job, _ := f.store.GetJob(f.ctx, second.Job.ID); job.Status != store.JobFailed || job.Error != domain.DraftTimeoutText {
		t.Fatalf("second job = %+v", job)
	}
	if draft, _ := f.store.GetBranchDraft(f.ctx, tenant, branch.ID); draft.Status != domain.BranchDraftFailed || draft.Card != nil {
		t.Fatalf("draft = %+v", draft)
	}
}

func TestDraft_AResultForAClosedBranchIsIgnored(t *testing.T) {
	f := newFixture(t)
	parent, branch := f.openBranch()
	claim, err := f.store.ClaimBranchDraft(f.ctx, tenant, branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Writing the card by hand while the draft runs still ends the branch.
	in := f.mergeInput(branch.ID, f.parentTip(parent.ID))
	if _, err := f.store.MergeBranch(f.ctx, in); err != nil {
		t.Fatal(err)
	}
	card := domain.BranchCard{Question: "q", Conclusion: "c"}
	if _, err := f.store.FinishBranchDraft(f.ctx, claim.Job.ID, domain.BranchDraftOutcome{Status: domain.BranchDraftReady, Card: &card}); !errors.Is(err, domain.ErrDraftNotPending) {
		t.Fatalf("a draft for a merged branch = %v", err)
	}
	if job, _ := f.store.GetJob(f.ctx, claim.Job.ID); job.Status != store.JobSuperseded {
		t.Fatalf("job = %+v", job)
	}
}

func TestDraft_Refusals(t *testing.T) {
	f := newFixture(t)
	root, anchor := f.mainLine()
	empty := f.branch(root.ID, anchor.ID)
	if _, err := f.store.ClaimBranchDraft(f.ctx, tenant, empty.ID); !errors.Is(err, domain.ErrBranchNoMessages) {
		t.Fatalf("an empty branch = %v", err)
	}
	if _, err := f.store.ClaimBranchDraft(f.ctx, tenant, root.ID); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("a main line = %v", err)
	}
	f.busy(empty.ID)
	if _, err := f.store.ClaimBranchDraft(f.ctx, tenant, empty.ID); !errors.Is(err, domain.ErrBranchBusy) && !errors.Is(err, domain.ErrTurnPending) {
		t.Fatalf("a branch with a turn in flight = %v", err)
	}
	if _, err := f.store.FinishBranchDraft(f.ctx, "00000000-0000-4000-8000-000000000000", domain.DraftFailed("x")); !errors.Is(err, domain.ErrJobNotFound) {
		t.Fatalf("unknown job = %v", err)
	}
	other, _ := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "summary", LineID: root.ID})
	if _, err := f.store.FinishBranchDraft(f.ctx, other.ID, domain.DraftFailed("x")); !errors.Is(err, domain.ErrDraftNotPending) {
		t.Fatalf("a job of another kind = %v", err)
	}
}
