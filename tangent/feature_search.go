package tangent

import (
	"context"
	"strings"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// FeatureSearch is the search feature's name.
const FeatureSearch = "search"

// Search finds text across a tenant's conversations: main-line titles,
// branch purposes and finished operator and assistant messages. It needs
// the pg_trgm extension and its own migration: run store.MigrateFeatures(ctx,
// pool, "search") before New (New refuses otherwise). Off: Search returns
// feature_disabled.
func Search() Feature { return onOff(FeatureSearch, nil) }

// SearchInput is one search: Query is a case-insensitive substring of 2 to
// 200 characters; Limit defaults to 20 and is at most 50; Archived searches
// the archived conversations instead of the active ones. Root limits the
// search to one conversation (its main line's id; line_not_found for
// anything else), archived or not (Archived is ignored).
type SearchInput struct {
	Query    string
	Limit    int
	Archived bool
	Root     string
}

// Search returns the scope's hits for the query, best first (similarity,
// then recency), each with a snippet centred on its match.
func (e *Engine) Search(ctx context.Context, scope Scope, in SearchInput) ([]domain.SearchHit, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureSearch)
	if err != nil {
		return nil, err
	}
	query, err := domain.NormalizeSearchQuery(in.Query)
	if err != nil {
		return nil, err
	}
	root, err := e.searchRoot(ctx, scope, in.Root)
	if err != nil {
		return nil, err
	}
	rows, err := e.store.Search(ctx, store.SearchInput{Tenant: scope.Tenant, Query: query, Limit: in.Limit, Archived: in.Archived, RootLineID: root})
	if err != nil {
		return nil, err
	}
	hits := make([]domain.SearchHit, 0, len(rows))
	for _, row := range rows {
		snippet, highlights := domain.SearchSnippet(row.Text, query, domain.SearchSnippetRunes)
		hits = append(hits, domain.SearchHit{
			LineID: row.LineID, RootLineID: row.RootLineID, Kind: row.Kind, MessageID: row.MessageID, Seq: row.Seq, Role: row.Role,
			Snippet: snippet, Highlights: highlights, Score: row.Score, RootTitle: row.RootTitle, Purpose: row.Purpose, At: row.At,
		})
	}
	return hits, nil
}

// searchRoot checks a search's root: empty, or one of the scope's main
// lines (a branch is line_not_found).
func (e *Engine) searchRoot(ctx context.Context, scope Scope, root string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", nil
	}
	line, err := e.store.GetLine(ctx, scope.Tenant, root)
	if err != nil {
		return "", err
	}
	if line.ConversationBranch != nil {
		return "", domain.ErrLineNotFound
	}
	return line.ID, nil
}

// checkFeatureSchemaTimeout bounds New's check of the features that bring
// their own migrations.
const checkFeatureSchemaTimeout = 10 * time.Second

// featuresNeedingMigrations names the enabled features with migrations of
// their own (store.MigrateFeatures).
func featuresNeedingMigrations(r *registry) []string {
	var out []string
	for _, f := range r.features {
		if _, ok := store.FeatureExtension(f.Name()); ok {
			out = append(out, f.Name())
		}
	}
	return out
}
