package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/tangent"
)

// The B15 routes: a tree's draft argument tags in one read (ibis).

func (a *api) b15Routes() []route {
	return []route{
		{pattern: "GET /lines/{id}/tag-drafts", feature: tangent.FeatureIbis, serve: a.listTagDrafts},
	}
}

// listTagDrafts is GET /lines/{id}/tag-drafts: the draft tags of the tree
// of any of its lines; read-only callers may ask.
func (a *api) listTagDrafts(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	out, err := a.engine.ListTagDrafts(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, out, nil
}
