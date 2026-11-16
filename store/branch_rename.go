package store

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// RenameBranch changes the purpose of a branch (and the title of its line,
// which follows the purpose) under the branch line's lock. The purpose is
// trimmed and must be within Limits.Branch.PurposeMaxRunes. Open and ended
// (merged, discarded) branches can be renamed (B13); a promoted
// branch (an emptied line) and the previous main line are branch_closed,
// an archived tree archived. Snapshots keep the old name: the pack, card
// and marker messages, note, seed and memo labels, spinoff capsules,
// suggestion payloads. What reads the purpose live (card notices of the
// parent's next turns, fisheye, group summaries, AI proposals) uses the new
// name from then on (DESIGN §12.10).
func (s *Store) RenameBranch(ctx context.Context, tenant, lineID, purpose string, hooks ...TxHook) (domain.BranchView, error) {
	purpose, ok := domain.NormalizeBranchPurpose(purpose, s.limits.Branch)
	if !ok {
		return domain.BranchView{}, domain.ErrInvalidPurpose
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.BranchView, error) {
		held, err := s.lockBranch(ctx, q, tenant, lineID, false)
		if err != nil {
			return domain.BranchView{}, err
		}
		if held.child.ArchivedAt.Valid {
			return domain.BranchView{}, domain.ErrLineArchived
		}
		if !domain.BranchRenamable(held.row.Status, held.row.Origin) {
			return domain.BranchView{}, domain.ErrBranchClosed
		}
		if _, err := q.RenameBranch(ctx, db.RenameBranchParams{LineID: held.child.ID, Purpose: purpose}); err != nil {
			return domain.BranchView{}, lookup(err, domain.ErrBranchClosed, "rename branch")
		}
		return s.branchViewOf(ctx, q, tenant, held.child.ID)
	})
}
