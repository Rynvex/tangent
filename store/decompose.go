package store

import (
	"context"
	"fmt"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// DecomposeBase is what a decompose plan (B18) is made from, read without
// locks: the line's oldest messages (at most domain.DecomposeMaxMessages;
// Truncated when it has more), the messages of its conversation that hold a
// chapter cut, its main line's tags, the tags the tenant's unarchived main
// lines use (B18.1: kept as they are when the tags are cleaned; a tag only
// on archived lines is not among them, like GET /lines/organization) and the
// related main lines of the tenant (sharing a tag or the main line's
// non-empty folder).
type DecomposeBase struct {
	LineID        string
	Title         string
	RootLineID    string
	Messages      []domain.Message
	Truncated     bool
	CutMessageIDs map[string]bool
	Tags          []string
	TenantTags    []string
	Related       []domain.RelatedLine
}

// DecomposeBase reads a line's decompose base (any line of the tenant; the
// folder, tags and related lines are its main line's).
func (s *Store) DecomposeBase(ctx context.Context, tenant, lineID string) (DecomposeBase, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return DecomposeBase{}, err
	}
	rootID, err := rootOf(ctx, s.q, line.ID)
	if err != nil {
		return DecomposeBase{}, err
	}
	root := line
	if rootID != line.ID {
		if root, err = s.lineRow(ctx, s.q, tenant, rootID.String()); err != nil {
			return DecomposeBase{}, err
		}
	}
	rows, err := s.q.ListMessagesAfterSeq(ctx, db.ListMessagesAfterSeqParams{LineID: line.ID, AfterSeq: 0, RowLimit: domain.DecomposeMaxMessages + 1})
	if err != nil {
		return DecomposeBase{}, fmt.Errorf("list messages: %w", err)
	}
	out := DecomposeBase{LineID: line.ID.String(), Title: line.Title, RootLineID: rootID.String(), Tags: tagsOf(root.Tags), CutMessageIDs: map[string]bool{}}
	if len(rows) > domain.DecomposeMaxMessages {
		rows, out.Truncated = rows[:domain.DecomposeMaxMessages], true
	}
	out.Messages = messagesFromRows(rows)
	cuts, err := s.chapterCuts(ctx, rootID)
	if err != nil {
		return DecomposeBase{}, err
	}
	for _, cut := range cuts {
		out.CutMessageIDs[cut.MessageID] = true
	}
	if out.Related, err = s.relatedLines(ctx, root); err != nil {
		return DecomposeBase{}, err
	}
	used, err := s.q.ListTenantTags(ctx, tenant)
	if err != nil {
		return DecomposeBase{}, fmt.Errorf("list tenant tags: %w", err)
	}
	out.TenantTags = make([]string, 0, len(used))
	for _, row := range used {
		out.TenantTags = append(out.TenantTags, row.Tag)
	}
	return out, nil
}

// relatedLines are the tenant's other main lines that share a tag or the
// non-empty folder of root (not archived), most shared tags first.
func (s *Store) relatedLines(ctx context.Context, root db.TangentLine) ([]domain.RelatedLine, error) {
	out := []domain.RelatedLine{}
	tags := tagsOf(root.Tags)
	if len(tags) == 0 && root.Folder == "" {
		return out, nil
	}
	rows, err := s.q.ListRelatedMainLines(ctx, db.ListRelatedMainLinesParams{
		TenantID: root.TenantID, LineID: root.ID, Tags: tags, Folder: root.Folder, RowLimit: domain.DecomposeMaxRelated,
	})
	if err != nil {
		return nil, fmt.Errorf("list related lines: %w", err)
	}
	for _, row := range rows {
		out = append(out, domain.RelatedLine{LineID: row.ID.String(), Title: row.Title, Folder: row.Folder, SharedTags: tagsOf(row.SharedTags)})
	}
	return out, nil
}
