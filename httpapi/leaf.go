package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
)

// Leaf routes (the leaf feature). {id} is a branch line; a main line has
// no leaf (branch_not_found).

type leafView struct {
	// Leaf is null while the branch has none.
	Leaf *domain.Leaf `json:"leaf"`
	// DraftError is why the branch's newest leaf draft failed (only after
	// the leaf was last written).
	DraftError *domain.LeafDraftError `json:"draftError,omitempty"`
}

type leafWritten struct {
	Leaf domain.Leaf `json:"leaf"`
}

// leafBody is PUT /lines/{id}/leaf and the leaf of a discard.
type leafBody struct {
	Kind string `json:"kind"`
	Line string `json:"line"`
	Body string `json:"body"`
}

func (b leafBody) input() domain.LeafInput {
	return domain.LeafInput{Kind: b.Kind, Line: b.Line, Body: b.Body}
}

func (a *api) getLeaf(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	state, err := a.engine.GetLeafState(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, leafView{Leaf: state.Leaf, DraftError: state.DraftError}, nil
}

// putLeaf is PUT /lines/{id}/leaf {kind, line, body?}: the operator writes
// or confirms the leaf.
func (a *api) putLeaf(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in leafBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	leaf, err := a.engine.PutLeaf(c.ctx, c.scope, id, in.input(), c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, leafWritten{Leaf: leaf}, nil
}

func (a *api) deleteLeaf(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	if _, err := a.engine.DeleteLeaf(c.ctx, c.scope, id, c.tx()...); err != nil {
		return 0, nil, err
	}
	return http.StatusNoContent, nil, nil
}

// draftLeaf is POST /lines/{id}/leaf/draft: 202 with the job (any mode).
func (a *api) draftLeaf(c *call) (int, any, error) {
	return a.startJob(c, a.engine.StartLeafDraft)
}
