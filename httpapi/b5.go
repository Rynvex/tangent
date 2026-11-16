package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// searchResult is GET /search.
type searchResult struct {
	Query string             `json:"query"`
	Hits  []domain.SearchHit `json:"hits"`
}

// search is GET /search?q=&limit=1..50&archived=&root=.
func (a *api) search(c *call) (int, any, error) {
	limit, err := c.queryInt("limit", 1, domain.SearchMaxLimit)
	if err != nil {
		return 0, nil, err
	}
	archived, err := c.queryBool("archived")
	if err != nil {
		return 0, nil, err
	}
	query := c.r.URL.Query().Get("q")
	hits, err := a.engine.Search(c.ctx, c.scope, tangent.SearchInput{Query: query, Limit: int(limit), Archived: archived, Root: c.r.URL.Query().Get("root")})
	if err != nil {
		return 0, nil, err
	}
	normalized, _ := domain.NormalizeSearchQuery(query)
	return http.StatusOK, searchResult{Query: normalized, Hits: list(hits)}, nil
}

// previewBranch is POST /lines/{id}/branches/preview: the pack a branch
// would start from, with the body of POST /branches; nothing is written,
// so read-only callers may ask.
func (a *api) previewBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in branchBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if hasHostMeta(in.HostMeta) {
		return 0, nil, errHostMeta
	}
	preview, err := a.engine.PreviewBranch(c.ctx, c.scope, id, tangent.BranchInput{
		AnchorMessageID: in.AnchorMessageID, Purpose: in.Purpose, Excerpt: in.Excerpt, Kind: in.Kind, IncludeLater: in.IncludeLater,
	})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, preview, nil
}

// renameBody is PATCH /lines/{id}/branch.
type renameBody struct {
	Purpose *string `json:"purpose"`
}

// renameBranch is PATCH /lines/{id}/branch {purpose}: an open branch gets
// a new purpose.
func (a *api) renameBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in renameBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if in.Purpose == nil {
		return 0, nil, invalid("purpose is required")
	}
	view, err := a.engine.RenameBranch(c.ctx, c.scope, id, *in.Purpose, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, renamedBranch{Branch: view}, nil
}

type renamedBranch struct {
	Branch domain.BranchView `json:"branch"`
}
