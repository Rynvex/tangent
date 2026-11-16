package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// The B10 part C routes: the tenant's memories (memory).

func (a *api) memoryRoutes() []route {
	return []route{
		{pattern: "GET /memories", feature: tangent.FeatureMemory, serve: a.listMemories},
		{pattern: "POST /memories", write: true, op: OpMemoriesCreate, feature: tangent.FeatureMemory, serve: a.createMemory},
		{pattern: "PATCH /memories/{mid}", write: true, op: OpMemoriesUpdate, feature: tangent.FeatureMemory, serve: a.updateMemory},
		{pattern: "POST /memories/{mid}/supersede", write: true, op: OpMemoriesSupersede, feature: tangent.FeatureMemory, serve: a.supersedeMemory},
		{pattern: "POST /memories/search", feature: tangent.FeatureMemory, serve: a.searchMemories},
	}
}

type memoryList struct {
	Memories   []domain.Memory `json:"memories"`
	NextCursor string          `json:"nextCursor"`
	Limits     memoryLimitsJS  `json:"limits"`
}

type memoryLimitsJS struct {
	TextMaxRunes int `json:"textMaxRunes"`
	TopK         int `json:"topK"`
	SearchMax    int `json:"searchMax"`
}

// listMemories is GET /memories?kind=&status=&limit=&cursor=.
func (a *api) listMemories(c *call) (int, any, error) {
	limit, err := c.queryInt("limit", 1, 200)
	if err != nil {
		return 0, nil, err
	}
	query := c.r.URL.Query()
	q := tangent.MemoryQuery{Kind: query.Get("kind"), Statuses: c.queryList("status", []string{domain.MemoryActive, domain.MemorySuperseded}), Limit: int(limit), Cursor: query.Get("cursor")}
	page, err := a.engine.ListMemoriesPage(c.ctx, c.scope, q)
	if err != nil {
		return 0, nil, err
	}
	l := a.limits.Memory
	return http.StatusOK, memoryList{Memories: list(page.Memories), NextCursor: page.NextCursor, Limits: memoryLimitsJS{TextMaxRunes: l.TextMaxRunes, TopK: l.TopK, SearchMax: l.SearchMax}}, nil
}

type memoryView struct {
	Memory domain.Memory `json:"memory"`
}

// memoryBody is POST /memories.
type memoryBody struct {
	Kind         string     `json:"kind"`
	Text         string     `json:"text"`
	Importance   int        `json:"importance"`
	ValidUntil   *time.Time `json:"validUntil"`
	SourceLineID string     `json:"sourceLineId"`
}

func (b memoryBody) input() domain.MemoryInput {
	return domain.MemoryInput{Kind: b.Kind, Text: b.Text, Importance: b.Importance, ValidUntil: b.ValidUntil}
}

func (a *api) createMemory(c *call) (int, any, error) {
	var in memoryBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	if in.SourceLineID != "" {
		id, err := c.idValue(in.SourceLineID, domain.ErrLineNotFound)
		if err != nil {
			return 0, nil, err
		}
		in.SourceLineID = id
	}
	memory, err := a.engine.CreateMemory(c.ctx, c.scope, tangent.MemoryCreate{Memory: in.input(), SourceLineID: in.SourceLineID}, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, memoryView{Memory: memory}, nil
}

// memoryPatchBody is PATCH /memories/{mid}; validUntil null clears it.
type memoryPatchBody struct {
	Kind       *string         `json:"kind"`
	Importance *int            `json:"importance"`
	ValidUntil json.RawMessage `json:"validUntil"`
}

func (b memoryPatchBody) patch() (tangent.MemoryPatch, error) {
	patch := tangent.MemoryPatch{Kind: b.Kind, Importance: b.Importance}
	switch raw := bytes.TrimSpace(b.ValidUntil); {
	case len(raw) == 0:
	case bytes.Equal(raw, []byte("null")):
		patch.ClearValidUntil = true
	default:
		var until time.Time
		if err := json.Unmarshal(raw, &until); err != nil {
			return patch, invalid("validUntil must be an RFC 3339 time or null")
		}
		patch.ValidUntil = &until
	}
	return patch, nil
}

func (a *api) updateMemory(c *call) (int, any, error) {
	id, err := c.pathID("mid", domain.ErrMemoryNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in memoryPatchBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	patch, err := in.patch()
	if err != nil {
		return 0, nil, err
	}
	memory, err := a.engine.UpdateMemory(c.ctx, c.scope, id, patch, c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, memoryView{Memory: memory}, nil
}

type memorySuperseded struct {
	Memory     domain.Memory   `json:"memory"`
	Superseded []domain.Memory `json:"superseded"`
}

func (a *api) supersedeMemory(c *call) (int, any, error) {
	id, err := c.pathID("mid", domain.ErrMemoryNotFound)
	if err != nil {
		return 0, nil, err
	}
	var in memoryBody
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	out, err := a.engine.SupersedeMemory(c.ctx, c.scope, id, in.input(), c.tx()...)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, memorySuperseded{Memory: out.New, Superseded: list(out.Old)}, nil
}

type memorySearchResult struct {
	Query   string                  `json:"query"`
	Results []domain.RecalledMemory `json:"results"`
}

// searchMemories is POST /memories/search (a read: the query is long text).
func (a *api) searchMemories(c *call) (int, any, error) {
	var in struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := c.body(&in, true); err != nil {
		return 0, nil, err
	}
	results, err := a.engine.SearchMemories(c.ctx, c.scope, tangent.MemorySearch{Query: in.Query, Limit: in.Limit})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, memorySearchResult{Query: in.Query, Results: list(results)}, nil
}
