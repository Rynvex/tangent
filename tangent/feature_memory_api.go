package tangent

import (
	"context"
	"errors"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// errEmbedderShape: the Embedder answered with vectors of the wrong number
// or size.
var errEmbedderShape = errors.New("tangent: the Embedder returned vectors of the wrong number or size")

// MemoryChange is the data of memory.changed: the memory written and the
// ones it superseded.
type MemoryChange struct {
	Memory     domain.Memory   `json:"memory"`
	Superseded []domain.Memory `json:"superseded"`
}

func memoryEvent(tenant string, m domain.Memory, superseded []domain.Memory) Event {
	if superseded == nil {
		superseded = []domain.Memory{}
	}
	return Event{Type: EventMemoryChanged, Tenant: tenant, Data: MemoryChange{Memory: m, Superseded: superseded}}
}

// MemoryQuery lists memories: of a kind ("" for all) and statuses (default
// active), newest first, at most Limit; Cursor is the NextCursor of the
// previous page.
type MemoryQuery struct {
	Kind     string
	Statuses []string
	Limit    int
	Cursor   string
}

// MemoryPage is one page of memories, newest first; NextCursor is "" on the
// last page.
type MemoryPage = store.MemoryPage

// ListMemories lists the tenant's memories (one page: ListMemoriesPage
// also says where the next one starts).
func (e *Engine) ListMemories(ctx context.Context, scope Scope, q MemoryQuery) ([]domain.Memory, error) {
	page, err := e.ListMemoriesPage(ctx, scope, q)
	return page.Memories, err
}

// ListMemoriesPage returns one keyset page of the tenant's memories; an
// unreadable cursor is invalid_input.
func (e *Engine) ListMemoriesPage(ctx context.Context, scope Scope, q MemoryQuery) (MemoryPage, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemory)
	if err != nil {
		return MemoryPage{}, err
	}
	if q.Kind != "" && !domain.ValidMemoryKind(q.Kind) {
		return MemoryPage{}, domain.NewError(domain.CodeInvalidInput, "kind must be fact, decision, preference or lesson", nil)
	}
	for _, status := range q.Statuses {
		if status != domain.MemoryActive && status != domain.MemorySuperseded {
			return MemoryPage{}, domain.NewError(domain.CodeInvalidInput, "status must be active or superseded", nil)
		}
	}
	return e.store.ListMemoriesPage(ctx, store.MemoryQuery{Tenant: scope.Tenant, Kind: q.Kind, Statuses: q.Statuses, Limit: q.Limit, Cursor: q.Cursor})
}

// GetMemory reads a memory of the tenant.
func (e *Engine) GetMemory(ctx context.Context, scope Scope, memoryID string) (domain.Memory, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemory)
	if err != nil {
		return domain.Memory{}, err
	}
	return e.store.GetMemory(ctx, scope.Tenant, memoryID)
}

// MemoryCreate is the operator's memory; SourceLineID optionally names the
// conversation line it came from (its purpose or title is the label).
type MemoryCreate struct {
	Memory       domain.MemoryInput
	SourceLineID string
}

// CreateMemory writes the operator's memory (any mode).
// InTx hooks receive domain.Memory.
func (e *Engine) CreateMemory(ctx context.Context, scope Scope, in MemoryCreate, opts ...TxOption) (domain.Memory, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemory)
	if err != nil {
		return domain.Memory{}, err
	}
	memory, err := domain.NormalizeMemory(in.Memory, e.limits.Memory)
	if err != nil {
		return domain.Memory{}, err
	}
	source := domain.MemorySource{}
	if id := strings.TrimSpace(in.SourceLineID); id != "" {
		line, err := e.store.GetLine(ctx, scope.Tenant, id)
		if err != nil {
			return domain.Memory{}, err
		}
		source = domain.MemorySource{LineID: line.ID, Label: lineAbout(line)}
	}
	return e.writeMemory(ctx, scope, store.MemoryWriteInput{Memory: memory, Source: source, Actor: scope.Actor}, opts)
}

// writeMemory embeds and stores a memory and publishes memory.changed.
func (e *Engine) writeMemory(ctx context.Context, scope Scope, in store.MemoryWriteInput, opts []TxOption) (domain.Memory, error) {
	vector, err := e.embedOne(ctx, in.Memory.Text)
	if err != nil {
		return domain.Memory{}, err
	}
	in.Tenant, in.Embedding = scope.Tenant, vector
	created, err := e.store.CreateMemory(ctx, in, hooksOf(opts)...)
	if err != nil {
		return domain.Memory{}, err
	}
	e.publish(ctx, memoryEvent(scope.Tenant, created, nil))
	return created, nil
}

// MemoryPatch changes a memory's kind, importance or validity; its text
// changes only by superseding it.
type MemoryPatch = store.MemoryPatch

// UpdateMemory applies a patch to an active memory (memory_superseded for
// a superseded one).
// InTx hooks receive domain.Memory.
func (e *Engine) UpdateMemory(ctx context.Context, scope Scope, memoryID string, patch MemoryPatch, opts ...TxOption) (domain.Memory, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemory)
	if err != nil {
		return domain.Memory{}, err
	}
	updated, err := e.store.UpdateMemory(ctx, scope.Tenant, memoryID, patch, hooksOf(opts)...)
	if err != nil {
		return domain.Memory{}, err
	}
	e.publish(ctx, memoryEvent(scope.Tenant, updated, nil))
	return updated, nil
}

// SupersededMemories is a supersede: the new memory and the ones it
// replaced.
type SupersededMemories = store.SupersededMemories

// SupersedeMemory replaces an active memory by the operator's new one; the
// kind, importance and validity default to the old one's, the source is
// the old one's. Nothing is deleted.
// InTx hooks receive store.SupersededMemories.
func (e *Engine) SupersedeMemory(ctx context.Context, scope Scope, memoryID string, in domain.MemoryInput, opts ...TxOption) (SupersededMemories, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemory)
	if err != nil {
		return SupersededMemories{}, err
	}
	old, err := e.store.GetMemory(ctx, scope.Tenant, memoryID)
	if err != nil {
		return SupersededMemories{}, err
	}
	if in.Kind == "" {
		in.Kind = old.Kind
	}
	if in.Importance == 0 {
		in.Importance = old.Importance
	}
	if in.ValidUntil == nil {
		in.ValidUntil = old.ValidUntil
	}
	return e.supersede(ctx, scope, []string{old.ID}, store.MemoryWriteInput{Memory: in, Source: old.Source, Actor: scope.Actor}, opts)
}

// supersede embeds the new memory and replaces the old ones by it.
func (e *Engine) supersede(ctx context.Context, scope Scope, ids []string, in store.MemoryWriteInput, opts []TxOption) (SupersededMemories, error) {
	memory, err := domain.NormalizeMemory(in.Memory, e.limits.Memory)
	if err != nil {
		return SupersededMemories{}, err
	}
	vector, err := e.embedOne(ctx, memory.Text)
	if err != nil {
		return SupersededMemories{}, err
	}
	in.Memory, in.Embedding = memory, vector
	out, err := e.store.SupersedeMemories(ctx, scope.Tenant, ids, in, hooksOf(opts)...)
	if err != nil {
		return SupersededMemories{}, err
	}
	e.publish(ctx, memoryEvent(scope.Tenant, out.New, out.Old))
	return out, nil
}

// MemorySearch ranks the tenant's memories for a text (a new
// conversation's first message, a new branch's purpose); Limit defaults to
// Limits.Memory.TopK and is at most SearchMax.
type MemorySearch struct {
	Query string
	Limit int
}

// SearchMemories recalls the memories for a text: the offers at a new
// conversation or branch ("you settled before …").
func (e *Engine) SearchMemories(ctx context.Context, scope Scope, in MemorySearch) ([]domain.RecalledMemory, error) {
	scope, _, err := e.needScoped(ctx, scope, FeatureMemory)
	if err != nil {
		return nil, err
	}
	query := strings.TrimSpace(in.Query)
	if query == "" {
		return nil, domain.NewError(domain.CodeInvalidInput, "a query is required", nil)
	}
	if err := domain.CheckRunes("query", query, e.limits.Text.MessageMaxRunes); err != nil {
		return nil, err
	}
	limit := in.Limit
	if limit <= 0 {
		limit = e.limits.Memory.TopK
	}
	return e.recall(ctx, scope, query, min(limit, e.limits.Memory.SearchMax))
}
