package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// LinesGone is what went with lines deleted out of a tree that stays (B23):
// the host data of the lines and their messages (as DeletedTree reports
// it), the jobs still pending on them, and what the rest of the tree lost
// or changed with them.
type LinesGone struct {
	// LineIDs are the deleted lines, the one asked for first.
	LineIDs      []string
	LineHostMeta map[string]json.RawMessage
	Messages     []MessageHostMeta
	// PendingJobIDs are the pending jobs deleted with the lines.
	PendingJobIDs []string
	// ExpiredSuggestions are the tree's open suggestions that named one of
	// the lines.
	ExpiredSuggestions []domain.Suggestion
	// DeletedLinks are the links (spinoff or relation) that had an end on
	// one of the lines, each with the conversations it touched.
	DeletedLinks []RelationChange
	// Groups are the active groups the lines belonged to, as they are now:
	// without those members, dissolved when fewer than two are left.
	Groups []domain.Group
}

// releaseLines settles, in the tree of root (locked), what the lines about
// to be deleted leave behind, and reads what goes with them; the caller
// deletes the lines afterwards. Notes taken from the lines get their source
// label, open suggestions naming them expire, their groups lose them.
// Memos written on them stay in the tree (line_id ON DELETE SET NULL);
// everything else of the lines goes by the foreign keys' cascade.
func (s *Store) releaseLines(ctx context.Context, q *db.Queries, root uuid.UUID, ids []uuid.UUID) (LinesGone, error) {
	tree, err := readDeletedTree(ctx, q, root, ids)
	if err != nil {
		return LinesGone{}, err
	}
	out := LinesGone{LineIDs: tree.LineIDs, LineHostMeta: tree.LineHostMeta, Messages: tree.Messages, PendingJobIDs: tree.PendingJobIDs}
	if err := s.labelMovingSources(ctx, q, root, ids); err != nil {
		return LinesGone{}, err
	}
	if out.DeletedLinks, err = linksOfLines(ctx, q, ids); err != nil {
		return LinesGone{}, err
	}
	if out.ExpiredSuggestions, err = expireNamingLines(ctx, q, root, ids); err != nil {
		return LinesGone{}, err
	}
	if out.Groups, err = leaveGroups(ctx, q, ids); err != nil {
		return LinesGone{}, err
	}
	return out, nil
}

// linksOfLines reads the links with an end on one of the lines (the cascade
// deletes exactly these with the lines), each with the main lines of the
// conversations it touches.
func linksOfLines(ctx context.Context, q *db.Queries, ids []uuid.UUID) ([]RelationChange, error) {
	rows, err := q.ListLinkEndsOfLines(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("list the links of the lines: %w", err)
	}
	out := make([]RelationChange, 0, len(rows))
	for _, row := range rows {
		fromRoot, err := rootOf(ctx, q, row.FromLineID)
		if err != nil {
			return nil, err
		}
		toRoot, err := rootOf(ctx, q, row.ToLineID)
		if err != nil {
			return nil, err
		}
		change, err := relationChange(ctx, q, row.ID, fromRoot, toRoot)
		if err != nil {
			return nil, err
		}
		out = append(out, change)
	}
	return out, nil
}

// leaveGroups takes the lines out of the active groups they belong to and
// dissolves a group left with fewer than two members (a group is at least
// two branches). It returns those groups as they are afterwards.
func leaveGroups(ctx context.Context, q *db.Queries, ids []uuid.UUID) ([]domain.Group, error) {
	rows, err := q.ListActiveGroupsOfLines(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("list the groups of the lines: %w", err)
	}
	if len(rows) == 0 {
		return []domain.Group{}, nil
	}
	if err := q.DeleteGroupMembersOfLines(ctx, ids); err != nil {
		return nil, fmt.Errorf("take the lines out of their groups: %w", err)
	}
	groups, err := groupViews(ctx, q, rows)
	if err != nil {
		return nil, err
	}
	for i, group := range groups {
		if len(group.MemberLineIDs) >= domain.GroupMinMembers {
			continue
		}
		dissolved, err := q.DissolveGroup(ctx, rows[i].ID)
		if err != nil {
			return nil, fmt.Errorf("dissolve a group left short: %w", err)
		}
		groups[i].Status, groups[i].UpdatedAt = dissolved.Status, dissolved.UpdatedAt.UTC()
	}
	return groups, nil
}
