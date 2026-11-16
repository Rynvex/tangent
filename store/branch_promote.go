package store

import (
	"context"
	"fmt"
	"slices"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// PromotedBranch is what a promotion changed.
type PromotedBranch struct {
	MainLineID string
	// PromotedID is the branch whose messages are now the main line's.
	PromotedID string
	// PreviousID is the new ended branch that holds the old main line's tail.
	PreviousID string
	// Reparented are the branches that now hang on another line.
	Reparented []string
	// Main, Promoted and Previous are the views after the promotion, read in
	// its transaction.
	Main     domain.LineView
	Promoted domain.BranchView
	Previous domain.BranchView
}

// PromoteBranch makes an open branch of the main line the main line, in one
// transaction under the locks main line → branch. The main line keeps its
// id: its messages after the fork point move to a new, already discarded
// "previous main line" branch and the branch's messages take their place
// (seqs unchanged). Refusals: not a direct branch of the main line, closed,
// either line answering, the branch drafting, unfinished branches on the
// part of the main line that is put away.
func (s *Store) PromoteBranch(ctx context.Context, tenant, lineID string, hooks ...TxHook) (PromotedBranch, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (PromotedBranch, error) {
		held, err := s.lockBranch(ctx, q, tenant, lineID, true)
		if err != nil {
			return PromotedBranch{}, err
		}
		if err := s.checkPromotable(ctx, q, held); err != nil {
			return PromotedBranch{}, err
		}
		previous, err := s.insertPreviousMainLine(ctx, q, held)
		if err != nil {
			return PromotedBranch{}, err
		}
		if err := swapTranscripts(ctx, q, held, previous); err != nil {
			return PromotedBranch{}, err
		}
		reparented, err := s.rehangAfterPromotion(ctx, q, held, previous)
		if err != nil {
			return PromotedBranch{}, err
		}
		if _, err := q.CloseBranch(ctx, db.CloseBranchParams{LineID: held.child.ID, Status: domain.BranchStatusPromoted}); err != nil {
			return PromotedBranch{}, fmt.Errorf("close promoted branch: %w", err)
		}
		if err := forgetSummary(ctx, q, []uuid.UUID{held.parent.ID, held.child.ID}, true); err != nil {
			return PromotedBranch{}, err
		}
		out := PromotedBranch{MainLineID: held.parent.ID.String(), PromotedID: held.child.ID.String(), PreviousID: previous.String(), Reparented: reparented}
		if err := touch(ctx, q, held.parent.ID); err != nil {
			return PromotedBranch{}, err
		}
		return s.promotedViews(ctx, q, tenant, out, held.parent.ID, held.child.ID, previous)
	})
}

// promotedViews reads, in the promotion's transaction, the views it changed.
func (s *Store) promotedViews(ctx context.Context, q *db.Queries, tenant string, out PromotedBranch, main, promoted, previous uuid.UUID) (PromotedBranch, error) {
	var err error
	if out.Main, err = s.lineViewOf(ctx, q, main); err != nil {
		return PromotedBranch{}, err
	}
	if out.Promoted, err = s.branchViewOf(ctx, q, tenant, promoted); err != nil {
		return PromotedBranch{}, err
	}
	if out.Previous, err = s.branchViewOf(ctx, q, tenant, previous); err != nil {
		return PromotedBranch{}, err
	}
	return out, nil
}

// checkPromotable applies every refusal that does not need the move itself.
func (s *Store) checkPromotable(ctx context.Context, q *db.Queries, held lockedBranch) error {
	switch {
	case held.row.Status != domain.BranchStatusOpen:
		return domain.ErrBranchClosed
	case held.row.ParentLineID != held.row.RootLineID:
		return domain.ErrBranchPromoteNotTopLevel
	case held.parent.ArchivedAt.Valid || held.child.ArchivedAt.Valid:
		return domain.ErrLineArchived
	case s.draftStatus(held.row) == domain.BranchDraftDrafting:
		return domain.ErrBranchPromoteDrafting
	case held.parent.Status == domain.LineStatusThinking:
		return domain.ErrBranchParentBusy
	}
	if err := requireNoPendingTurn(ctx, q, held.parent.ID, domain.ErrBranchParentBusy); err != nil {
		return err
	}
	if held.child.Status == domain.LineStatusThinking {
		return domain.ErrBranchBusy
	}
	return requireNoPendingTurn(ctx, q, held.child.ID, domain.ErrBranchBusy)
}

// insertPreviousMainLine creates the ended branch that will hold the old
// tail: the main line's provider and model, anchored where the promoted
// branch was.
func (s *Store) insertPreviousMainLine(ctx context.Context, q *db.Queries, held lockedBranch) (uuid.UUID, error) {
	total, err := q.CountBranchesForRoot(ctx, held.parent.ID)
	if err != nil {
		return uuid.UUID{}, fmt.Errorf("count tree branches: %w", err)
	}
	if int(total) >= s.limits.Branch.MaxPerTree {
		return uuid.UUID{}, domain.ErrBranchTreeLimit
	}
	line, err := q.InsertLine(ctx, db.InsertLineParams{
		ID: uuid.New(), TenantID: held.parent.TenantID, Title: domain.BranchPreviousMainLinePurpose,
		Provider: held.parent.Provider, Model: held.parent.Model, HostMeta: []byte("{}"), CreatedBy: held.parent.CreatedBy, Tags: noTags(),
	})
	if err != nil {
		return uuid.UUID{}, fmt.Errorf("insert previous main line: %w", err)
	}
	if _, err := q.InsertBranch(ctx, db.InsertBranchParams{
		LineID: line.ID, TenantID: line.TenantID, ParentLineID: held.parent.ID, RootLineID: held.parent.ID,
		AnchorMessageID: held.row.AnchorMessageID, Purpose: domain.BranchPreviousMainLinePurpose, Kind: domain.BranchKindAlternative,
		Depth: 1, Origin: domain.BranchOriginPreviousMainLine, Pack: []byte("{}"), CreatedBy: held.parent.CreatedBy,
	}); err != nil {
		return uuid.UUID{}, fmt.Errorf("insert previous main line branch: %w", err)
	}
	if _, err := q.CloseBranch(ctx, db.CloseBranchParams{LineID: line.ID, Status: domain.BranchStatusDiscarded}); err != nil {
		return uuid.UUID{}, fmt.Errorf("close previous main line: %w", err)
	}
	return line.ID, nil
}

// swapTranscripts moves the main line's messages after the anchor to the
// previous main line and every message of the branch to the main line.
func swapTranscripts(ctx context.Context, q *db.Queries, held lockedBranch, previous uuid.UUID) error {
	anchor, err := q.GetMessage(ctx, held.row.AnchorMessageID)
	if noRows(err) || (err == nil && anchor.LineID != held.parent.ID) {
		return domain.ErrBranchAnchorNotFound
	}
	if err != nil {
		return fmt.Errorf("get anchor: %w", err)
	}
	if _, err := q.MoveMessagesAfterSeq(ctx, db.MoveMessagesAfterSeqParams{ToLine: previous, FromLine: held.parent.ID, AfterSeq: anchor.Seq}); err != nil {
		return fmt.Errorf("move the old tail: %w", err)
	}
	if _, err := q.MoveAllMessages(ctx, db.MoveAllMessagesParams{ToLine: held.parent.ID, FromLine: held.child.ID}); err != nil {
		return fmt.Errorf("move the branch messages: %w", err)
	}
	return nil
}

// rehangAfterPromotion moves the other branches with their messages.
// Branches of the main line on the put-away tail go below the previous main
// line (refused while one is still open); branches of the promoted branch go
// up to the main line. Depths follow.
func (s *Store) rehangAfterPromotion(ctx context.Context, q *db.Queries, held lockedBranch, previous uuid.UUID) ([]string, error) {
	tailChildren, err := q.ListBranchesAnchoredInLine(ctx, db.ListBranchesAnchoredInLineParams{ParentLineID: held.parent.ID, MessageLineID: previous})
	if err != nil {
		return nil, fmt.Errorf("list branches on the old tail: %w", err)
	}
	if err := s.requireTailClosed(ctx, q, tailChildren); err != nil {
		return nil, err
	}
	lifted, err := q.ListChildBranchIDs(ctx, held.child.ID)
	if err != nil {
		return nil, fmt.Errorf("list branches of the promoted branch: %w", err)
	}
	if err := s.requireRoomOnMainLine(ctx, q, held, lifted); err != nil {
		return nil, err
	}
	if len(tailChildren) > 0 {
		if err := q.ReparentBranches(ctx, db.ReparentBranchesParams{ParentLineID: previous, LineIds: tailChildren}); err != nil {
			return nil, fmt.Errorf("reparent old tail branches: %w", err)
		}
		if err := s.shiftSubtreeDepth(ctx, q, previous, 1); err != nil {
			return nil, err
		}
	}
	if err := s.liftBranches(ctx, q, held.parent.ID, lifted); err != nil {
		return nil, err
	}
	return idStrings(append(tailChildren, lifted...)), nil
}

// liftBranches re-hangs the promoted branch's own branches on the main line,
// one level higher together with everything below them (one walk, one
// update: a depth that goes down always fits).
func (s *Store) liftBranches(ctx context.Context, q *db.Queries, mainLine uuid.UUID, lifted []uuid.UUID) error {
	if len(lifted) == 0 {
		return nil
	}
	below, err := s.subtreesIDs(ctx, q, lifted)
	if err != nil {
		return err
	}
	if err := q.ReparentBranches(ctx, db.ReparentBranchesParams{ParentLineID: mainLine, LineIds: lifted}); err != nil {
		return fmt.Errorf("lift branches of the promoted branch: %w", err)
	}
	if err := q.ShiftBranchDepths(ctx, db.ShiftBranchDepthsParams{Delta: -1, LineIds: append(slices.Clone(lifted), below...)}); err != nil {
		return fmt.Errorf("shift lifted depths: %w", err)
	}
	return nil
}

// requireTailClosed refuses when any branch on the put-away tail, or below
// one, is still open (one walk over all of them).
func (s *Store) requireTailClosed(ctx context.Context, q *db.Queries, children []uuid.UUID) error {
	if len(children) == 0 {
		return nil
	}
	below, err := s.subtreesIDs(ctx, q, children)
	if err != nil {
		return err
	}
	rows, err := q.ListBranchesByLineIDs(ctx, append(slices.Clone(children), below...))
	if err != nil {
		return fmt.Errorf("list tail branches: %w", err)
	}
	open := []string{}
	for _, row := range rows {
		if row.Status == domain.BranchStatusOpen {
			open = append(open, row.LineID.String())
		}
	}
	if len(open) > 0 {
		slices.Sort(open)
		return &domain.BranchOpenTailError{LineIDs: open}
	}
	return nil
}

// requireRoomOnMainLine keeps the open-branch cap of the main line when the
// promoted branch's own open branches move up to it.
func (s *Store) requireRoomOnMainLine(ctx context.Context, q *db.Queries, held lockedBranch, lifted []uuid.UUID) error {
	if len(lifted) == 0 {
		return nil
	}
	open, err := q.CountOpenBranchesForParent(ctx, held.parent.ID)
	if err != nil {
		return fmt.Errorf("count open branches: %w", err)
	}
	rows, err := q.ListBranchesByLineIDs(ctx, lifted)
	if err != nil {
		return fmt.Errorf("list lifted branches: %w", err)
	}
	total := int(open) - 1 // the promoted branch stops being open
	for _, row := range rows {
		if row.Status == domain.BranchStatusOpen {
			total++
		}
	}
	if total > s.limits.Branch.MaxOpenPerParent {
		return domain.ErrBranchLimit
	}
	return nil
}
