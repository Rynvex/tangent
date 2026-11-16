package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// DeletedBranch is what deleting one ended branch removed: the branch
// (LineID, hanging on ParentLineID in the tree of RootLineID, which stays)
// with every line below it, and what went or changed with them (LinesGone).
type DeletedBranch struct {
	LineID       string
	ParentLineID string
	RootLineID   string
	LinesGone
}

// DeleteBranch removes one ended branch with everything below it (B23),
// under the locks root → the branch → the lines below it in id order. Only
// an ended aside or a discarded branch goes (domain.BranchDeletable); the
// rest of the tree stays, the markers that name the branch on its parent
// included. Refusals: an unknown line, a main line
// (ErrDeleteBranchIsMainLine), archived, not deletable, an open branch
// below it (ErrBranchSubtreeOpen) or a line of the subtree answering
// (ErrBranchBusy). The hooks run before the lines are deleted, so they can
// still read them (as DeleteTree's do).
func (s *Store) DeleteBranch(ctx context.Context, tenant, lineID string, hooks ...TxHook) (DeletedBranch, error) {
	return runTxWith(ctx, s, func(q *db.Queries, tx pgx.Tx) (DeletedBranch, error) {
		row, ids, err := s.lockDeletableBranch(ctx, q, tenant, lineID)
		if err != nil {
			return DeletedBranch{}, err
		}
		out := DeletedBranch{LineID: row.LineID.String(), ParentLineID: row.ParentLineID.String(), RootLineID: row.RootLineID.String()}
		if out.LinesGone, err = s.releaseLines(ctx, q, row.RootLineID, ids); err != nil {
			return DeletedBranch{}, err
		}
		if err := runHooks(ctx, tx, hooks, out); err != nil {
			return DeletedBranch{}, err
		}
		if err := q.DeleteLines(ctx, db.DeleteLinesParams{TenantID: tenant, LineIds: ids}); err != nil {
			return DeletedBranch{}, fmt.Errorf("delete branch: %w", err)
		}
		return out, nil
	})
}

// lockDeletableBranch locks root → the branch → its subtree, applies the
// refusals and returns the branch row with the ids to delete, the branch
// first.
func (s *Store) lockDeletableBranch(ctx context.Context, q *db.Queries, tenant, lineID string) (db.TangentBranch, []uuid.UUID, error) {
	row, line, err := s.lockBranchUnderRoot(ctx, q, tenant, lineID)
	if err != nil {
		return db.TangentBranch{}, nil, err
	}
	switch {
	case line.ArchivedAt.Valid:
		return db.TangentBranch{}, nil, domain.ErrLineArchived
	case !domain.BranchDeletable(row.Kind, row.Status, row.Origin, idString(row.MergedIntoLineID)):
		return db.TangentBranch{}, nil, domain.ErrBranchNotDeletable
	}
	below, err := s.subtreeIDs(ctx, q, line.ID)
	if err != nil {
		return db.TangentBranch{}, nil, err
	}
	ids, err := lockLines(ctx, q, line.ID, below)
	if errors.Is(err, domain.ErrDeleteBusy) {
		return db.TangentBranch{}, nil, domain.ErrBranchBusy
	}
	if err != nil {
		return db.TangentBranch{}, nil, err
	}
	if len(below) > 0 {
		subtree, err := q.ListBranchesByLineIDs(ctx, below)
		if err != nil {
			return db.TangentBranch{}, nil, fmt.Errorf("list subtree branches: %w", err)
		}
		for _, sub := range subtree {
			if sub.Status == domain.BranchStatusOpen {
				return db.TangentBranch{}, nil, domain.ErrBranchSubtreeOpen
			}
		}
	}
	return row, ids, nil
}

// lockBranchUnderRoot locks the main line of a branch's tree and then the
// branch line, and returns the branch row as it is under the locks. A line
// of another tenant is ErrLineNotFound, a main line
// ErrDeleteBranchIsMainLine; a branch that changed trees between the peek
// and the locks (a detach, an attach) is retried.
func (s *Store) lockBranchUnderRoot(ctx context.Context, q *db.Queries, tenant, lineID string) (db.TangentBranch, db.TangentLine, error) {
	peek, err := s.lineRow(ctx, q, tenant, lineID)
	if err != nil {
		return db.TangentBranch{}, db.TangentLine{}, err
	}
	before, isBranch, err := branchRowFor(ctx, q, peek.ID)
	if err != nil {
		return db.TangentBranch{}, db.TangentLine{}, err
	}
	if !isBranch {
		return db.TangentBranch{}, db.TangentLine{}, domain.ErrDeleteBranchIsMainLine
	}
	if _, err := lockLineByID(ctx, q, before.RootLineID); err != nil {
		return db.TangentBranch{}, db.TangentLine{}, err
	}
	line, err := lockLineByID(ctx, q, peek.ID)
	if err != nil {
		return db.TangentBranch{}, db.TangentLine{}, err
	}
	row, isBranch, err := branchRowFor(ctx, q, peek.ID)
	if err != nil {
		return db.TangentBranch{}, db.TangentLine{}, err
	}
	if !isBranch || row.RootLineID != before.RootLineID {
		return db.TangentBranch{}, db.TangentLine{}, errBranchMoved
	}
	return row, line, nil
}
