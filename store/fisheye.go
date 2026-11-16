package store

import (
	"context"
	"fmt"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Reads of the fisheye context (B9 part B); no writes.

// PinnedMessages lists a line's pinned messages, newest first.
func (s *Store) PinnedMessages(ctx context.Context, tenant, lineID string, limit int) ([]domain.Message, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListPinnedMessages(ctx, db.ListPinnedMessagesParams{LineID: line.ID, RowLimit: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("list pinned messages: %w", err)
	}
	return messagesFromRows(rows), nil
}

// FisheyeTreeBranch is a branch as the fisheye context weighs it.
type FisheyeTreeBranch struct {
	LineID         string
	ParentLineID   string
	Purpose        string
	Kind           string
	Status         string
	ConclusionLine string
	LeafKind       string
	LeafLine       string
	HasReply       bool
}

// FisheyeTree is a line's whole tree: its main line and every branch,
// oldest first (a light read: no message counts).
type FisheyeTree struct {
	RootLineID string
	Branches   []FisheyeTreeBranch
}

// FisheyeTree reads the tree of a line.
func (s *Store) FisheyeTree(ctx context.Context, tenant, lineID string) (FisheyeTree, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return FisheyeTree{}, err
	}
	root, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return FisheyeTree{}, err
	}
	rows, err := s.q.ListFisheyeTree(ctx, db.ListFisheyeTreeParams{RootLineID: root, TenantID: tenant})
	if err != nil {
		return FisheyeTree{}, fmt.Errorf("read the tree: %w", err)
	}
	out := FisheyeTree{RootLineID: root.String(), Branches: make([]FisheyeTreeBranch, 0, len(rows))}
	for _, row := range rows {
		out.Branches = append(out.Branches, FisheyeTreeBranch{
			LineID: row.LineID.String(), ParentLineID: row.ParentLineID.String(), Purpose: row.Purpose, Kind: row.Kind, Status: row.Status,
			ConclusionLine: row.ConclusionLine, LeafKind: row.LeafKind.String, LeafLine: row.LeafLine.String, HasReply: row.HasReply,
		})
	}
	return out, nil
}
