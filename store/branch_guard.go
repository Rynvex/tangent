package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// branchRowFor loads the branch row of a line; ok is false for a main line.
func branchRowFor(ctx context.Context, q *db.Queries, lineID uuid.UUID) (db.TangentBranch, bool, error) {
	row, err := q.GetBranch(ctx, lineID)
	if noRows(err) {
		return db.TangentBranch{}, false, nil
	}
	if err != nil {
		return db.TangentBranch{}, false, fmt.Errorf("get branch: %w", err)
	}
	return row, true, nil
}

// rootOf returns the main line of a line's tree.
func rootOf(ctx context.Context, q *db.Queries, lineID uuid.UUID) (uuid.UUID, error) {
	row, isBranch, err := branchRowFor(ctx, q, lineID)
	if err != nil {
		return uuid.UUID{}, err
	}
	if isBranch {
		return row.RootLineID, nil
	}
	return lineID, nil
}

// lockRootOf locks the main line of a line's tree and checks, under the
// lock, that the line is still in that tree: a detach or an attach (B20) may
// have moved it between reading its root and locking it, and then the lock
// held is the wrong one (errBranchMoved: the transaction is retried).
func lockRootOf(ctx context.Context, q *db.Queries, lineID uuid.UUID) (db.TangentLine, error) {
	rootID, err := rootOf(ctx, q, lineID)
	if err != nil {
		return db.TangentLine{}, err
	}
	root, err := lockLineByID(ctx, q, rootID)
	if err != nil {
		return db.TangentLine{}, err
	}
	again, err := rootOf(ctx, q, lineID)
	if err != nil {
		return db.TangentLine{}, err
	}
	if again != rootID {
		return db.TangentLine{}, errBranchMoved
	}
	return root, nil
}

// lockOpenRoot reads a line of the tenant, locks the main line of its tree
// (lockRootOf) and refuses an archived conversation. It is the guard of the
// tree-level writes that only need the main line (notes, chapters, the goal,
// groups).
func (s *Store) lockOpenRoot(ctx context.Context, q *db.Queries, tenant, lineID string) (db.TangentLine, error) {
	line, err := s.lineRow(ctx, q, tenant, lineID)
	if err != nil {
		return db.TangentLine{}, err
	}
	return lockOpenRootOf(ctx, q, line.ID)
}

// lockOpenRootOf locks the main line of a line's tree and refuses an
// archived conversation. The caller has already checked the tenant (it read
// the line, the seed, the term or the group of the tenant).
func lockOpenRootOf(ctx context.Context, q *db.Queries, lineID uuid.UUID) (db.TangentLine, error) {
	// B13 review, B20: a detach or an attach may move the line to another tree
	// between reading its root and locking it (retried).
	root, err := lockRootOf(ctx, q, lineID)
	if err != nil {
		return db.TangentLine{}, err
	}
	if root.ArchivedAt.Valid {
		return db.TangentLine{}, domain.ErrLineArchived
	}
	return root, nil
}

// requireBranchAcceptsTurn refuses a turn (or a draft) on an archived line,
// in a branch that has ended or hangs below one that has, in an aside that
// was already answered, or in a branch that is drafting. The caller holds
// the line's row lock.
//
// The ancestors' branch rows are read without a lock. That is benign: a
// branch only ever goes from open to ended, and every write that ends one
// (merge, discard, promote) also refuses while the branch has a turn in
// flight, so a turn that slips past an ancestor ending concurrently is the
// same as a turn that started just before it.
func (s *Store) requireBranchAcceptsTurn(ctx context.Context, q *db.Queries, line db.TangentLine) error {
	row, isBranch, err := s.requireWritable(ctx, q, line)
	if err != nil || !isBranch {
		return err
	}
	if row.Kind == domain.BranchKindAside {
		answered, err := q.CountDoneAssistantReplies(ctx, line.ID)
		if err != nil {
			return fmt.Errorf("count aside replies: %w", err)
		}
		if answered > 0 {
			return domain.ErrAsideAnswered
		}
	}
	if s.draftStatus(row) == domain.BranchDraftDrafting {
		return domain.ErrBranchDrafting
	}
	return nil
}

// requireLineWritable refuses a message on an archived line or in a branch
// that has ended or hangs below one that has.
func (s *Store) requireLineWritable(ctx context.Context, q *db.Queries, line db.TangentLine) error {
	_, _, err := s.requireWritable(ctx, q, line)
	return err
}

// requireWritable is requireLineWritable that also returns the line's
// branch row (isBranch false for a main line).
func (s *Store) requireWritable(ctx context.Context, q *db.Queries, line db.TangentLine) (db.TangentBranch, bool, error) {
	if line.ArchivedAt.Valid {
		return db.TangentBranch{}, false, domain.ErrLineArchived
	}
	row, isBranch, err := branchRowFor(ctx, q, line.ID)
	if err != nil || !isBranch {
		return row, isBranch, err
	}
	up := row
	for level := 0; level <= s.limits.Branch.HardMaxDepth; level++ {
		if up.Status != domain.BranchStatusOpen {
			return row, true, domain.ErrBranchClosed
		}
		parent, isBranch, err := branchRowFor(ctx, q, up.ParentLineID)
		if err != nil || !isBranch {
			return row, true, err
		}
		up = parent
	}
	return row, true, nil
}

// requireAncestorsOpen refuses when a line the branch hangs from has ended or
// was archived.
func (s *Store) requireAncestorsOpen(ctx context.Context, q *db.Queries, parent db.TangentLine, row db.TangentBranch) error {
	if parent.ArchivedAt.Valid {
		return domain.ErrLineArchived
	}
	for level := 0; level <= s.limits.Branch.HardMaxDepth; level++ {
		up, isBranch, err := branchRowFor(ctx, q, row.ParentLineID)
		if err != nil || !isBranch {
			return err
		}
		if up.Status != domain.BranchStatusOpen {
			return domain.ErrBranchParentClosed
		}
		row = up
	}
	return nil
}

// requireNoPendingTurn refuses with busy while the line has a turn in flight.
func requireNoPendingTurn(ctx context.Context, q *db.Queries, lineID uuid.UUID, busy error) error {
	pending, err := q.CountPendingMessages(ctx, lineID)
	if err != nil {
		return fmt.Errorf("count pending turns: %w", err)
	}
	if pending > 0 {
		return busy
	}
	return nil
}

// lockedBranch is a branch line locked together with its ancestors.
type lockedBranch struct {
	child, parent db.TangentLine
	row           db.TangentBranch
}

// lockBranch locks the chain root → parent → branch (withParent) or only the
// branch line, and returns the branch row as it is under the lock.
// ErrBranchNotFound when the line is not a branch of the tenant.
func (s *Store) lockBranch(ctx context.Context, q *db.Queries, tenant, lineID string, withParent bool) (lockedBranch, error) {
	id, ok := parseID(lineID)
	if !ok {
		return lockedBranch{}, domain.ErrBranchNotFound
	}
	peek, isBranch, err := branchRowFor(ctx, q, id)
	if err != nil {
		return lockedBranch{}, err
	}
	if !isBranch || peek.TenantID != tenant {
		return lockedBranch{}, domain.ErrBranchNotFound
	}
	out := lockedBranch{}
	if withParent {
		if peek.RootLineID != peek.ParentLineID {
			if _, err := lockLineByID(ctx, q, peek.RootLineID); err != nil {
				return lockedBranch{}, branchLookup(err)
			}
		}
		if out.parent, err = lockLineByID(ctx, q, peek.ParentLineID); err != nil {
			return lockedBranch{}, branchLookup(err)
		}
	}
	if out.child, err = lockLineByID(ctx, q, id); err != nil {
		return lockedBranch{}, branchLookup(err)
	}
	// Re-read under the lock: a concurrent move may have re-hung the branch.
	if out.row, isBranch, err = branchRowFor(ctx, q, id); err != nil {
		return lockedBranch{}, err
	}
	if !isBranch {
		return lockedBranch{}, domain.ErrBranchNotFound
	}
	// B20: an attach keeps a branch's parent but moves it to another tree;
	// the root locked (or skipped) above is then not its root any more.
	if (withParent && out.row.ParentLineID != out.parent.ID) || out.row.RootLineID != peek.RootLineID {
		return lockedBranch{}, fmt.Errorf("lock branch: %w", errBranchMoved)
	}
	return out, nil
}

// errBranchMoved says the branch was re-hung between the peek and the lock;
// inTx retries the whole transaction on it.
var errBranchMoved = errors.New("the branch was moved while it was being locked")

func branchLookup(err error) error {
	if errors.Is(err, domain.ErrLineNotFound) {
		return domain.ErrBranchNotFound
	}
	return err
}
