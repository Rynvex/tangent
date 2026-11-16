package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B23 routes: what happens to an aside after its answer (keep it,
// continue it as a branch; the aside feature) and deleting one ended branch
// (core).

func (a *api) b23Routes() []route {
	return []route{
		{pattern: "PUT /lines/{id}/branch/keep", write: true, op: OpBranchesKeep, feature: tangent.FeatureAside, serve: a.keepBranch},
		{pattern: "POST /lines/{id}/branch/continue", write: true, op: OpBranchesContinue, feature: tangent.FeatureAside, serve: a.continueAside},
		{pattern: "DELETE /lines/{id}/branch", write: true, op: OpBranchesDelete, serve: a.deleteBranch},
	}
}

// keepBody is PUT /lines/{id}/branch/keep; keep is required.
type keepBody struct {
	Keep *bool `json:"keep"`
}

// keptBranch is the answer of a keep: the aside as it is now.
type keptBranch struct {
	Branch domain.BranchView `json:"branch"`
}

func (a *api) keepBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in keepBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if in.Keep == nil {
		return 0, nil, domain.NewError(domain.CodeInvalidInput, "keep is required: true or false", map[string]any{"field": "keep"})
	}
	view, err := a.engine.KeepBranch(c.ctx, c.scope, id, *in.Keep, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, keptBranch{Branch: view}, nil
}

// continueBody is POST /lines/{id}/branch/continue (optional).
type continueBody struct {
	Purpose       string          `json:"purpose"`
	Kind          string          `json:"kind"`
	ConfirmDeeper bool            `json:"confirmDeeper"`
	HostMeta      json.RawMessage `json:"hostMeta"`
}

// continuedAside is the answer of a continue: the new branch, its line and
// the aside it replaced (which no longer exists).
type continuedAside struct {
	Branch         domain.BranchView `json:"branch"`
	Line           domain.LineView   `json:"line"`
	ReplacedLineID string            `json:"replacedLineId"`
}

func (a *api) continueAside(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in continueBody
	if err := c.body(&in, false); err != nil {
		return 0, nil, err
	}
	if hasHostMeta(in.HostMeta) {
		return 0, nil, errHostMeta
	}
	meta, err := c.hostMeta()
	if err != nil {
		return 0, nil, err
	}
	out, err := a.engine.ContinueAside(c.ctx, c.scope, id, tangent.ContinueAsideInput{
		Purpose: in.Purpose, Kind: in.Kind, ConfirmDeeper: in.ConfirmDeeper, HostMeta: meta,
	}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, continuedAside{Branch: out.Branch, Line: out.Line, ReplacedLineID: out.ReplacedLineID}, nil
}

func (a *api) deleteBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	deleted, err := a.engine.DeleteBranch(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, deletedTree{RootLineID: deleted.RootLineID, LineIDs: list(deleted.LineIDs)}, nil
}
