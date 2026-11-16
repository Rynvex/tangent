package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// branchPageInfo is what a page of lines needs from the branch tables.
type branchPageInfo struct {
	refs   map[uuid.UUID]domain.BranchRef
	counts map[uuid.UUID]domain.BranchCounts
	unread map[uuid.UUID]int
	review map[uuid.UUID]int
	inbox  map[uuid.UUID]db.CountOpenInboxRow
}

func (s *Store) hydrateOne(ctx context.Context, q *db.Queries, row db.TangentLine) (domain.LineView, error) {
	views, err := s.hydrate(ctx, q, []db.TangentLine{row})
	if err != nil {
		return domain.LineView{}, err
	}
	return views[0], nil
}

// hydrate turns line rows into views: the branch record, the direct branch
// counts, the unread messages of open branches below and how many of them
// await review. Three grouped
// queries per page; a failed query fails the page, since zero counts would
// read as "no branches".
func (s *Store) hydrate(ctx context.Context, q *db.Queries, rows []db.TangentLine) ([]domain.LineView, error) {
	out := make([]domain.LineView, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	info, err := s.loadBranchPageInfo(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		view := domain.LineView{
			Line: lineFromRow(row), BranchCounts: info.counts[row.ID], BranchUnread: info.unread[row.ID], AwaitingReview: info.review[row.ID],
		}
		if ref, ok := info.refs[row.ID]; ok {
			view.ConversationBranch = &ref
		} else {
			inbox := info.inbox[row.ID]
			view.OpenSuggestions, view.OpenSeeds, view.StaleBranches = int(inbox.Suggestions), int(inbox.Seeds), int(inbox.StaleBranches)
		}
		out = append(out, view)
	}
	return out, s.markSpunOffSources(ctx, q, out)
}

// markSpunOffSources sets SpunOffFrom.Available on the spun-off lines among
// views: whether the source line still exists for the same tenant.
func (s *Store) markSpunOffSources(ctx context.Context, q *db.Queries, views []domain.LineView) error {
	refs := []*domain.SpunOffRef{}
	for i := range views {
		if views[i].SpunOffFrom != nil {
			refs = append(refs, views[i].SpunOffFrom)
		}
	}
	if len(refs) == 0 {
		return nil
	}
	tenants, err := lineTenants(ctx, q, refs)
	if err != nil {
		return err
	}
	for i := range views {
		if ref := views[i].SpunOffFrom; ref != nil {
			ref.Available = tenants[ref.LineID] == views[i].TenantID
		}
	}
	return nil
}

// lineTenants maps the referenced lines that exist to their tenants.
func lineTenants(ctx context.Context, q *db.Queries, refs []*domain.SpunOffRef) (map[string]string, error) {
	ids := make([]uuid.UUID, 0, len(refs))
	for _, ref := range refs {
		if id, ok := parseID(ref.LineID); ok {
			ids = append(ids, id)
		}
	}
	rows, err := q.GetLinesByIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("find spun-off lines: %w", err)
	}
	out := make(map[string]string, len(rows))
	for _, row := range rows {
		out[row.ID.String()] = row.TenantID
	}
	return out, nil
}

func (s *Store) loadBranchPageInfo(ctx context.Context, q *db.Queries, ids []uuid.UUID) (branchPageInfo, error) {
	info := branchPageInfo{
		refs: map[uuid.UUID]domain.BranchRef{}, counts: map[uuid.UUID]domain.BranchCounts{}, unread: map[uuid.UUID]int{}, review: map[uuid.UUID]int{},
		inbox: map[uuid.UUID]db.CountOpenInboxRow{},
	}
	refs, err := q.ListBranchesByLineIDs(ctx, ids)
	if err != nil {
		return info, fmt.Errorf("load branch refs: %w", err)
	}
	for _, ref := range refs {
		info.refs[ref.LineID] = branchRefFromRow(ref)
	}
	counts, err := q.CountBranchesByParents(ctx, ids)
	if err != nil {
		return info, fmt.Errorf("count branches: %w", err)
	}
	for _, count := range counts {
		info.counts[count.ParentLineID] = info.counts[count.ParentLineID].Add(count.Status, int(count.BranchCount))
	}
	unread, err := q.ListBranchUnreadByAncestors(ctx, db.ListBranchUnreadByAncestorsParams{LineIds: ids, MaxDepth: s.depthGuard()})
	if err != nil {
		return info, fmt.Errorf("load branch unread: %w", err)
	}
	for _, item := range unread {
		info.unread[item.AncestorID] = int(item.Unread)
		info.review[item.AncestorID] = int(item.AwaitingReview)
	}
	return info, s.loadInbox(ctx, q, ids, info)
}

// loadInbox counts the open suggestions, seeds and stale branches of the main lines among
// ids (a branch has no rows of its own); suggestions only of the features
// WithInboxFeatures named, when the context carries them.
func (s *Store) loadInbox(ctx context.Context, q *db.Queries, ids []uuid.UUID, info branchPageInfo) error {
	roots := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if _, isBranch := info.refs[id]; !isBranch {
			roots = append(roots, id)
		}
	}
	if len(roots) == 0 {
		return nil
	}
	features, filter := inboxFeatures(ctx)
	rows, err := q.CountOpenInbox(ctx, db.CountOpenInboxParams{
		LineIds: roots, Filter: filter, Features: features, IdleBefore: s.now().Add(-s.limits.OpenLoops.StaleAfter),
	})
	if err != nil {
		return fmt.Errorf("count open suggestions and seeds: %w", err)
	}
	for _, row := range rows {
		info.inbox[row.RootLineID] = row
	}
	return nil
}

// hydrateIDs loads and hydrates lines by id, in the given order; ids that no
// longer exist are skipped.
func (s *Store) hydrateIDs(ctx context.Context, q *db.Queries, ids []uuid.UUID) ([]domain.LineView, error) {
	rows, err := q.GetLinesByIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("load lines: %w", err)
	}
	byID := make(map[uuid.UUID]db.TangentLine, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	ordered := make([]db.TangentLine, 0, len(ids))
	for _, id := range ids {
		if row, ok := byID[id]; ok {
			ordered = append(ordered, row)
		}
	}
	return s.hydrate(ctx, q, ordered)
}

// depthGuard bounds the recursive tree queries: no branch is deeper than the
// hard limit, so a walk that goes further can only be following a corrupt
// (cyclic) parent chain.
func (s *Store) depthGuard() int32 { return int32(s.limits.Branch.HardMaxDepth + 1) }

// subtreesIDs lists every line below any of the lines, depth-guarded, in
// one walk.
func (s *Store) subtreesIDs(ctx context.Context, q *db.Queries, below []uuid.UUID) ([]uuid.UUID, error) {
	if len(below) == 0 {
		return nil, nil
	}
	ids, err := q.ListSubtreesLineIDs(ctx, db.ListSubtreesLineIDsParams{ParentLineIds: below, MaxDepth: s.depthGuard()})
	if err != nil {
		return nil, fmt.Errorf("list subtrees: %w", err)
	}
	return ids, nil
}

// subtreeIDs lists every line below a line, depth-guarded.
func (s *Store) subtreeIDs(ctx context.Context, q *db.Queries, below uuid.UUID) ([]uuid.UUID, error) {
	ids, err := q.ListSubtreeLineIDs(ctx, db.ListSubtreeLineIDsParams{ParentLineID: below, MaxDepth: s.depthGuard()})
	if err != nil {
		return nil, fmt.Errorf("list subtree: %w", err)
	}
	return ids, nil
}

// inboxKey carries the features whose suggestions a LineView counts.
type inboxKey struct{}

// WithInboxFeatures makes the line views read with ctx count only the open
// suggestions of these features (the ones on for the caller); without it
// they count every open suggestion.
func WithInboxFeatures(ctx context.Context, features []string) context.Context {
	return context.WithValue(ctx, inboxKey{}, append([]string{}, features...))
}

func inboxFeatures(ctx context.Context) ([]string, bool) {
	features, ok := ctx.Value(inboxKey{}).([]string)
	return features, ok
}
