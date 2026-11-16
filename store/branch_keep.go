package store

import (
	"context"
	"fmt"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// KeptBranch is an aside after KeepBranch: its outline row as it is now and
// whether the call changed it (keeping a kept aside changes nothing).
type KeptBranch struct {
	Branch  domain.BranchView
	Changed bool
}

// KeepBranch keeps an aside from the purge (keep) or lets the purge have it
// again, under the aside line's lock, as a rename locks: the purge re-reads
// the aside under that same lock, so it never deletes one kept meanwhile.
// An open aside may be kept before its answer. Released, its purge time is
// what it was: closed_at + the retention. Refusals: not a branch
// (ErrBranchNotFound), not an aside (ErrKeepNotAside), archived.
func (s *Store) KeepBranch(ctx context.Context, tenant, lineID string, keep bool, hooks ...TxHook) (KeptBranch, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (KeptBranch, error) {
		held, err := s.lockBranch(ctx, q, tenant, lineID, false)
		if err != nil {
			return KeptBranch{}, err
		}
		switch {
		case held.row.Kind != domain.BranchKindAside:
			return KeptBranch{}, domain.ErrKeepNotAside
		case held.child.ArchivedAt.Valid:
			return KeptBranch{}, domain.ErrLineArchived
		}
		changed := held.row.KeptAt.Valid != keep
		if changed {
			if _, err := q.SetBranchKept(ctx, db.SetBranchKeptParams{LineID: held.child.ID, Keep: keep}); err != nil {
				return KeptBranch{}, fmt.Errorf("keep branch: %w", err)
			}
		}
		view, err := s.branchViewOf(ctx, q, tenant, held.child.ID)
		return KeptBranch{Branch: view, Changed: changed}, err
	})
}
