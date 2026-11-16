package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// UpdateBranchCardInput is the edited conclusion card of a merged branch
// and the Markdown that stands for it. The card is already validated and
// neutralised by the caller (domain.ValidateBranchCard); Content is its
// rendering.
type UpdateBranchCardInput struct {
	Tenant  string
	LineID  string
	Card    domain.BranchCard
	Content string
	Actor   string
	// FollowLeaf lets the edit rewrite the branch's leaf (the leaf feature
	// is on, as it was when the merge wrote one).
	FollowLeaf bool
}

// UpdatedCard is what a card edit changed: the card message, the branch
// and, when it followed the card, the branch's leaf. ParentLineID is the
// line that holds the card (the branch's parent).
type UpdatedCard struct {
	Branch       domain.BranchView
	Message      domain.Message
	ParentLineID string
	RootLineID   string
	// Leaf is the branch's leaf when the edit rewrote it, nil otherwise.
	Leaf *domain.Leaf
}

// UpdateBranchCard rewrites the card of a merged branch in one transaction
// under the merge's locks root → parent → branch: the card message's
// content and meta.card (its other meta keys stay; delivered is cleared, so
// the next turn of the line carries the card once more), the branch's
// conclusion line and, while it is still the one the merge wrote from the
// old card (and FollowLeaf), the branch's leaf. Refusals: the branch was
// not merged, a line involved is archived, the card is no longer on the
// parent or the parent has ended or has a turn in flight.
func (s *Store) UpdateBranchCard(ctx context.Context, in UpdateBranchCardInput, hooks ...TxHook) (UpdatedCard, error) {
	card, err := json.Marshal(in.Card)
	if err != nil {
		return UpdatedCard{}, fmt.Errorf("marshal card: %w", err)
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (UpdatedCard, error) {
		held, err := s.lockBranch(ctx, q, in.Tenant, in.LineID, true)
		if err != nil {
			return UpdatedCard{}, err
		}
		if held.row.Status != domain.BranchStatusMerged || !held.row.CardMessageID.Valid {
			return UpdatedCard{}, domain.ErrCardNotEditable
		}
		if held.child.ArchivedAt.Valid {
			return UpdatedCard{}, domain.ErrLineArchived
		}
		previous, holder, err := s.lockCardHolder(ctx, q, held)
		if err != nil {
			return UpdatedCard{}, err
		}
		row, err := q.UpdateCardMessage(ctx, db.UpdateCardMessageParams{Content: in.Content, Card: card, ID: previous.ID})
		if err != nil {
			return UpdatedCard{}, lookup(err, domain.ErrCardNotEditable, "update card message")
		}
		if _, err := q.SetBranchConclusionLine(ctx, db.SetBranchConclusionLineParams{
			ConclusionLine: domain.BranchConclusionLine(in.Card), LineID: held.child.ID,
		}); err != nil {
			return UpdatedCard{}, fmt.Errorf("set conclusion line: %w", err)
		}
		out := UpdatedCard{Message: messageFromRow(row), ParentLineID: holder.ID.String(), RootLineID: held.row.RootLineID.String()}
		if !in.FollowLeaf {
			out.Branch, err = s.branchViewOf(ctx, q, in.Tenant, held.child.ID)
			return out, err
		}
		if out.Leaf, err = s.followCardLeaf(ctx, q, held.row, messageFromRow(previous).Meta.Card, in.Card, in.Actor); err != nil {
			return UpdatedCard{}, err
		}
		out.Branch, err = s.branchViewOf(ctx, q, in.Tenant, held.child.ID)
		return out, err
	})
}

// lockCardHolder reads the card message, which must still be on the
// parent (locked already): only a promotion moves a card away from its
// branch's parent, onto the previous main line, which has ended for good,
// so such a card is refused without locking that line (no lock outside the
// order root → parent → branch). The parent must still take turns and have
// none in flight: an edit counts because its next turn carries the card
// again, and a running turn may already carry it as it was.
func (s *Store) lockCardHolder(ctx context.Context, q *db.Queries, held lockedBranch) (db.TangentMessage, db.TangentLine, error) {
	message, err := q.GetMessage(ctx, held.row.CardMessageID.UUID)
	if err != nil {
		return db.TangentMessage{}, db.TangentLine{}, lookup(err, domain.ErrCardNotEditable, "get card message")
	}
	if message.LineID != held.parent.ID {
		return db.TangentMessage{}, db.TangentLine{}, domain.ErrCardHolderClosed
	}
	if _, _, err := s.requireWritable(ctx, q, held.parent); err != nil {
		if errors.Is(err, domain.ErrBranchClosed) {
			return db.TangentMessage{}, db.TangentLine{}, domain.ErrCardHolderClosed
		}
		return db.TangentMessage{}, db.TangentLine{}, err
	}
	if err := requireNoPendingTurn(ctx, q, held.parent.ID, domain.ErrCardHolderBusy); err != nil {
		return db.TangentMessage{}, db.TangentLine{}, err
	}
	return message, held.parent, nil
}

// followCardLeaf rewrites the branch's leaf from the edited card when the
// leaf is still exactly what the merge wrote from the old card; a leaf the
// operator (or a draft) rewrote since is kept. nil when nothing changed.
// The branch line is locked (the last lock of the edit).
func (s *Store) followCardLeaf(ctx context.Context, q *db.Queries, branch db.TangentBranch, old *domain.BranchCard, card domain.BranchCard, actor string) (*domain.Leaf, error) {
	if old == nil {
		return nil, nil
	}
	existing, err := q.GetLeaf(ctx, branch.LineID)
	if noRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get leaf: %w", err)
	}
	was, problems := domain.NormalizeLeaf(domain.LeafFromCard(*old, s.limits.Leaf), s.limits.Leaf)
	if len(problems) > 0 || existing.SourceJobID.Valid || existing.Kind != was.Kind || existing.Line != was.Line || existing.Body != was.Body {
		return nil, nil
	}
	next, problems := domain.NormalizeLeaf(domain.LeafFromCard(card, s.limits.Leaf), s.limits.Leaf)
	if len(problems) > 0 || next == was {
		return nil, nil
	}
	leaf, err := upsertLeaf(ctx, q, branch, next, existing.Status, uuid.NullUUID{}, actor)
	if err != nil {
		return nil, err
	}
	return &leaf, nil
}
