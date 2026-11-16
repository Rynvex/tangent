package httpapi

import (
	"net/http"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Spinoff routes (the spinoff feature).

// spinoffBody is POST /lines/{id}/spinoff.
type spinoffBody struct {
	Mode        string `json:"mode"`
	AtMessageID string `json:"atMessageId"`
	Title       string `json:"title"`
	CopyNotes   bool   `json:"copyNotes"`
}

// spunOff is the 201 of a spinoff. Branch (the branch as it was) and Moved
// (the lines that moved with it) are for detach.
type spunOff struct {
	Mode         string             `json:"mode"`
	Line         domain.LineView    `json:"line"`
	SourceLineID string             `json:"sourceLineId"`
	RootLineID   string             `json:"rootLineId"`
	Marker       domain.Message     `json:"marker"`
	Link         domain.Link        `json:"link"`
	Branch       *domain.BranchView `json:"branch,omitempty"`
	Moved        []string           `json:"moved"`
	Notes        *notesWrite        `json:"notes,omitempty"`
}

func (a *api) spinoff(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in spinoffBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	out, err := a.engine.Spinoff(c.ctx, c.scope, id, tangent.SpinoffInput{Mode: in.Mode, AtMessageID: in.AtMessageID, Title: in.Title, CopyNotes: in.CopyNotes}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	body := spunOff{
		Mode: out.Mode, Line: out.Line, SourceLineID: out.SourceLineID, RootLineID: out.OldRootLineID, Marker: out.Marker, Link: out.Link, Moved: list(out.Moved),
	}
	if out.Mode == domain.SpinoffDetach {
		body.Branch = &out.Branch
	}
	if in.CopyNotes {
		body.Notes = &notesWrite{RootLineID: out.Notes.RootLineID, Revision: out.Notes.Revision, Created: list(out.Notes.Created), Superseded: list(out.Notes.Superseded)}
	}
	return http.StatusCreated, body, nil
}

// spinoffPreview is POST /lines/{id}/spinoff/preview: the capsule a spinoff
// with the same body would store, and how many notes copyNotes would copy.
type spinoffPreview struct {
	Mode        string         `json:"mode"`
	Capsule     capsulePreview `json:"capsule"`
	NotesToCopy int            `json:"notesToCopy"`
}

type capsulePreview struct {
	Text          string `json:"text"`
	TokenEstimate int    `json:"tokenEstimate"`
	TokenBudget   int    `json:"tokenBudget"`
	Truncated     bool   `json:"truncated"`
}

// previewSpinoff writes nothing, so read-only callers may ask.
func (a *api) previewSpinoff(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in spinoffBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	preview, err := a.engine.PreviewSpinoff(c.ctx, c.scope, id, tangent.SpinoffInput{Mode: in.Mode, AtMessageID: in.AtMessageID, Title: in.Title, CopyNotes: in.CopyNotes})
	if err != nil {
		return 0, nil, err
	}
	capsule := preview.Capsule
	return http.StatusOK, spinoffPreview{
		Mode: preview.Mode, NotesToCopy: preview.NotesToCopy,
		Capsule: capsulePreview{Text: capsule.Rendered, TokenEstimate: capsule.TokenEstimate, TokenBudget: capsule.TokenBudget, Truncated: capsule.Truncated},
	}, nil
}

type linkList struct {
	Links []domain.Link `json:"links"`
}

// listLinks is GET /lines/{id}/links: links from or to any line of the tree.
func (a *api) listLinks(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	links, err := a.engine.ListLinks(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, linkList{Links: list(links)}, nil
}
