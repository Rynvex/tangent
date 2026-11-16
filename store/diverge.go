package store

import (
	"context"

	"github.com/Rynvex/tangent/store/db"

	"github.com/Rynvex/tangent/domain"
)

// Jobs of the diverge feature.
const (
	// JobKindDiverge proposes directions that become sibling branches.
	JobKindDiverge = "diverge"
	// JobKindConverge fills a comparison's matrix.
	JobKindConverge = "converge"
)

// DivergeInput opens sibling branches of one parent at once: each branch's
// anchor, purpose, kind and pack (built by the caller outside the lock);
// their origin is diverge.
type DivergeInput struct {
	Tenant       string
	ParentLineID string
	Branches     []CreateBranchInput
	Actor        string
}

// DivergedBranches is what a diverge opened and the job it ended (the zero
// Job for OpenDivergeBranches).
type DivergedBranches struct {
	Created      []CreatedBranch
	Job          Job
	ParentLineID string
	RootLineID   string
}

// CreateDivergeBranches ends a diverge job and opens its branches in one
// transaction under the locks root → parent → job, every branch checked as
// CreateBranch checks one (limits, anchor): all of them or none. A refusal
// leaves the job pending for the caller to fail.
func (s *Store) CreateDivergeBranches(ctx context.Context, jobID string, in DivergeInput, hooks ...TxHook) (DivergedBranches, error) {
	branches, err := s.divergeInputs(in)
	if err != nil {
		return DivergedBranches{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (DivergedBranches, error) {
		parent, err := s.lockParent(ctx, q, in.Tenant, in.ParentLineID)
		if err != nil {
			return DivergedBranches{}, err
		}
		job, err := lockJob(ctx, q, jobID)
		if err != nil {
			return DivergedBranches{}, err
		}
		done, err := finishJob(ctx, q, job.ID, JobDone, "")
		if err != nil {
			return DivergedBranches{}, err
		}
		out, err := s.openDiverged(ctx, q, parent, branches)
		out.Job = jobFromRow(done)
		return out, err
	})
}

// OpenDivergeBranches opens sibling branches of one parent at once without
// a job (a diverge across models, B14): one transaction under the locks
// root → parent, every branch checked as CreateBranch checks one, all of
// them or none. The result's Job is the zero value.
func (s *Store) OpenDivergeBranches(ctx context.Context, in DivergeInput, hooks ...TxHook) (DivergedBranches, error) {
	branches, err := s.divergeInputs(in)
	if err != nil {
		return DivergedBranches{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (DivergedBranches, error) {
		parent, err := s.lockParent(ctx, q, in.Tenant, in.ParentLineID)
		if err != nil {
			return DivergedBranches{}, err
		}
		return s.openDiverged(ctx, q, parent, branches)
	})
}

// divergeInputs checks each branch of a diverge (origin diverge).
func (s *Store) divergeInputs(in DivergeInput) ([]CreateBranchInput, error) {
	branches := make([]CreateBranchInput, 0, len(in.Branches))
	for _, b := range in.Branches {
		b.Tenant, b.ParentLineID, b.Origin, b.CreatedBy = in.Tenant, in.ParentLineID, domain.BranchOriginDiverge, in.Actor
		normalized, err := s.normalizeBranchInput(b, false)
		if err != nil {
			return nil, err
		}
		branches = append(branches, normalized)
	}
	return branches, nil
}

// openDiverged creates the branches under the locked parent, in order.
func (s *Store) openDiverged(ctx context.Context, q *db.Queries, parent lockedParent, branches []CreateBranchInput) (DivergedBranches, error) {
	out := DivergedBranches{ParentLineID: parent.line.ID.String(), RootLineID: parent.rootID.String()}
	for _, b := range branches {
		created, err := s.createInParent(ctx, q, parent, b)
		if err != nil {
			return DivergedBranches{}, err
		}
		out.Created = append(out.Created, created)
	}
	return out, nil
}
