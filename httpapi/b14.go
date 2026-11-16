package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B14 routes: a whole conversation in one read (core), a diverge
// across models (diverge) and parking a batch of thoughts (parking).

func (a *api) b14Routes() []route {
	return []route{
		{pattern: "GET /lines/{id}/export", serve: a.exportTree},
		{pattern: "POST /lines/{id}/diverge/models", write: true, op: OpDivergeModels, feature: tangent.FeatureDiverge, serve: a.divergeModels},
		{pattern: "POST /lines/{id}/seeds/batch", write: true, op: OpSeedsBatch, feature: tangent.FeatureParking, serve: a.createSeeds},
	}
}

// exportTree is GET /lines/{id}/export: the whole conversation of any of
// its lines; read-only callers may ask.
func (a *api) exportTree(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	out, err := a.engine.ExportTree(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, out, nil
}

// divergeTargetBody is one target of POST /lines/{id}/diverge/models.
type divergeTargetBody struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Purpose  string `json:"purpose"`
}

// divergeModelsBody is POST /lines/{id}/diverge/models ({id} is the parent).
type divergeModelsBody struct {
	AnchorMessageID string              `json:"anchorMessageId"`
	Purpose         string              `json:"purpose"`
	Excerpt         string              `json:"excerpt"`
	ConfirmDeeper   bool                `json:"confirmDeeper"`
	Targets         []divergeTargetBody `json:"targets"`
}

type divergedModels struct {
	ParentLineID string                  `json:"parentLineId"`
	RootLineID   string                  `json:"rootLineId"`
	Branches     []tangent.CreatedBranch `json:"branches"`
}

// divergeModels is 201 with the branches it opened, in the targets' order.
func (a *api) divergeModels(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in divergeModelsBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	targets := make([]tangent.DivergeTarget, 0, len(in.Targets))
	for _, t := range in.Targets {
		targets = append(targets, tangent.DivergeTarget{Provider: t.Provider, Model: t.Model, Purpose: t.Purpose})
	}
	out, err := a.engine.DivergeModels(c.ctx, c.scope, id, tangent.DivergeModelsInput{
		AnchorMessageID: in.AnchorMessageID, Purpose: in.Purpose, Excerpt: in.Excerpt, ConfirmDeeper: in.ConfirmDeeper, Targets: targets,
	}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, divergedModels{ParentLineID: out.ParentLineID, RootLineID: out.RootLineID, Branches: out.Branches}, nil
}

// seedsBody is POST /lines/{id}/seeds/batch.
type seedsBody struct {
	Texts           []string `json:"texts"`
	AnchorMessageID string   `json:"anchorMessageId"`
}

type seedsCreated struct {
	RootLineID string        `json:"rootLineId"`
	Seeds      []domain.Seed `json:"seeds"`
}

// createSeeds is 201 with the parked seeds, in the order of the texts.
func (a *api) createSeeds(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in seedsBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	created, err := a.engine.CreateSeeds(c.ctx, c.scope, id, tangent.SeedsInput{Texts: in.Texts, AnchorMessageID: in.AnchorMessageID}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, seedsCreated{RootLineID: created.RootLineID, Seeds: list(created.Seeds)}, nil
}
