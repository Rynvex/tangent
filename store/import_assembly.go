package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Assembling an import (B19): conclusion cards of branches already brought
// back, their close and leaf, milestone chapter cuts and the source's dates.

// insertImportedCard writes a merged branch's conclusion card on the main
// line right after its anchor, already delivered (it stands for turns that
// were part of the conversation, as an extract's card does) and dated like
// the anchor, so what reads time in seq order sees no jump where it stands.
func insertImportedCard(ctx context.Context, q *db.Queries, main db.TangentLine, anchor db.TangentMessage, branch domain.ImportPlanBranch, branchID uuid.UUID) (db.TangentMessage, error) {
	meta, err := json.Marshal(domain.MessageMeta{Card: branch.Card, BranchLineID: branchID.String(), Delivered: true})
	if err != nil {
		return db.TangentMessage{}, fmt.Errorf("marshal card meta: %w", err)
	}
	row, err := q.InsertMessageAt(ctx, db.InsertMessageAtParams{
		LineID: main.ID, TenantID: main.TenantID, Role: domain.RoleSystem, Kind: domain.MessageKindBranchCard, Content: branch.CardContent,
		Status: domain.MessageDone, Meta: meta, HostMeta: []byte("{}"), CreatedAt: anchor.CreatedAt,
	})
	if err != nil {
		return db.TangentMessage{}, fmt.Errorf("insert an imported conclusion card: %w", err)
	}
	return row, nil
}

// closeImported closes an imported branch as its plan asks: discarded, or
// merged with its card. An open branch stays open.
func (s *Store) closeImported(ctx context.Context, q *db.Queries, lineID uuid.UUID, branch importedBranch, in ImportLineInput) (*domain.Leaf, error) {
	switch branch.plan.Status {
	case domain.BranchStatusDiscarded:
		if _, err := q.CloseBranch(ctx, db.CloseBranchParams{LineID: lineID, Status: domain.BranchStatusDiscarded}); err != nil {
			return nil, fmt.Errorf("discard an imported branch: %w", err)
		}
	case domain.BranchStatusMerged:
		return s.mergeImported(ctx, q, lineID, branch, in)
	}
	return nil, nil
}

// mergeImported marks an imported branch merged with the card left on the
// main line and, with Leaves, writes the card as its confirmed leaf (as
// closeExtracted does for an extract with a card).
func (s *Store) mergeImported(ctx context.Context, q *db.Queries, lineID uuid.UUID, branch importedBranch, in ImportLineInput) (*domain.Leaf, error) {
	if branch.plan.Card == nil {
		return nil, fmt.Errorf("merged imported branch %s has no card", lineID)
	}
	row, err := q.CloseBranch(ctx, db.CloseBranchParams{
		LineID: lineID, Status: domain.BranchStatusMerged, ConclusionLine: domain.BranchConclusionLine(*branch.plan.Card),
		CardMessageID: uuid.NullUUID{UUID: branch.card.ID, Valid: true},
	})
	if err != nil {
		return nil, fmt.Errorf("merge an imported branch: %w", err)
	}
	if !in.Leaves {
		return nil, nil
	}
	leafIn, problems := domain.NormalizeLeaf(domain.LeafFromCard(*branch.plan.Card, s.limits.Leaf), s.limits.Leaf)
	if len(problems) > 0 {
		return nil, domain.LeafError(problems)
	}
	leaf, err := upsertLeaf(ctx, q, row, leafIn, domain.LeafStatusConfirmed, uuid.NullUUID{}, in.CreatedBy)
	if err != nil {
		return nil, err
	}
	return &leaf, nil
}

// importCuts writes the plan's chapter cuts as milestones on their main-line
// messages (AddMilestone's rows).
func (s *Store) importCuts(ctx context.Context, q *db.Queries, main db.TangentLine, written imported, in ImportLineInput) ([]domain.ChapterCut, error) {
	out := make([]domain.ChapterCut, 0, len(in.Plan.ChapterCuts))
	for _, cut := range in.Plan.ChapterCuts {
		stored, err := s.insertCut(ctx, q, cutParams{
			tenant: main.TenantID, root: main.ID, line: main.ID, message: written.rows[written.at[cut.AnchorIndex]].ID,
			kind: domain.ChapterKindMilestone, title: cut.Title, actor: in.CreatedBy,
		})
		if err != nil {
			return nil, err
		}
		if stored == nil {
			return nil, domain.ErrChapterMilestoneExists
		}
		out = append(out, *stored)
	}
	return out, nil
}

// dateImportedLine dates an imported line (nothing without dates).
func dateImportedLine(ctx context.Context, q *db.Queries, lineID uuid.UUID, dates *domain.ImportDates) error {
	if dates == nil {
		return nil
	}
	if err := q.DateImportedLine(ctx, db.DateImportedLineParams{ID: lineID, CreatedAt: dates.CreatedAt, LastActivityAt: dates.LastActivityAt}); err != nil {
		return fmt.Errorf("date an imported line: %w", err)
	}
	return nil
}

// dateImportedBranch dates an imported branch's line and its branch row: it
// started with its line and, once closed, closed at its last message.
func dateImportedBranch(ctx context.Context, q *db.Queries, lineID uuid.UUID, dates *domain.ImportDates) error {
	if dates == nil {
		return nil
	}
	if err := dateImportedLine(ctx, q, lineID, dates); err != nil {
		return err
	}
	if err := q.DateImportedBranch(ctx, db.DateImportedBranchParams{LineID: lineID, CreatedAt: dates.CreatedAt, ClosedAt: dates.LastActivityAt}); err != nil {
		return fmt.Errorf("date an imported branch: %w", err)
	}
	return nil
}
