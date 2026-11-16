package store

import (
	"context"
	"fmt"
	"slices"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// DecideInput chooses one branch of a ready comparison: Decision is its
// leaf; DeadEnds holds the leaf of each other compared branch.
type DecideInput struct {
	Tenant       string
	ComparisonID string
	LineID       string
	Decision     domain.LeafInput
	DeadEnds     map[string]domain.LeafInput
	Actor        string
}

// DecidedComparison is what a decision changed: the comparison, the chosen
// branch and its decision leaf, and the branches it ended (discarded, each
// with its dead-end leaf).
type DecidedComparison struct {
	Comparison   domain.Comparison
	Chosen       domain.BranchView
	Decision     domain.Leaf
	Discarded    []domain.BranchView
	DeadEnds     []domain.Leaf
	ParentLineID string
	RootLineID   string
}

// DecideComparison decides a comparison in one transaction under the locks
// root → parent → the compared branches in id order → the comparison: the
// chosen branch (open) gets its decision leaf and stays open; every other
// compared branch still open under the parent is discarded with its
// dead-end leaf (one that ended meanwhile, or left the parent, is left as
// it is). Refusals: comparison_not_found, comparison_decided,
// comparison_not_ready (drafting or failed), a choice that is not an option
// (invalid_comparison), a closed choice (branch_closed), a branch answering
// (branch_busy) or drafting, archived.
func (s *Store) DecideComparison(ctx context.Context, in DecideInput, hooks ...TxHook) (DecidedComparison, error) {
	if err := s.checkDecisionLeaves(in); err != nil {
		return DecidedComparison{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (DecidedComparison, error) {
		peek, err := comparisonOfTenant(ctx, q, in.Tenant, in.ComparisonID)
		if err != nil {
			return DecidedComparison{}, err
		}
		parent, err := s.lockParent(ctx, q, in.Tenant, peek.ParentLineID.String())
		if err != nil {
			return DecidedComparison{}, err
		}
		if parent.line.ArchivedAt.Valid {
			return DecidedComparison{}, domain.ErrLineArchived
		}
		if err := lockInOrder(ctx, q, peek.LineIds); err != nil {
			return DecidedComparison{}, err
		}
		row, chosen, err := lockDecidable(ctx, q, peek.ID, in.LineID)
		if err != nil {
			return DecidedComparison{}, err
		}
		return s.decide(ctx, q, parent, row, chosen, in)
	})
}

// checkDecisionLeaves refuses leaves that would not be stored.
func (s *Store) checkDecisionLeaves(in DecideInput) error {
	if _, problems := domain.NormalizeLeaf(in.Decision, s.limits.Leaf); len(problems) > 0 {
		return domain.LeafError(problems)
	}
	for _, leaf := range in.DeadEnds {
		if _, problems := domain.NormalizeLeaf(leaf, s.limits.Leaf); len(problems) > 0 {
			return domain.LeafError(problems)
		}
	}
	return nil
}

// lockDecidable locks a ready comparison and checks the choice is one of
// its options.
func lockDecidable(ctx context.Context, q *db.Queries, id uuid.UUID, lineID string) (db.TangentComparison, uuid.UUID, error) {
	row, err := q.GetComparisonForUpdate(ctx, id)
	if err != nil {
		return db.TangentComparison{}, uuid.UUID{}, lookup(err, domain.ErrComparisonNotFound, "lock comparison")
	}
	switch row.Status {
	case domain.ComparisonDecided:
		return db.TangentComparison{}, uuid.UUID{}, domain.ErrComparisonDecided
	case domain.ComparisonReady:
	default:
		return db.TangentComparison{}, uuid.UUID{}, domain.ErrComparisonNotReady
	}
	chosen, ok := parseID(lineID)
	if !ok || !slices.Contains(row.LineIds, chosen) {
		return db.TangentComparison{}, uuid.UUID{}, domain.InvalidComparison("the chosen branch is not one of the compared ones")
	}
	return row, chosen, nil
}

func (s *Store) decide(ctx context.Context, q *db.Queries, parent lockedParent, row db.TangentComparison, chosen uuid.UUID, in DecideInput) (DecidedComparison, error) {
	chosenRow, isBranch, err := branchRowFor(ctx, q, chosen)
	switch {
	case err != nil:
		return DecidedComparison{}, err
	case !isBranch || chosenRow.ParentLineID != parent.line.ID:
		return DecidedComparison{}, domain.InvalidComparison("the chosen branch no longer hangs on this line")
	case chosenRow.Status != domain.BranchStatusOpen:
		return DecidedComparison{}, domain.ErrBranchClosed
	}
	out := DecidedComparison{ParentLineID: parent.line.ID.String(), RootLineID: parent.rootID.String(), Discarded: []domain.BranchView{}, DeadEnds: []domain.Leaf{}}
	ended, err := s.endOthers(ctx, q, parent, row.LineIds, chosen, in, &out)
	if err != nil {
		return DecidedComparison{}, err
	}
	leaf, _ := domain.NormalizeLeaf(in.Decision, s.limits.Leaf)
	if out.Decision, err = upsertLeaf(ctx, q, chosenRow, leaf, domain.LeafStatusConfirmed, uuid.NullUUID{}, in.Actor); err != nil {
		return DecidedComparison{}, err
	}
	decided, err := q.DecideComparison(ctx, db.DecideComparisonParams{ID: row.ID, DecidedLineID: uuid.NullUUID{UUID: chosen, Valid: true}, DecidedBy: in.Actor})
	if err != nil {
		return DecidedComparison{}, fmt.Errorf("decide the comparison: %w", err)
	}
	return s.decidedViews(ctx, q, decided, chosen, ended, out)
}

// endOthers discards the other compared branches still open under the
// parent and writes their dead-end leaves; it returns their ids.
func (s *Store) endOthers(ctx context.Context, q *db.Queries, parent lockedParent, ids []uuid.UUID, chosen uuid.UUID, in DecideInput, out *DecidedComparison) ([]uuid.UUID, error) {
	ended := []uuid.UUID{}
	for _, id := range ids {
		if id == chosen {
			continue
		}
		row, isBranch, err := branchRowFor(ctx, q, id)
		if err != nil {
			return nil, err
		}
		if !isBranch || row.ParentLineID != parent.line.ID || row.Status != domain.BranchStatusOpen {
			continue
		}
		if s.draftStatus(row) == domain.BranchDraftDrafting {
			return nil, domain.ErrBranchDrafting
		}
		if err := requireNoPendingTurn(ctx, q, id, domain.ErrBranchBusy); err != nil {
			return nil, err
		}
		if _, err := q.CloseBranch(ctx, db.CloseBranchParams{LineID: id, Status: domain.BranchStatusDiscarded}); err != nil {
			return nil, fmt.Errorf("discard a branch that was not chosen: %w", err)
		}
		leaf, _ := domain.NormalizeLeaf(in.DeadEnds[id.String()], s.limits.Leaf)
		written, err := upsertLeaf(ctx, q, row, leaf, domain.LeafStatusConfirmed, uuid.NullUUID{}, in.Actor)
		if err != nil {
			return nil, err
		}
		out.DeadEnds = append(out.DeadEnds, written)
		ended = append(ended, id)
	}
	return ended, nil
}

// decidedViews reads the views a decision returns, in its transaction.
func (s *Store) decidedViews(ctx context.Context, q *db.Queries, row db.TangentComparison, chosen uuid.UUID, ended []uuid.UUID, out DecidedComparison) (DecidedComparison, error) {
	write, err := comparisonWrite(ctx, q, row)
	if err != nil {
		return DecidedComparison{}, err
	}
	out.Comparison = write.Comparison
	if out.Chosen, err = s.branchViewOf(ctx, q, row.TenantID, chosen); err != nil {
		return DecidedComparison{}, err
	}
	for _, id := range ended {
		view, err := s.branchViewOf(ctx, q, row.TenantID, id)
		if err != nil {
			return DecidedComparison{}, err
		}
		out.Discarded = append(out.Discarded, view)
	}
	return out, nil
}
