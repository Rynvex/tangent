package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/Rynvex/tangent/tangent"
)

// Page sizes the line and message lists accept (the store clamps further).
const (
	maxLinePageQuery    = 200
	maxMessagePageQuery = 500
)

func (a *api) capabilities(c *call) (int, any, error) {
	features, err := a.engine.Capabilities(c.ctx, c.scope)
	if err != nil {
		return 0, nil, err
	}
	canWrite := a.canWrite == nil || a.canWrite(c.r)
	return http.StatusOK, capabilities{Features: list(features), Permissions: permissions{CanWrite: canWrite}, Models: a.engine.ModelCatalog()}, nil
}

func (a *api) listLines(c *call) (int, any, error) {
	archived, err := c.queryBool("archived")
	if err != nil {
		return 0, nil, err
	}
	limit, err := c.queryInt("limit", 1, maxLinePageQuery)
	if err != nil {
		return 0, nil, err
	}
	pinned, err := c.queryBool("pinned")
	if err != nil {
		return 0, nil, err
	}
	query := c.r.URL.Query()
	page, err := a.engine.ListLines(c.ctx, c.scope, tangent.LineQuery{
		Archived: archived, Limit: int(limit), Cursor: query.Get("cursor"), Folder: query.Get("folder"), Tag: query.Get("tag"), Pinned: pinned,
	})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, linePage{Lines: list(page.Lines), NextCursor: page.NextCursor}, nil
}

// lineBody is POST /lines and PATCH /lines/{id}; folder and tags are B18's,
// pinned (PATCH only) B25's.
type lineBody struct {
	Title    *string         `json:"title"`
	Provider *string         `json:"provider"`
	Model    *string         `json:"model"`
	Folder   *string         `json:"folder"`
	Tags     *[]string       `json:"tags"`
	Pinned   *bool           `json:"pinned"`
	HostMeta json.RawMessage `json:"hostMeta"`
}

func (a *api) createLine(c *call) (int, any, error) {
	var in lineBody
	if err := c.body(&in, false); err != nil {
		return 0, nil, err
	}
	if hasHostMeta(in.HostMeta) {
		return 0, nil, errHostMeta
	}
	if in.Pinned != nil {
		return 0, nil, invalid("pinned is set with PATCH /lines/{id}")
	}
	meta, err := c.hostMeta()
	if err != nil {
		return 0, nil, err
	}
	line, err := a.engine.CreateLine(c.ctx, c.scope, tangent.LineInput{
		Title: deref(in.Title), Provider: deref(in.Provider), Model: deref(in.Model), Folder: deref(in.Folder), Tags: derefTags(in.Tags), HostMeta: meta,
	}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, line, nil
}

func (a *api) getLine(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	line, err := a.engine.GetLine(c.ctx, c.scope, id)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, line, nil
}

func (a *api) updateLine(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	var in lineBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if hasHostMeta(in.HostMeta) {
		return 0, nil, errHostMeta
	}
	// The host's data replaces the whole object; nil leaves it as it is.
	meta, err := c.hostMeta()
	if err != nil {
		return 0, nil, err
	}
	if in.Title == nil && in.Provider == nil && in.Model == nil && in.Folder == nil && in.Tags == nil && in.Pinned == nil && meta == nil {
		return 0, nil, invalid("nothing to change: send title, provider, model, folder, tags or pinned")
	}
	line, err := a.engine.UpdateLine(c.ctx, c.scope, id, tangent.LinePatch{
		Title: in.Title, Provider: in.Provider, Model: in.Model, Folder: in.Folder, Tags: in.Tags, Pinned: in.Pinned, HostMeta: meta,
	}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, line, nil
}

func (a *api) deleteLine(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	deleted, err := a.engine.DeleteTree(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, deletedTree{RootLineID: deleted.RootLineID, LineIDs: list(deleted.LineIDs)}, nil
}

func (a *api) archive(archived bool) func(c *call) (int, any, error) {
	return func(c *call) (int, any, error) {
		id, err := c.lineID()
		if err != nil {
			return 0, nil, err
		}
		lines, err := a.engine.ArchiveTree(c.ctx, c.scope, id, archived, c.tx()...)
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, lineList{Lines: list(lines)}, nil
	}
}

func (a *api) markRead(c *call) (int, any, error) {
	id, err := c.lineID()
	if err != nil {
		return 0, nil, err
	}
	line, err := a.engine.MarkRead(c.ctx, c.scope, id, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, line, nil
}

// derefTags is an optional tag list; nil is none.
func derefTags(tags *[]string) []string {
	if tags == nil {
		return nil
	}
	return *tags
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
