package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Rynvex/tangent/domain"
)

// The suggestion inbox (mounted while a feature that raises suggestions is
// configured). {sid} is a suggestion id; the tenant check is the engine's.

type suggestionList struct {
	RootLineID  string              `json:"rootLineId"`
	Suggestions []domain.Suggestion `json:"suggestions"`
}

type suggestionDecided struct {
	Suggestion domain.Suggestion `json:"suggestion"`
	// Result is what the accepted suggestion's action returned (accept only).
	Result any `json:"result,omitempty"`
}

// listSuggestions is GET /lines/{id}/suggestions?status=: the whole tree's
// inbox, open suggestions unless status names others (comma separated, or
// "all").
func (a *api) listSuggestions(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	statuses := c.queryList("status", []string{domain.SuggestionOpen, domain.SuggestionAccepted, domain.SuggestionDismissed, domain.SuggestionExpired})
	inbox, err := a.engine.ListSuggestions(c.ctx, c.scope, id, statuses)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, suggestionList{RootLineID: inbox.RootLineID, Suggestions: list(inbox.Suggestions)}, nil
}

// acceptSuggestion is POST /suggestions/{sid}/accept; the body is the
// kind's choice (an object, optional).
func (a *api) acceptSuggestion(c *call) (int, any, error) {
	id, err := c.pathID("sid", domain.ErrSuggestionGone)
	if err != nil {
		return 0, nil, err
	}
	var body json.RawMessage
	if err := c.body(&body, false); err != nil {
		return 0, nil, err
	}
	accepted, err := a.engine.AcceptSuggestion(c.ctx, c.scope, id, body, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, suggestionDecided{Suggestion: accepted.Suggestion, Result: accepted.Result}, nil
}

// dismissSuggestion is POST /suggestions/{sid}/dismiss.
func (a *api) dismissSuggestion(c *call) (int, any, error) {
	id, err := c.pathID("sid", domain.ErrSuggestionGone)
	if err != nil {
		return 0, nil, err
	}
	dismissed, err := a.engine.DismissSuggestion(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, suggestionDecided{Suggestion: dismissed}, nil
}

// queryList reads a comma-separated query parameter; "all" means every
// value of all, missing means none (the engine's default).
func (c *call) queryList(name string, all []string) []string {
	values := []string{}
	for _, raw := range c.r.URL.Query()[name] {
		for _, part := range strings.Split(raw, ",") {
			if part = strings.TrimSpace(part); part == "all" {
				return append([]string{}, all...)
			} else if part != "" {
				values = append(values, part)
			}
		}
	}
	return values
}
