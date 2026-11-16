package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B10 part B routes: diverging into sibling branches, comparing them
// and deciding (diverge).

func (a *api) p3bRoutes() []route {
	return []route{
		{pattern: "POST /lines/{id}/diverge", write: true, op: OpDivergeStart, feature: tangent.FeatureDiverge, serve: a.diverge},
		{pattern: "POST /lines/{id}/converge", write: true, op: OpComparisonsCreate, feature: tangent.FeatureDiverge, serve: a.converge},
		{pattern: "GET /lines/{id}/comparisons", feature: tangent.FeatureDiverge, serve: a.listComparisons},
		{pattern: "GET /comparisons/{cid}", feature: tangent.FeatureDiverge, serve: a.getComparison},
		{pattern: "POST /comparisons/{cid}/decide", write: true, op: OpComparisonsDecide, feature: tangent.FeatureDiverge, serve: a.decide},
	}
}

// divergeBody is POST /lines/{id}/diverge.
type divergeBody struct {
	AnchorMessageID string `json:"anchorMessageId"`
	Count           int    `json:"count"`
}

// diverge is 202 with the diverge job (its branches open when it finishes).
func (a *api) diverge(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in divergeBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	job, err := a.engine.StartDiverge(c.ctx, c.scope, id, tangent.DivergeInput{AnchorMessageID: in.AnchorMessageID, Count: in.Count}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return a.dispatchStarted(c, job)
}

// convergeBody is POST /lines/{id}/converge ({id} is the parent).
type convergeBody struct {
	LineIDs  []string `json:"lineIds"`
	Criteria []string `json:"criteria"`
}

type comparisonCreated struct {
	Comparison domain.Comparison `json:"comparison"`
	Job        jobStarted        `json:"job"`
}

// converge is 201 with the drafting comparison and its job (handed to the
// dispatcher; a job it refuses fails the comparison and answers 503).
func (a *api) converge(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in convergeBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	started, err := a.engine.Converge(c.ctx, c.scope, id, tangent.ConvergeInput{LineIDs: in.LineIDs, Criteria: in.Criteria}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	if _, _, err := a.dispatchStarted(c, started.Job); err != nil {
		return 0, nil, err
	}
	job := started.Job
	return http.StatusCreated, comparisonCreated{Comparison: started.Comparison, Job: jobStarted{JobID: job.ID, Kind: job.Kind, LineID: job.LineID, Provider: job.Provider, Model: job.Model}}, nil
}

type comparisonList struct {
	LineID      string              `json:"lineId"`
	RootLineID  string              `json:"rootLineId"`
	Comparisons []domain.Comparison `json:"comparisons"`
	Limits      comparisonLimitsJS  `json:"limits"`
}

type comparisonLimitsJS struct {
	MinOptions  int `json:"minOptions"`
	MaxOptions  int `json:"maxOptions"`
	MaxCriteria int `json:"maxCriteria"`
}

func (a *api) listComparisons(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	list, err := a.engine.ListComparisons(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	l := a.limits.Diverge
	return http.StatusOK, comparisonList{LineID: list.LineID, RootLineID: list.RootLineID, Comparisons: list.Comparisons, Limits: comparisonLimitsJS{
		MinOptions: l.MinCount, MaxOptions: l.MaxCount, MaxCriteria: l.CriteriaMax,
	}}, nil
}

type comparisonView struct {
	Comparison domain.Comparison `json:"comparison"`
}

func (a *api) getComparison(c *call) (int, any, error) {
	id, err := c.pathID("cid", domain.ErrComparisonNotFound)
	if err != nil {
		return 0, nil, err
	}
	comparison, err := a.engine.GetComparison(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, comparisonView{Comparison: comparison}, nil
}

// decideBody is POST /comparisons/{cid}/decide.
type decideBody struct {
	LineID string `json:"lineId"`
	Line   string `json:"line"`
}

type decided struct {
	Comparison domain.Comparison   `json:"comparison"`
	Chosen     domain.BranchView   `json:"chosen"`
	Decision   domain.Leaf         `json:"decision"`
	Discarded  []domain.BranchView `json:"discarded"`
}

func (a *api) decide(c *call) (int, any, error) {
	id, err := c.pathID("cid", domain.ErrComparisonNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in decideBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	out, err := a.engine.DecideComparison(c.ctx, c.scope, id, tangent.DecideInput{LineID: in.LineID, Line: in.Line}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, decided{Comparison: out.Comparison, Chosen: out.Chosen, Decision: out.Decision, Discarded: list(out.Discarded)}, nil
}
