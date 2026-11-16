package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B10 part A routes: argument tags (ibis) and folds (fold).

func (a *api) p3Routes() []route {
	return []route{
		{pattern: "PUT /messages/{mid}/tag", write: true, op: OpMessagesTag, feature: tangent.FeatureIbis, serve: a.tagMessage},
		{pattern: "DELETE /messages/{mid}/tag", write: true, op: OpMessagesUntag, feature: tangent.FeatureIbis, serve: a.untagMessage},
		{pattern: "GET /lines/{id}/folds", feature: tangent.FeatureFold, serve: a.listFolds},
		{pattern: "POST /lines/{id}/folds", write: true, op: OpFoldsCreate, feature: tangent.FeatureFold, serve: a.createFold},
		{pattern: "PATCH /folds/{fid}", write: true, op: OpFoldsUpdate, feature: tangent.FeatureFold, serve: a.updateFold},
		{pattern: "DELETE /folds/{fid}", write: true, op: OpFoldsDelete, feature: tangent.FeatureFold, serve: a.deleteFold},
	}
}

// tagBody is PUT /messages/{mid}/tag: status is confirmed (absent too) or
// draft (B15).
type tagBody struct {
	Kind   string `json:"kind"`
	Status string `json:"status"`
}

func (a *api) tagMessage(c *call) (int, any, error) {
	id, err := c.pathID("mid", domain.ErrMessageNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in tagBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	message, err := a.engine.SetMessageTag(c.ctx, c.scope, id, tangent.TagInput{Kind: in.Kind, Status: in.Status}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, messageView{Message: message}, nil
}

func (a *api) untagMessage(c *call) (int, any, error) {
	id, err := c.pathID("mid", domain.ErrMessageNotFound)
	if err != nil {
		return 0, nil, err
	}
	message, err := a.engine.UntagMessage(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, messageView{Message: message}, nil
}

type foldList struct {
	LineID     string        `json:"lineId"`
	RootLineID string        `json:"rootLineId"`
	Folds      []domain.Fold `json:"folds"`
	Limits     foldLimitsJS  `json:"limits"`
}

type foldLimitsJS struct {
	SummaryMaxRunes  int `json:"summaryMaxRunes"`
	MinMessages      int `json:"minMessages"`
	MaxMessages      int `json:"maxMessages"`
	MaxActivePerLine int `json:"maxActivePerLine"`
}

func (a *api) listFolds(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	folds, err := a.engine.ListFolds(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	l := a.limits.Fold
	return http.StatusOK, foldList{LineID: folds.LineID, RootLineID: folds.RootLineID, Folds: list(folds.Folds), Limits: foldLimitsJS{
		SummaryMaxRunes: l.SummaryMaxRunes, MinMessages: l.MinMessages, MaxMessages: l.MaxMessages, MaxActivePerLine: l.MaxActivePerLine,
	}}, nil
}

// foldBody is POST /lines/{id}/folds; no summary asks a model to draft one.
type foldBody struct {
	FromMessageID string `json:"fromMessageId"`
	ToMessageID   string `json:"toMessageId"`
	Summary       string `json:"summary"`
}

type foldCreated struct {
	Fold domain.Fold `json:"fold"`
	Job  *jobStarted `json:"job"`
}

// createFold is 201 with the fold and, for a draft, its summary job (handed
// to the dispatcher; a job it refuses fails the draft and answers 503).
func (a *api) createFold(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in foldBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	created, err := a.engine.CreateFold(c.ctx, c.scope, id, tangent.FoldInput{FromMessageID: in.FromMessageID, ToMessageID: in.ToMessageID, Summary: in.Summary}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	out := foldCreated{Fold: created.Fold}
	if job := created.Job; job != nil {
		if _, _, err := a.dispatchStarted(c, *job); err != nil {
			return 0, nil, err
		}
		out.Job = &jobStarted{JobID: job.ID, Kind: job.Kind, LineID: job.LineID, Provider: job.Provider, Model: job.Model}
	}
	return http.StatusCreated, out, nil
}

type foldView struct {
	Fold domain.Fold `json:"fold"`
}

// updateFold is PATCH /folds/{fid}: the operator's summary.
func (a *api) updateFold(c *call) (int, any, error) {
	id, err := c.pathID("fid", domain.ErrFoldNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in struct {
		Summary string `json:"summary"`
	}
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	fold, err := a.engine.UpdateFold(c.ctx, c.scope, id, in.Summary, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, foldView{Fold: fold}, nil
}

func (a *api) deleteFold(c *call) (int, any, error) {
	id, err := c.pathID("fid", domain.ErrFoldNotFound)
	if err != nil {
		return 0, nil, err
	}
	if _, err := a.engine.RemoveFold(c.ctx, c.scope, id, c.tx()...); err != nil {
		return 0, nil, err
	}
	return http.StatusNoContent, nil, nil
}
