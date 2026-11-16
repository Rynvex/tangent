package store_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

func (f *fixture) job(lineID, kind string) store.Job {
	f.t.Helper()
	job, err := f.store.CreateJob(f.ctx, store.CreateJobInput{Tenant: tenant, Kind: kind, Feature: "diverge", LineID: lineID})
	if err != nil {
		f.t.Fatal(err)
	}
	return job
}

func (f *fixture) divergeInput(parentID, anchorID string, purposes ...string) store.DivergeInput {
	in := store.DivergeInput{Tenant: tenant, ParentLineID: parentID, Actor: "chang"}
	for _, p := range purposes {
		branch := f.branchInput(parentID, anchorID)
		branch.Purpose, branch.Kind = p, domain.BranchKindAlternative
		in.Branches = append(in.Branches, branch)
	}
	return in
}

func TestDiverge_OpensTheSiblingsAndEndsTheJob(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	job := f.job(main.ID, store.JobKindDiverge)
	out, err := f.store.CreateDivergeBranches(f.ctx, job.ID, f.divergeInput(main.ID, anchor.ID, "Box", "arena", "Rc"))
	if err != nil || len(out.Created) != 3 || out.Job.Status != store.JobDone || out.RootLineID != main.ID {
		t.Fatalf("out = %+v %v", out, err)
	}
	for _, c := range out.Created {
		if c.Branch.Origin != domain.BranchOriginDiverge || c.Branch.Kind != domain.BranchKindAlternative || c.Branch.AnchorMessageID != anchor.ID || c.Branch.ParentLineID != main.ID {
			t.Fatalf("branch = %+v", c.Branch)
		}
	}
	if _, err := f.store.CreateDivergeBranches(f.ctx, job.ID, f.divergeInput(main.ID, anchor.ID, "x", "y")); domain.CodeOf(err) != domain.CodeJobNotPending {
		t.Fatalf("once: %v", err)
	}
}

func TestDiverge_IsAllOrNothing(t *testing.T) {
	f := newFixture(t)
	main, anchor := f.mainLine()
	for i := range 6 {
		branch := f.branchInput(main.ID, anchor.ID)
		branch.Purpose = fmt.Sprintf("open %d", i)
		if _, err := f.store.CreateBranch(f.ctx, branch); err != nil {
			t.Fatal(err)
		}
	}
	job := f.job(main.ID, store.JobKindDiverge)
	if _, err := f.store.CreateDivergeBranches(f.ctx, job.ID, f.divergeInput(main.ID, anchor.ID, "a", "b", "c")); domain.CodeOf(err) != domain.CodeBranchLimit {
		t.Fatalf("limit: %v", err)
	}
	if n := f.count(`SELECT count(*) FROM tangent_branch WHERE origin = 'diverge'`); n != 0 {
		t.Fatalf("%d branches of a refused diverge", n)
	}
	if again, _ := f.store.GetJob(f.ctx, job.ID); again.Status != store.JobPending {
		t.Fatalf("the refused job is the caller's to fail: %+v", again)
	}
}

// options opens two sibling branches with an exchange each.
func (f *fixture) options(n int) (domain.LineView, []string) {
	f.t.Helper()
	main, anchor := f.mainLine()
	ids := []string{}
	for range n {
		branch := f.branch(main.ID, anchor.ID)
		f.reply(branch.ID)
		ids = append(ids, branch.ID)
	}
	return main, ids
}

func (f *fixture) comparison(parentID string, ids []string) store.ComparisonWrite {
	f.t.Helper()
	out, err := f.store.CreateComparison(f.ctx, store.CreateComparisonInput{Tenant: tenant, ParentLineID: parentID, LineIDs: ids, Criteria: []string{"Speed"}, Actor: "chang", Feature: "diverge"})
	if err != nil {
		f.t.Fatal(err)
	}
	return out
}

func matrixFor(ids []string) domain.ComparisonMatrix {
	m := domain.ComparisonMatrix{Criteria: []string{"Speed"}, Scores: [][]domain.ComparisonScore{{}}, Recommendation: domain.ComparisonRecommendation{LineID: ids[0], Reason: "fast"}}
	for i, id := range ids {
		m.Options = append(m.Options, domain.ComparisonOption{LineID: id, Label: fmt.Sprintf("option %d", i)})
		m.Scores[0] = append(m.Scores[0], domain.ComparisonScore{Score: 5 - i, Why: "why"})
	}
	return m
}

func TestComparisons_CreateFinishDecide(t *testing.T) {
	f := newFixture(t)
	main, ids := f.options(3)
	written := f.comparison(main.ID, []string{ids[1], ids[0], ids[2], ids[0]})
	c := written.Comparison
	if c.Status != domain.ComparisonDrafting || c.ParentLineID != main.ID || !slices.Equal(c.LineIDs, []string{ids[1], ids[0], ids[2]}) || c.Matrix != nil ||
		written.Job == nil || written.Job.Kind != store.JobKindConverge || written.RootLineID != main.ID || !slices.Equal(c.Criteria, []string{"Speed"}) {
		t.Fatalf("written = %+v", written)
	}
	if _, err := f.store.DecideComparison(f.ctx, f.decideInput(c.ID, ids[0], ids)); domain.CodeOf(err) != domain.CodeComparisonNotReady {
		t.Fatalf("not ready: %v", err)
	}
	m := matrixFor(ids)
	ready, err := f.store.FinishComparison(f.ctx, written.Job.ID, &m, "")
	if err != nil || !ready.Written || ready.Comparison.Status != domain.ComparisonReady || ready.Comparison.Matrix.Recommendation.LineID != ids[0] {
		t.Fatalf("ready = %+v %v", ready, err)
	}
	decided, err := f.store.DecideComparison(f.ctx, f.decideInput(c.ID, ids[0], ids))
	if err != nil || decided.Comparison.Status != domain.ComparisonDecided || decided.Comparison.DecidedLineID != ids[0] || decided.Comparison.DecidedBy != "chang" ||
		decided.Chosen.Status != domain.BranchStatusOpen || decided.Decision.Kind != domain.LeafKindDecision || len(decided.Discarded) != 2 || decided.ParentLineID != main.ID {
		t.Fatalf("decided = %+v %v", decided, err)
	}
	for _, d := range decided.Discarded {
		if d.Status != domain.BranchStatusDiscarded || d.Leaf == nil || d.Leaf.Kind != domain.LeafKindDeadEnd {
			t.Fatalf("discarded = %+v", d)
		}
	}
	if _, err := f.store.DecideComparison(f.ctx, f.decideInput(c.ID, ids[1], ids)); domain.CodeOf(err) != domain.CodeComparisonDecided {
		t.Fatalf("twice: %v", err)
	}
	list, err := f.store.ListComparisons(f.ctx, tenant, main.ID)
	if err != nil || len(list.Comparisons) != 1 || list.LineID != main.ID {
		t.Fatalf("list = %+v %v", list, err)
	}
}

func (f *fixture) decideInput(id, chosen string, ids []string) store.DecideInput {
	in := store.DecideInput{Tenant: tenant, ComparisonID: id, LineID: chosen, Actor: "chang",
		Decision: domain.LeafInput{Kind: domain.LeafKindDecision, Line: "chosen"}, DeadEnds: map[string]domain.LeafInput{}}
	for _, other := range ids {
		if other != chosen {
			in.DeadEnds[other] = domain.LeafInput{Kind: domain.LeafKindDeadEnd, Line: "not chosen"}
		}
	}
	return in
}

func TestComparisons_CreateRefusals(t *testing.T) {
	f := newFixture(t)
	main, ids := f.options(2)
	other, otherIDs := f.options(1)
	_ = other
	aside := f.branchInput(main.ID, f.reply(main.ID).ID)
	aside.Kind = domain.BranchKindAside
	asideLine, err := f.store.CreateBranch(f.ctx, aside)
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string][]string{"one": {ids[0]}, "another parent": {ids[0], otherIDs[0]}, "an aside": {ids[0], asideLine.Line.ID}, "not a branch": {ids[0], main.ID}}
	for name, lineIDs := range cases {
		_, err := f.store.CreateComparison(f.ctx, store.CreateComparisonInput{Tenant: tenant, ParentLineID: main.ID, LineIDs: lineIDs, Feature: "diverge"})
		if domain.CodeOf(err) != domain.CodeInvalidComparison {
			t.Fatalf("%s: %v", name, err)
		}
	}
	f.exec(`UPDATE tangent_branch SET status = 'discarded', closed_at = now() WHERE line_id = $1`, ids[1])
	if _, err := f.store.CreateComparison(f.ctx, store.CreateComparisonInput{Tenant: tenant, ParentLineID: main.ID, LineIDs: ids, Feature: "diverge"}); domain.CodeOf(err) != domain.CodeBranchClosed {
		t.Fatalf("closed: %v", err)
	}
	if _, err := f.store.CreateComparison(f.ctx, store.CreateComparisonInput{Tenant: otherTenant, ParentLineID: main.ID, LineIDs: ids, Feature: "diverge"}); domain.CodeOf(err) != domain.CodeLineNotFound {
		t.Fatalf("another tenant: %v", err)
	}
}

func TestComparisons_DecideRefusalsRollBack(t *testing.T) {
	f := newFixture(t)
	main, ids := f.options(2)
	written := f.comparison(main.ID, ids)
	m := matrixFor(ids)
	if _, err := f.store.FinishComparison(f.ctx, written.Job.ID, &m, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.DecideComparison(f.ctx, f.decideInput(written.Comparison.ID, main.ID, ids)); domain.CodeOf(err) != domain.CodeInvalidComparison {
		t.Fatalf("not an option: %v", err)
	}
	f.busy(ids[1])
	if _, err := f.store.DecideComparison(f.ctx, f.decideInput(written.Comparison.ID, ids[0], ids)); domain.CodeOf(err) != domain.CodeBranchBusy {
		t.Fatalf("busy: %v", err)
	}
	refused := errors.New("no")
	in := f.decideInput(written.Comparison.ID, ids[1], ids)
	if _, err := f.store.DecideComparison(f.ctx, in, func(context.Context, store.Tx, any) error { return refused }); !errors.Is(err, refused) {
		t.Fatalf("a hook rolls back: %v", err)
	}
	if n := f.count(`SELECT count(*) FROM tangent_leaf`); n != 0 {
		t.Fatalf("%d leaves after a rollback", n)
	}
	if n := f.count(`SELECT count(*) FROM tangent_branch WHERE status = 'open'`); n != 2 {
		t.Fatalf("%d open branches after a rollback", n)
	}
	f.exec(`UPDATE tangent_branch SET status = 'merged', closed_at = now() WHERE line_id = $1`, ids[1])
	if _, err := f.store.DecideComparison(f.ctx, f.decideInput(written.Comparison.ID, ids[1], ids)); domain.CodeOf(err) != domain.CodeBranchClosed {
		t.Fatalf("a closed choice: %v", err)
	}
	if _, err := f.store.DecideComparison(f.ctx, f.decideInput("x", ids[0], ids)); domain.CodeOf(err) != domain.CodeComparisonNotFound {
		t.Fatalf("bad id: %v", err)
	}
}

func TestComparisons_AFailedOrTimedOutJob(t *testing.T) {
	f := newFixture(t)
	main, ids := f.options(2)
	failing := f.comparison(main.ID, ids)
	failed, err := f.store.FinishComparison(f.ctx, failing.Job.ID, nil, domain.JobUnusableText)
	if err != nil || failed.Comparison.Status != domain.ComparisonFailed || failed.Job.Status != store.JobFailed {
		t.Fatalf("failed = %+v %v", failed, err)
	}
	timed := f.comparison(main.ID, ids)
	stale, err := f.store.FailComparisonOfJob(f.ctx, timed.Job.ID)
	if err != nil || stale == nil || stale.Comparison.Status != domain.ComparisonFailed || stale.RootLineID != main.ID {
		t.Fatalf("stale = %+v %v", stale, err)
	}
	if none, err := f.store.FailComparisonOfJob(f.ctx, timed.Job.ID); err != nil || none != nil {
		t.Fatalf("nothing waits: %+v %v", none, err)
	}
	if got, err := f.store.GetComparison(f.ctx, otherTenant, timed.Comparison.ID); domain.CodeOf(err) != domain.CodeComparisonNotFound {
		t.Fatalf("another tenant: %+v %v", got, err)
	}
}

func TestP3bConcurrency_OneDecisionWins(t *testing.T) {
	f := newFixture(t)
	for round := range 5 {
		main, ids := f.options(2)
		written := f.comparison(main.ID, ids)
		m := matrixFor(ids)
		if _, err := f.store.FinishComparison(f.ctx, written.Job.ID, &m, ""); err != nil {
			t.Fatal(err)
		}
		errs := race(
			func() error {
				_, err := f.store.DecideComparison(f.ctx, f.decideInput(written.Comparison.ID, ids[0], ids))
				return err
			},
			func() error {
				_, err := f.store.DecideComparison(f.ctx, f.decideInput(written.Comparison.ID, ids[1], ids))
				return err
			},
		)
		won := 0
		for _, err := range errs {
			switch domain.CodeOf(err) {
			case "":
				if err != nil {
					t.Fatalf("round %d: %v", round, err)
				}
				won++
			case domain.CodeComparisonDecided, domain.CodeBranchClosed:
			default:
				t.Fatalf("round %d: %v", round, err)
			}
		}
		if won != 1 || f.count(`SELECT count(*) FROM tangent_branch WHERE status = 'open' AND parent_line_id = $1`, main.ID) != 1 {
			t.Fatalf("round %d: %d decisions won", round, won)
		}
	}
}
