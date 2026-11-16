package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Seed routes (the parking feature). {id} is any line of the conversation;
// {sid} a seed id.

type seedList struct {
	RootLineID string        `json:"rootLineId"`
	Seeds      []domain.Seed `json:"seeds"`
	Limits     seedLimits    `json:"limits"`
}

// seedLimits are the parking bounds (domain.Limits.Parking).
type seedLimits struct {
	// MaxOpen caps the open seeds of one conversation; MaxRunes one seed's text.
	MaxOpen  int `json:"maxOpen"`
	MaxRunes int `json:"maxRunes"`
}

type seedView struct {
	Seed domain.Seed `json:"seed"`
}

type seedExpanded struct {
	Seed   domain.Seed       `json:"seed"`
	Line   domain.LineView   `json:"line"`
	Branch domain.BranchView `json:"branch"`
	Pack   domain.BranchPack `json:"pack"`
}

type seedNoted struct {
	Seed       domain.Seed `json:"seed"`
	Note       domain.Note `json:"note"`
	Revision   int         `json:"revision"`
	RootLineID string      `json:"rootLineId"`
}

// listSeeds is GET /lines/{id}/seeds?status=: the tree's open seeds unless
// status names others (comma separated, or "all").
func (a *api) listSeeds(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	statuses := c.queryList("status", []string{domain.SeedStatusOpen, domain.SeedStatusExpanded, domain.SeedStatusNoted, domain.SeedStatusDropped})
	seeds, err := a.engine.ListSeeds(c.ctx, c.scope, id, statuses)
	if err != nil {
		return 0, nil, err
	}
	l := a.limits.Parking
	return http.StatusOK, seedList{RootLineID: seeds.RootLineID, Seeds: list(seeds.Seeds), Limits: seedLimits{MaxOpen: l.MaxOpenPerTree, MaxRunes: l.TextMaxRunes}}, nil
}

// seedBody is POST /lines/{id}/seeds.
type seedBody struct {
	Text            string `json:"text"`
	AnchorMessageID string `json:"anchorMessageId"`
}

func (a *api) createSeed(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in seedBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	seed, err := a.engine.CreateSeed(c.ctx, c.scope, id, tangent.SeedInput{Text: in.Text, AnchorMessageID: in.AnchorMessageID}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, seedView{Seed: seed}, nil
}

// expandBody is POST /seeds/{sid}/expand.
type expandBody struct {
	Purpose       string `json:"purpose"`
	Kind          string `json:"kind"`
	ConfirmDeeper bool   `json:"confirmDeeper"`
}

func (a *api) expandSeed(c *call) (int, any, error) {
	id, err := c.pathID("sid", domain.ErrSeedNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in expandBody
	if err := c.body(&in, false); err != nil {
		return 0, nil, err
	}
	expanded, err := a.engine.ExpandSeed(c.ctx, c.scope, id, tangent.ExpandInput{Purpose: in.Purpose, Kind: in.Kind, ConfirmDeeper: in.ConfirmDeeper}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, seedExpanded{Seed: expanded.Seed, Line: expanded.Line, Branch: expanded.Branch, Pack: expanded.Pack}, nil
}

// toNoteBody is POST /seeds/{sid}/to-note.
type toNoteBody struct {
	Section string `json:"section"`
}

func (a *api) seedToNote(c *call) (int, any, error) {
	id, err := c.pathID("sid", domain.ErrSeedNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in toNoteBody
	if err := c.body(&in, false); err != nil {
		return 0, nil, err
	}
	noted, err := a.engine.NoteSeed(c.ctx, c.scope, id, in.Section, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	if len(noted.Notes.Created) == 0 {
		return 0, nil, invalid("the note was not written")
	}
	return http.StatusCreated, seedNoted{Seed: noted.Seed, Note: noted.Notes.Created[0], Revision: noted.Notes.Revision, RootLineID: noted.Notes.RootLineID}, nil
}

func (a *api) dropSeed(c *call) (int, any, error) {
	id, err := c.pathID("sid", domain.ErrSeedNotFound)
	if err != nil {
		return 0, nil, err
	}
	seed, err := a.engine.DropSeed(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, seedView{Seed: seed}, nil
}
