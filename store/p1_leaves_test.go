package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func TestLeaves_PutGetDeleteAndTheOutline(t *testing.T) {
	f := newFixture(t)
	main, branch := f.openBranch()
	if leaf, err := f.store.GetLeaf(f.ctx, tenant, branch.ID); err != nil || leaf != nil {
		t.Fatalf("no leaf yet: %+v %v", leaf, err)
	}
	put, err := f.store.PutLeaf(f.ctx, store.PutLeafInput{Tenant: tenant, LineID: branch.ID, Actor: "chang",
		Leaf: domain.LeafInput{Kind: "to_continue", Line: " pick up \n the prices ", Body: "later"}})
	if err != nil || put.Line != "pick up the prices" || put.Status != domain.LeafStatusConfirmed || put.AIDrafted ||
		put.RootLineID != main.ID || put.CreatedBy != "chang" {
		t.Fatalf("put = %+v %v", put, err)
	}
	got, err := f.store.GetLeaf(f.ctx, tenant, branch.ID)
	if err != nil || got == nil || got.Kind != domain.LeafKindToContinue || got.Body != "later" {
		t.Fatalf("get = %+v %v", got, err)
	}
	view := f.branchView(branch.ID)
	if view.Leaf == nil || *view.Leaf != (domain.LeafSummary{Kind: "to_continue", Line: "pick up the prices", Status: "confirmed"}) {
		t.Fatalf("outline leaf = %+v", view.Leaf)
	}
	outline, err := f.store.ListBranches(f.ctx, tenant, main.ID, true)
	if err != nil || len(outline) != 1 || outline[0].Leaf == nil {
		t.Fatalf("outline = %+v %v", outline, err)
	}
	deleted, err := f.store.DeleteLeaf(f.ctx, tenant, branch.ID)
	if err != nil || deleted.Line != put.Line || f.branchView(branch.ID).Leaf != nil {
		t.Fatalf("deleted = %+v %v", deleted, err)
	}
	if _, err := f.store.DeleteLeaf(f.ctx, tenant, branch.ID); !errors.Is(err, domain.ErrLeafNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
}

func TestLeaves_Refusals(t *testing.T) {
	f := newFixture(t)
	main, branch := f.openBranch()
	if _, err := f.store.GetLeaf(f.ctx, tenant, main.ID); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("a main line has no leaf: %v", err)
	}
	if _, err := f.store.GetLeaf(f.ctx, otherTenant, branch.ID); !errors.Is(err, domain.ErrBranchNotFound) {
		t.Fatalf("another tenant: %v", err)
	}
	bad := store.PutLeafInput{Tenant: tenant, LineID: branch.ID, Leaf: domain.LeafInput{Kind: "nope", Line: strings.Repeat("x", 201)}}
	if _, err := f.store.PutLeaf(f.ctx, bad); domain.CodeOf(err) != domain.CodeInvalidLeaf {
		t.Fatalf("invalid leaf: %v", err)
	}
	ok := store.PutLeafInput{Tenant: tenant, LineID: branch.ID, Leaf: domain.LeafInput{Kind: "answer", Line: "x"}}
	if _, err := f.store.PutLeaf(f.ctx, ok, failingHook(errors.New("no"))); err == nil {
		t.Fatal("the hook refused")
	}
	if leaf, _ := f.store.GetLeaf(f.ctx, tenant, branch.ID); leaf != nil {
		t.Fatalf("rolled back: %+v", leaf)
	}
	if _, err := f.store.ArchiveTree(f.ctx, tenant, main.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.PutLeaf(f.ctx, ok); !errors.Is(err, domain.ErrLineArchived) {
		t.Fatalf("an archived conversation: %v", err)
	}
}

func TestLeaves_WriteInsideAMergeAndDraftsYieldToTheOperator(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	write := func(ctx context.Context, tx store.Tx, _ any) error {
		_, err := f.store.WriteLeaf(ctx, tx, store.LeafWrite{LineID: branch.ID, Leaf: domain.LeafInput{Kind: "dead_end", Line: "too pricey"}, Status: domain.LeafStatusConfirmed, Actor: "chang"})
		return err
	}
	if _, err := f.store.DiscardBranch(f.ctx, tenant, branch.ID, write); err != nil {
		t.Fatal(err)
	}
	if leaf, _ := f.store.GetLeaf(f.ctx, tenant, branch.ID); leaf == nil || leaf.Kind != domain.LeafKindDeadEnd || leaf.AIDrafted {
		t.Fatalf("written with the discard: %+v", leaf)
	}
	job := f.leafJob(branch.ID)
	result, err := f.store.FinishLeafDraft(f.ctx, job.ID, domain.LeafInput{Kind: "answer", Line: "ai says"}, domain.LeafStatusDraft)
	if err != nil || result.Written || result.Job.Status != store.JobDone {
		t.Fatalf("a draft never replaces the operator's leaf: %+v %v", result, err)
	}
	if leaf, _ := f.store.GetLeaf(f.ctx, tenant, branch.ID); leaf.Line != "too pricey" {
		t.Fatalf("kept: %+v", leaf)
	}
	if _, err := f.store.FinishLeafDraft(f.ctx, job.ID, domain.LeafInput{Kind: "answer", Line: "x"}, domain.LeafStatusDraft); !errors.Is(err, domain.ErrJobNotPending) {
		t.Fatalf("finished twice: %v", err)
	}
}

func TestLeaves_ADraftReplacesAnEarlierDraftOnly(t *testing.T) {
	f := newFixture(t)
	_, branch := f.openBranch()
	first := f.leafJob(branch.ID)
	result, err := f.store.FinishLeafDraft(f.ctx, first.ID, domain.LeafInput{Kind: "answer", Line: "first draft"}, domain.LeafStatusDraft)
	if err != nil || !result.Written || !result.Leaf.AIDrafted || result.Leaf.Status != domain.LeafStatusDraft {
		t.Fatalf("first = %+v %v", result, err)
	}
	second := f.leafJob(branch.ID)
	result, err = f.store.FinishLeafDraft(f.ctx, second.ID, domain.LeafInput{Kind: "decision", Line: "second draft"}, domain.LeafStatusConfirmed)
	if err != nil || !result.Written || result.Leaf.Line != "second draft" || result.Leaf.Status != domain.LeafStatusConfirmed || !result.Leaf.AIDrafted {
		t.Fatalf("an AI leaf is replaced by a newer draft: %+v %v", result, err)
	}
	if _, err := f.store.PutLeaf(f.ctx, store.PutLeafInput{Tenant: tenant, LineID: branch.ID, Leaf: domain.LeafInput{Kind: "decision", Line: "mine"}}); err != nil {
		t.Fatal(err)
	}
	if leaf, _ := f.store.GetLeaf(f.ctx, tenant, branch.ID); leaf.AIDrafted {
		t.Fatalf("the operator's edit is theirs: %+v", leaf)
	}
	third := f.leafJob(branch.ID)
	if result, err = f.store.FinishLeafDraft(f.ctx, third.ID, domain.LeafInput{Kind: "answer", Line: "third"}, domain.LeafStatusDraft); err != nil || result.Written {
		t.Fatalf("not over the operator's: %+v %v", result, err)
	}
	if _, err := f.store.FinishLeafDraft(f.ctx, third.ID, domain.LeafInput{Kind: "nope"}, domain.LeafStatusDraft); err == nil {
		t.Fatal("a finished job")
	}
	invalid := f.leafJob(branch.ID)
	if _, err := f.store.FinishLeafDraft(f.ctx, invalid.ID, domain.LeafInput{Kind: "nope", Line: "x"}, domain.LeafStatusDraft); domain.CodeOf(err) != domain.CodeInvalidLeaf {
		t.Fatalf("an invalid draft: %v", err)
	}
}

func (f *fixture) leafJob(lineID string) store.Job {
	f.t.Helper()
	job, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: "leaf_draft", Feature: "leaf", LineID: lineID, Supersede: true})
	if err != nil {
		f.t.Fatal(err)
	}
	return job
}
