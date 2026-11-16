package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B17 routes: dismissing a whole inbox at once (suggestions) and
// editing the conclusion card of a merged branch (core).

func (a *api) b17Routes() []route {
	return []route{
		{pattern: "POST /lines/{id}/suggestions/dismiss-all", write: true, op: OpSuggestionsDismissAll, feature: tangent.FeatureSuggestions, serve: a.dismissAllSuggestions},
		{pattern: "PATCH /lines/{id}/branch/card", write: true, op: OpBranchesUpdateCard, serve: a.updateBranchCard},
	}
}

// dismissAllSuggestions is POST /lines/{id}/suggestions/dismiss-all: every
// open suggestion of the tree, dismissed at once. The body is optional (an
// object, ignored).
func (a *api) dismissAllSuggestions(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var ignored struct{}
	if err := c.body(&ignored, false); err != nil {
		return 0, nil, err
	}
	dismissed, err := a.engine.DismissAllSuggestions(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, suggestionList{RootLineID: dismissed.RootLineID, Suggestions: list(dismissed.Suggestions)}, nil
}

// cardBody is PATCH /lines/{id}/branch/card: the edited card, decoded as
// strictly as a merge's.
type cardBody struct {
	Card json.RawMessage `json:"card"`
}

// updatedCard is the answer of a card edit: the branch and the card
// message on the line it was brought back to.
type updatedCard struct {
	Branch  domain.BranchView `json:"branch"`
	Message domain.Message    `json:"message"`
}

func (a *api) updateBranchCard(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in cardBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	card, err := domain.DecodeBranchCardJSON(in.Card)
	if err != nil {
		return 0, nil, domain.CardError([]domain.BranchCardProblem{{Field: "card", Message: err.Error()}})
	}
	updated, err := a.engine.UpdateBranchCard(c.ctx, c.scope, id, card, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, updatedCard{Branch: updated.Branch, Message: updated.Message}, nil
}
