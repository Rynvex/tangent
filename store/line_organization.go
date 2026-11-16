package store

import (
	"context"
	"fmt"

	"github.com/Rynvex/tangent/domain"
)

// TenantOrganization reads the tenant's folders and tags over all its main
// lines (B18.1), without locks: every non-empty folder with its active and
// archived main lines, and every tag of an unarchived main line with how
// many carry it. Both lists are non-nil.
func (s *Store) TenantOrganization(ctx context.Context, tenant string) (domain.TenantOrganization, error) {
	folders, err := s.q.ListTenantFolders(ctx, tenant)
	if err != nil {
		return domain.TenantOrganization{}, fmt.Errorf("list folders: %w", err)
	}
	tags, err := s.q.ListTenantTags(ctx, tenant)
	if err != nil {
		return domain.TenantOrganization{}, fmt.Errorf("list tags: %w", err)
	}
	out := domain.TenantOrganization{Folders: make([]domain.FolderSummary, 0, len(folders)), Tags: make([]domain.TagSummary, 0, len(tags))}
	for _, row := range folders {
		out.Folders = append(out.Folders, domain.FolderSummary{Folder: row.Folder, Active: int(row.ActiveCount), Archived: int(row.ArchivedCount)})
	}
	for _, row := range tags {
		out.Tags = append(out.Tags, domain.TagSummary{Tag: row.Tag, Count: int(row.LineCount)})
	}
	return out, nil
}
