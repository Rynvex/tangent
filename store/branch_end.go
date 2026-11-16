package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// parentMovedScan bounds the messages counted for a parent_moved answer.
const parentMovedScan = 500

// MergeBranchInput is a confirmed card and the Markdown that stands for it.
// The card is already validated and neutralised by the caller
// (domain.ValidateBranchCard); Content is its rendering. ParentTipMessageID
// is the newest parent message the operator saw; NoteChanges are written in
// the same transaction, citing the branch and the card.
type MergeBranchInput struct {
	Tenant             string
	LineID             string
	Card               domain.BranchCard
	Content            string
	ParentTipMessageID string
	ConfirmParentMoved bool
	NoteChanges        []domain.NoteChange
	Actor              string
}

// MergedBranch is what a merge changed: the card as the parent's newest
// message, the closed branch and the notes it wrote (Revision 0 when none).
type MergedBranch struct {
	Card         domain.Message
	Branch       domain.BranchView
	ParentLineID string
	RootLineID   string
	Notes        NotesWrite
	// Parent is the parent line as the merge left it (read in the
	// transaction, so a committed merge always has it).
	Parent domain.LineView
}

// MergeBranch writes the card as the newest message of the parent and marks
// the branch merged, in one transaction under the locks root → parent →
// branch, so two merges into one parent land in lock order. Refusals: the
// branch or an ancestor has ended, the branch or the parent has a turn in
// flight, or the parent moved on since the tip the operator saw and the
// caller did not confirm.
func (s *Store) MergeBranch(ctx context.Context, in MergeBranchInput, hooks ...TxHook) (MergedBranch, error) {
	changes, err := s.normaliseNotes(in.NoteChanges)
	if err != nil {
		return MergedBranch{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (MergedBranch, error) {
		held, err := s.lockBranch(ctx, q, in.Tenant, in.LineID, true)
		if err != nil {
			return MergedBranch{}, err
		}
		if err := s.checkMergeable(ctx, q, held, in); err != nil {
			return MergedBranch{}, err
		}
		card, err := insertMessage(ctx, q, held.parent, NewMessage{
			Role: domain.RoleSystem, Kind: domain.MessageKindBranchCard, Content: in.Content,
			Meta: domain.MessageMeta{Card: &in.Card, BranchLineID: held.child.ID.String()},
		})
		if err != nil {
			return MergedBranch{}, err
		}
		if err := q.BumpLineUnread(ctx, held.parent.ID); err != nil {
			return MergedBranch{}, fmt.Errorf("bump parent unread: %w", err)
		}
		if _, err := q.CloseBranch(ctx, db.CloseBranchParams{
			LineID: held.child.ID, Status: domain.BranchStatusMerged, ConclusionLine: domain.BranchConclusionLine(in.Card),
			CardMessageID: uuid.NullUUID{UUID: card.ID, Valid: true},
		}); err != nil {
			return MergedBranch{}, fmt.Errorf("close branch: %w", err)
		}
		out := MergedBranch{Card: messageFromRow(card), ParentLineID: held.parent.ID.String(), RootLineID: held.row.RootLineID.String()}
		if out.Notes, err = s.mergeNotes(ctx, q, held, card.ID, changes, in.Actor); err != nil {
			return MergedBranch{}, err
		}
		if out.Branch, err = s.branchViewOf(ctx, q, in.Tenant, held.child.ID); err != nil {
			return MergedBranch{}, err
		}
		out.Parent, err = s.lineViewOf(ctx, q, held.parent.ID)
		return out, err
	})
}

// lineViewOf hydrates one line inside a transaction.
func (s *Store) lineViewOf(ctx context.Context, q *db.Queries, id uuid.UUID) (domain.LineView, error) {
	views, err := s.hydrateIDs(ctx, q, []uuid.UUID{id})
	if err != nil {
		return domain.LineView{}, err
	}
	if len(views) == 0 {
		return domain.LineView{}, domain.ErrLineNotFound
	}
	return views[0], nil
}

// mergeNotes writes a merge's note changes under the root's lock (already
// held: root is the first lock of a merge).
func (s *Store) mergeNotes(ctx context.Context, q *db.Queries, held lockedBranch, cardID uuid.UUID, changes []domain.NoteChange, actor string) (NotesWrite, error) {
	result := NotesWrite{RootLineID: held.row.RootLineID.String(), Created: []domain.Note{}, Superseded: []domain.Note{}}
	if len(changes) == 0 {
		return result, nil
	}
	root, err := lockLineByID(ctx, q, held.row.RootLineID)
	if err != nil {
		return result, err
	}
	return s.applyNoteChanges(ctx, q, root, changes, noteWriteContext{
		actor: actor, forcedLine: uuid.NullUUID{UUID: held.child.ID, Valid: true}, card: uuid.NullUUID{UUID: cardID, Valid: true},
	})
}

// checkMergeable applies every refusal of a merge under the locks.
func (s *Store) checkMergeable(ctx context.Context, q *db.Queries, held lockedBranch, in MergeBranchInput) error {
	if held.row.Status != domain.BranchStatusOpen {
		return domain.ErrBranchClosed
	}
	if held.child.ArchivedAt.Valid {
		return domain.ErrLineArchived
	}
	if err := s.requireAncestorsOpen(ctx, q, held.parent, held.row); err != nil {
		return err
	}
	if err := requireNoPendingTurn(ctx, q, held.child.ID, domain.ErrBranchBusy); err != nil {
		return err
	}
	if err := requireNoPendingTurn(ctx, q, held.parent.ID, domain.ErrBranchParentBusy); err != nil {
		return err
	}
	return checkParentMoved(ctx, q, held, in)
}

// checkParentMoved holds the card back when the parent has relevant messages
// after the one the operator saw as its tail. The seen message must be one of
// the parent's own.
func checkParentMoved(ctx context.Context, q *db.Queries, held lockedBranch, in MergeBranchInput) error {
	tip, err := messageOn(ctx, q, held.parent.ID, in.ParentTipMessageID)
	if errors.Is(err, domain.ErrMessageNotFound) {
		return domain.ErrBranchParentTipUnknown
	}
	if err != nil {
		return err
	}
	if in.ConfirmParentMoved {
		return nil
	}
	after, err := q.ListRelevantMessagesAfterSeq(ctx, db.ListRelevantMessagesAfterSeqParams{
		LineID: held.parent.ID, AfterSeq: tip.Seq, RowLimit: parentMovedScan,
	})
	if err != nil {
		return fmt.Errorf("list parent messages after the tip: %w", err)
	}
	if len(after) == 0 {
		return nil
	}
	moved := &domain.ParentMovedError{MovedMessages: len(after)}
	for _, message := range after {
		if message.Kind == domain.MessageKindBranchCard {
			moved.MovedCards++
		}
	}
	return moved
}

// DiscardBranch ends a branch without bringing anything back: it is kept,
// marked discarded, and takes no more turns. Only the branch line is locked.
func (s *Store) DiscardBranch(ctx context.Context, tenant, lineID string, hooks ...TxHook) (domain.BranchView, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (domain.BranchView, error) {
		held, err := s.lockBranch(ctx, q, tenant, lineID, false)
		if err != nil {
			return domain.BranchView{}, err
		}
		if held.row.Status != domain.BranchStatusOpen {
			return domain.BranchView{}, domain.ErrBranchClosed
		}
		if held.child.ArchivedAt.Valid {
			return domain.BranchView{}, domain.ErrLineArchived
		}
		if err := requireNoPendingTurn(ctx, q, held.child.ID, domain.ErrBranchBusy); err != nil {
			return domain.BranchView{}, err
		}
		if _, err := q.CloseBranch(ctx, db.CloseBranchParams{LineID: held.child.ID, Status: domain.BranchStatusDiscarded}); err != nil {
			return domain.BranchView{}, fmt.Errorf("discard branch: %w", err)
		}
		return s.branchViewOf(ctx, q, tenant, held.child.ID)
	})
}
