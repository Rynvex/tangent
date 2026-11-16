package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func (a *api) listBranches(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	includeAside, err := c.queryBool("includeAside")
	if err != nil {
		return 0, nil, err
	}
	branches, err := a.engine.ListBranches(c.ctx, c.scope, id, includeAside)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, branchList{Branches: list(branches)}, nil
}

// branchBody is POST /lines/{id}/branches.
type branchBody struct {
	AnchorMessageID     string          `json:"anchorMessageId"`
	Purpose             string          `json:"purpose"`
	Kind                string          `json:"kind"`
	Excerpt             string          `json:"excerpt"`
	Provider            string          `json:"provider"`
	Model               string          `json:"model"`
	ConfirmDeeper       bool            `json:"confirmDeeper"`
	IncludeLater        bool            `json:"includeLater"`
	SuggestionMessageID string          `json:"suggestionMessageId"`
	HostMeta            json.RawMessage `json:"hostMeta"`
	// Keep keeps a new aside from the purge from the start (B23).
	Keep bool `json:"keep"`
}

func (a *api) createBranch(c *call) (int, any, error) {
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
	meta, err := c.hostMeta()
	if err != nil {
		return 0, nil, err
	}
	created, err := a.engine.CreateBranch(c.ctx, c.scope, id, tangent.BranchInput{
		AnchorMessageID: in.AnchorMessageID, Purpose: in.Purpose, Excerpt: in.Excerpt, Kind: in.Kind, Provider: in.Provider,
		Model: in.Model, ConfirmDeeper: in.ConfirmDeeper, IncludeLater: in.IncludeLater, SuggestionMessageID: in.SuggestionMessageID,
		HostMeta: meta, Keep: in.Keep,
	}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, createdBranch{Line: created.Line, Branch: created.Branch, Pack: created.Pack}, nil
}

// moveBody is POST /lines/{id}/branches/move.
type moveBody struct {
	Count         int             `json:"count"`
	Purpose       string          `json:"purpose"`
	Kind          string          `json:"kind"`
	Provider      string          `json:"provider"`
	Model         string          `json:"model"`
	ConfirmDeeper bool            `json:"confirmDeeper"`
	HostMeta      json.RawMessage `json:"hostMeta"`
}

func (a *api) moveToBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in moveBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if hasHostMeta(in.HostMeta) {
		return 0, nil, errHostMeta
	}
	meta, err := c.hostMeta()
	if err != nil {
		return 0, nil, err
	}
	moved, err := a.engine.MoveToBranch(c.ctx, c.scope, id, tangent.MoveInput{
		Count: in.Count, Purpose: in.Purpose, Kind: in.Kind, Provider: in.Provider, Model: in.Model, ConfirmDeeper: in.ConfirmDeeper,
		HostMeta: meta,
	}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, movedBranch{
		Line: moved.Line, Branch: moved.Branch, Marker: moved.Marker, SourceLineID: moved.SourceLineID, RootLineID: moved.RootLineID,
		MovedMessageIDs: list(moved.MovedMessageIDs), Reparented: list(moved.Reparented), SummaryReset: moved.SummaryReset,
	}, nil
}

func (a *api) getBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	detail, err := a.engine.GetBranch(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, detail, nil
}

// mergeBody is POST /lines/{id}/branch/merge. The card is decoded strictly
// on its own (unknown or duplicate fields are refused).
type mergeBody struct {
	Card               json.RawMessage     `json:"card"`
	ParentTipMessageID string              `json:"parentTipMessageId"`
	ConfirmParentMoved bool                `json:"confirmParentMoved"`
	NoteChanges        []domain.NoteChange `json:"noteChanges"`
}

func (a *api) mergeBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in mergeBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	card, err := domain.DecodeBranchCardJSON(in.Card)
	if err != nil {
		return 0, nil, domain.CardError([]domain.BranchCardProblem{{Field: "card", Message: err.Error()}})
	}
	merged, err := a.engine.MergeBranch(c.ctx, c.scope, id, tangent.MergeInput{
		Card: card, ParentTipMessageID: in.ParentTipMessageID, ConfirmParentMoved: in.ConfirmParentMoved, NoteChanges: in.NoteChanges,
	}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	body := mergedBranch{Branch: merged.Branch, Message: merged.Card, Line: merged.Parent}
	if len(in.NoteChanges) > 0 {
		body.Notes = &notesWrite{
			RootLineID: merged.Notes.RootLineID, Revision: merged.Notes.Revision,
			Created: list(merged.Notes.Created), Superseded: list(merged.Notes.Superseded),
		}
	}
	return http.StatusOK, body, nil
}

// discardBody is POST /lines/{id}/branch/discard (optional): leaf (the leaf
// feature) is the branch's dead-end leaf, kind dead_end by default.
type discardBody struct {
	Leaf *leafBody `json:"leaf"`
}

func (a *api) discardBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in discardBody
	if err := c.body(&in, false); err != nil {
		return 0, nil, err
	}
	discard := tangent.DiscardInput{}
	if in.Leaf != nil {
		leaf := in.Leaf.input()
		discard.Leaf = &leaf
	}
	view, err := a.engine.DiscardBranchWith(c.ctx, c.scope, id, discard, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, discardedBranch{Branch: view}, nil
}

// promoteBody is POST /lines/{id}/branch/promote: the operator confirms,
// strictly validated.
type promoteBody struct {
	Confirm bool `json:"confirm"`
}

func (a *api) promoteBranch(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in promoteBody
	if err := c.body(&in, false); err != nil {
		return 0, nil, err
	}
	if !in.Confirm {
		return 0, nil, invalid("promoting rewrites the main line; send {\"confirm\": true}")
	}
	promoted, err := a.engine.PromoteBranch(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, promotedBranch{
		Branch: promoted.Promoted, PreviousMainLine: promoted.Previous, Line: promoted.Main, Reparented: list(promoted.Reparented),
	}, nil
}
