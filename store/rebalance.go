package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// RebalanceState is what the rebalance hint measures of a branch. Eligible
// is false for a branch that cannot be acted on (ended or below an ended
// one, an aside, drafting, archived); TopLevel says whether it hangs on the
// main line (only those can be promoted).
type RebalanceState struct {
	Signals  domain.RebalanceSignals
	Eligible bool
	TopLevel bool
	// ParentTitle is the title of the line the branch hangs on.
	ParentTitle string
}

// RebalanceSignals measures a branch: its finished replies, the parent's
// finished replies after the fork, and whether the tree's last
// l.RecentTurns replies are all the branch's. A branch with fewer replies
// than either threshold needs is not measured further. Reads only.
func (s *Store) RebalanceSignals(ctx context.Context, tenant, lineID string, l domain.RebalanceLimits) (RebalanceState, error) {
	row, err := s.branchOfTenant(ctx, s.q, tenant, lineID)
	if err != nil {
		return RebalanceState{}, err
	}
	ended, err := s.BranchLineEnded(ctx, lineID)
	if err != nil {
		return RebalanceState{}, err
	}
	out := RebalanceState{
		TopLevel: row.ParentLineID == row.RootLineID,
		Eligible: !ended && row.Kind != domain.BranchKindAside && s.draftStatus(row) != domain.BranchDraftDrafting,
	}
	if !out.Eligible {
		return out, nil
	}
	if out.Signals, err = s.rebalanceSignals(ctx, row, l); err != nil {
		return RebalanceState{}, err
	}
	parent, err := s.q.GetLine(ctx, row.ParentLineID)
	if err != nil {
		return RebalanceState{}, lookup(err, domain.ErrLineNotFound, "read the parent")
	}
	out.ParentTitle = parent.Title
	return out, nil
}

func (s *Store) rebalanceSignals(ctx context.Context, row db.TangentBranch, l domain.RebalanceLimits) (domain.RebalanceSignals, error) {
	out := domain.RebalanceSignals{}
	branchTurns, err := s.q.CountReplies(ctx, db.CountRepliesParams{LineID: row.LineID})
	if err != nil {
		return out, fmt.Errorf("count the branch's replies: %w", err)
	}
	out.BranchTurns = int(branchTurns)
	if out.BranchTurns < min(l.MinBranchTurns, l.RecentTurns) {
		return out, nil
	}
	var afterSeq int64
	if anchor, err := messageOn(ctx, s.q, row.ParentLineID, row.AnchorMessageID.String()); err == nil {
		afterSeq = anchor.Seq
	}
	parentTurns, err := s.q.CountReplies(ctx, db.CountRepliesParams{LineID: row.ParentLineID, AfterSeq: afterSeq})
	if err != nil {
		return out, fmt.Errorf("count the parent's replies: %w", err)
	}
	out.ParentTurns = int(parentTurns)
	out.RecentInBranch, err = s.recentInBranch(ctx, row, l.RecentTurns)
	return out, err
}

// recentInBranch: the branch's recent-th latest reply exists and no other
// line of the tree replied after it.
func (s *Store) recentInBranch(ctx context.Context, row db.TangentBranch, recent int) (bool, error) {
	if recent < 1 {
		return false, nil
	}
	seq, err := s.q.NthLatestReplySeq(ctx, db.NthLatestReplySeqParams{LineID: row.LineID, Skip: int32(recent - 1)})
	if noRows(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("the branch's recent replies: %w", err)
	}
	below, err := treeLineIDs(ctx, s.q, row.RootLineID)
	if err != nil {
		return false, err
	}
	other, err := s.q.OtherRepliesAfter(ctx, db.OtherRepliesAfterParams{
		LineIds: append([]uuid.UUID{row.RootLineID}, below...), ExceptLineID: row.LineID, AfterSeq: seq,
	})
	if err != nil {
		return false, fmt.Errorf("the tree's recent replies: %w", err)
	}
	return !other, nil
}
