package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// CreateSeedsInput parks several thoughts on a line at once (an outline or
// a to-do list, B14); the anchor rule is CreateSeedInput's and holds for
// every one.
type CreateSeedsInput struct {
	Tenant          string
	LineID          string
	AnchorMessageID string
	Texts           []string
	Actor           string
}

// CreatedSeeds is what a batch parked, in the order of its texts.
type CreatedSeeds struct {
	RootLineID string
	Seeds      []domain.Seed
}

// CreateSeeds parks 1 to domain.SeedBatchMax thoughts in one transaction
// under the main line's lock, all or none: CreateSeed's refusals apply,
// and the open-seed cap counts the whole batch.
func (s *Store) CreateSeeds(ctx context.Context, in CreateSeedsInput, hooks ...TxHook) (CreatedSeeds, error) {
	texts, err := domain.NormalizeSeedTexts(in.Texts, s.limits.Parking)
	if err != nil {
		return CreatedSeeds{}, err
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (CreatedSeeds, error) {
		line, err := s.lineRow(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return CreatedSeeds{}, err
		}
		root, err := lockOpenRootOf(ctx, q, line.ID)
		if err != nil {
			return CreatedSeeds{}, err
		}
		if open, err := q.CountOpenSeeds(ctx, root.ID); err != nil {
			return CreatedSeeds{}, fmt.Errorf("count open seeds: %w", err)
		} else if int(open)+len(texts) > s.limits.Parking.MaxOpenPerTree {
			return CreatedSeeds{}, domain.ErrSeedLimit
		}
		anchor, anchorLine, err := seedAnchor(ctx, q, root.ID, line.ID, in.AnchorMessageID)
		if err != nil {
			return CreatedSeeds{}, err
		}
		label, err := s.sourceLabel(ctx, q, root.ID, anchorLine, anchor, uuid.NullUUID{})
		if err != nil {
			return CreatedSeeds{}, err
		}
		rows := make([]db.TangentSeed, 0, len(texts))
		for _, text := range texts {
			row, err := q.InsertSeed(ctx, db.InsertSeedParams{
				TenantID: root.TenantID, RootLineID: root.ID, AnchorMessageID: anchor, Text: text, SourceLabel: label, CreatedBy: strings.TrimSpace(in.Actor),
			})
			if err != nil {
				return CreatedSeeds{}, fmt.Errorf("insert seed: %w", err)
			}
			rows = append(rows, row)
		}
		seeds, err := seedViews(ctx, q, rows)
		if err != nil {
			return CreatedSeeds{}, err
		}
		return CreatedSeeds{RootLineID: root.ID.String(), Seeds: seeds}, nil
	})
}
