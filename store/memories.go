package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Memories live in the memory feature's own migration (it needs pgvector),
// so sqlc does not see them: the queries here are written by hand.

// JobKinds of the memory feature.
const (
	// JobKindMemoryExtract proposes memories from what a write settled.
	JobKindMemoryExtract = "memory_extract"
	// JobKindMemoryConsolidate looks at two near-duplicate memories.
	JobKindMemoryConsolidate = "memory_consolidate"
)

// memoryColumns are the columns a memory is read from (not the embedding).
const memoryColumns = `id, kind, text, status, superseded_by, importance, valid_until, source_line_id, source_message_id,
    source_leaf_line_id, source_note_id, source_label, source_job_id, created_by, created_at, updated_at`

// MemoryWriteInput is a new memory: what it says, where it came from, the
// job that proposed it (empty for the operator's) and its embedding.
type MemoryWriteInput struct {
	Tenant      string
	Memory      domain.MemoryInput
	Source      domain.MemorySource
	SourceJobID string
	Embedding   []float32
	Actor       string
}

// rawTx runs fn and the hooks in one transaction over hand-written SQL.
func rawTx[T any](ctx context.Context, s *Store, hooks []TxHook, fn func(tx pgx.Tx) (T, error)) (T, error) {
	return runTxWith(ctx, s, func(_ *db.Queries, tx pgx.Tx) (T, error) {
		out, err := fn(tx)
		if err != nil {
			return out, err
		}
		return out, runHooks(ctx, tx, hooks, out)
	})
}

func (s *Store) checkMemoryWrite(in MemoryWriteInput) (MemoryWriteInput, error) {
	memory, err := domain.NormalizeMemory(in.Memory, s.limits.Memory)
	if err != nil {
		return in, err
	}
	if len(in.Embedding) == 0 {
		return in, errors.New("store: a memory needs its embedding")
	}
	in.Memory = memory
	in.Source.Label = domain.CutRunes(strings.Join(strings.Fields(in.Source.Label), " "), domain.DefaultLimits().Branch.PurposeMaxRunes)
	return in, nil
}

// CreateMemory stores a memory of the tenant.
func (s *Store) CreateMemory(ctx context.Context, in MemoryWriteInput, hooks ...TxHook) (domain.Memory, error) {
	in, err := s.checkMemoryWrite(in)
	if err != nil {
		return domain.Memory{}, err
	}
	return rawTx(ctx, s, hooks, func(tx pgx.Tx) (domain.Memory, error) { return insertMemory(ctx, tx, in) })
}

const insertMemorySQL = `INSERT INTO tangent_memory (tenant_id, kind, text, importance, valid_until, source_line_id, source_message_id,
    source_leaf_line_id, source_note_id, source_label, source_job_id, embedding, embedding_dim, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, $13, $14)
RETURNING ` + memoryColumns

func insertMemory(ctx context.Context, tx pgx.Tx, in MemoryWriteInput) (domain.Memory, error) {
	src := in.Source
	row := tx.QueryRow(ctx, insertMemorySQL, in.Tenant, in.Memory.Kind, in.Memory.Text, in.Memory.Importance, in.Memory.ValidUntil,
		nullID(src.LineID), nullID(src.MessageID), nullID(src.LeafLineID), nullID(src.NoteID), src.Label, nullID(in.SourceJobID),
		domain.VectorLiteral(in.Embedding), len(in.Embedding), in.Actor)
	m, err := scanMemory(row)
	if err != nil {
		return domain.Memory{}, fmt.Errorf("insert memory: %w", err)
	}
	return m, nil
}

// scanMemory reads memoryColumns (and extra columns after them).
func scanMemory(row pgx.Row, extra ...any) (domain.Memory, error) {
	var m domain.Memory
	var id uuid.UUID
	var supersededBy, line, message, leaf, note, job uuid.NullUUID
	var validUntil *time.Time
	dest := append([]any{&id, &m.Kind, &m.Text, &m.Status, &supersededBy, &m.Importance, &validUntil, &line, &message, &leaf, &note,
		&m.Source.Label, &job, &m.CreatedBy, &m.CreatedAt, &m.UpdatedAt}, extra...)
	err := row.Scan(dest...)
	if err != nil {
		return domain.Memory{}, err
	}
	m.ID, m.SupersededBy, m.AIDrafted = id.String(), idString(supersededBy), job.Valid
	m.Source.LineID, m.Source.MessageID, m.Source.LeafLineID, m.Source.NoteID = idString(line), idString(message), idString(leaf), idString(note)
	m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
	if validUntil != nil {
		utc := validUntil.UTC()
		m.ValidUntil = &utc
	}
	return m, nil
}

// GetMemory reads a memory of the tenant.
func (s *Store) GetMemory(ctx context.Context, tenant, memoryID string) (domain.Memory, error) {
	return getMemory(ctx, s.pool, tenant, memoryID, false)
}

// querier is a pool or a transaction.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func getMemory(ctx context.Context, q querier, tenant, memoryID string, forUpdate bool) (domain.Memory, error) {
	id, ok := parseID(memoryID)
	if !ok {
		return domain.Memory{}, domain.ErrMemoryNotFound
	}
	sql := `SELECT ` + memoryColumns + ` FROM tangent_memory WHERE id = $1 AND tenant_id = $2`
	if forUpdate {
		sql += ` FOR UPDATE`
	}
	m, err := scanMemory(q.QueryRow(ctx, sql, id, tenant))
	if err != nil {
		return domain.Memory{}, lookup(err, domain.ErrMemoryNotFound, "get memory")
	}
	return m, nil
}

// MemoryQuery lists a tenant's memories: of a kind ("" for all), of the
// statuses (default active), newest first (created_at, then id), at most
// Limit (default 100). Cursor is the NextCursor of the previous page.
type MemoryQuery struct {
	Tenant   string
	Kind     string
	Statuses []string
	Limit    int
	Cursor   string
}

// MemoryPage is one page of memories, newest first. NextCursor is "" on the
// last page.
type MemoryPage struct {
	Memories   []domain.Memory
	NextCursor string
}

// memoryPageMax bounds one listing.
const memoryPageMax = 200

// ListMemories lists the tenant's memories (the first page unless Cursor
// is set).
func (s *Store) ListMemories(ctx context.Context, in MemoryQuery) ([]domain.Memory, error) {
	page, err := s.ListMemoriesPage(ctx, in)
	return page.Memories, err
}

// ListMemoriesPage returns one keyset page of the tenant's memories.
func (s *Store) ListMemoriesPage(ctx context.Context, in MemoryQuery) (MemoryPage, error) {
	statuses := in.Statuses
	if len(statuses) == 0 {
		statuses = []string{domain.MemoryActive}
	}
	var afterAt *time.Time
	var afterID uuid.NullUUID
	if in.Cursor != "" {
		at, id, err := decodeKeysetCursor(in.Cursor)
		if err != nil {
			return MemoryPage{}, err
		}
		afterAt, afterID = &at, uuid.NullUUID{UUID: id, Valid: true}
	}
	limit := clampLimit(in.Limit, 100, memoryPageMax)
	rows, err := s.pool.Query(ctx, `SELECT `+memoryColumns+` FROM tangent_memory
WHERE tenant_id = $1 AND ($2 = '' OR kind = $2) AND status = ANY($3::text[])
  AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
ORDER BY created_at DESC, id DESC LIMIT $4`, in.Tenant, in.Kind, statuses, limit+1, afterAt, afterID)
	if err != nil {
		return MemoryPage{}, fmt.Errorf("list memories: %w", err)
	}
	memories, err := collectMemories(rows)
	if err != nil {
		return MemoryPage{}, err
	}
	page := MemoryPage{Memories: memories}
	if len(memories) > int(limit) {
		page.Memories = memories[:limit]
		last := page.Memories[len(page.Memories)-1]
		id, _ := parseID(last.ID)
		page.NextCursor = encodeKeysetCursor(last.CreatedAt, id)
	}
	return page, nil
}

func collectMemories(rows pgx.Rows) ([]domain.Memory, error) {
	defer rows.Close()
	out := []domain.Memory{}
	for rows.Next() {
		m, err := scanMemory(rows)
		if err != nil {
			return nil, fmt.Errorf("read memory: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// MemoryPatch changes what a memory is filed as; its text changes only by
// superseding it.
type MemoryPatch struct {
	Kind            *string
	Importance      *int
	ValidUntil      *time.Time
	ClearValidUntil bool
}

// UpdateMemory applies a patch to an active memory (a superseded one is
// history: memory_superseded).
func (s *Store) UpdateMemory(ctx context.Context, tenant, memoryID string, patch MemoryPatch, hooks ...TxHook) (domain.Memory, error) {
	return rawTx(ctx, s, hooks, func(tx pgx.Tx) (domain.Memory, error) {
		m, err := getMemory(ctx, tx, tenant, memoryID, true)
		if err != nil {
			return domain.Memory{}, err
		}
		if m.Status != domain.MemoryActive {
			return domain.Memory{}, domain.ErrMemorySuperseded
		}
		in := applyMemoryPatch(m, patch)
		if in, err = domain.NormalizeMemory(in, s.limits.Memory); err != nil {
			return domain.Memory{}, err
		}
		row := tx.QueryRow(ctx, `UPDATE tangent_memory SET kind = $2, importance = $3, valid_until = $4, updated_at = clock_timestamp()
WHERE id = $1 RETURNING `+memoryColumns, m.ID, in.Kind, in.Importance, in.ValidUntil)
		return scanMemory(row)
	})
}

func applyMemoryPatch(m domain.Memory, patch MemoryPatch) domain.MemoryInput {
	in := domain.MemoryInput{Kind: m.Kind, Text: m.Text, Importance: m.Importance, ValidUntil: m.ValidUntil}
	if patch.Kind != nil {
		in.Kind = *patch.Kind
	}
	if patch.Importance != nil {
		in.Importance = *patch.Importance
		if in.Importance == 0 {
			in.Importance = -1 // 0 is no importance here, not the default
		}
	}
	switch {
	case patch.ClearValidUntil:
		in.ValidUntil = nil
	case patch.ValidUntil != nil:
		in.ValidUntil = patch.ValidUntil
	}
	return in
}

// SupersededMemories is a supersede: the new memory and the ones it
// replaced (now superseded, pointing at it).
type SupersededMemories struct {
	New domain.Memory
	Old []domain.Memory
}

// SupersedeMemories replaces active memories of the tenant (locked in id
// order) by a new one in one transaction; any of them superseded already →
// memory_superseded. Nothing is deleted.
func (s *Store) SupersedeMemories(ctx context.Context, tenant string, memoryIDs []string, in MemoryWriteInput, hooks ...TxHook) (SupersededMemories, error) {
	in.Tenant = tenant
	in, err := s.checkMemoryWrite(in)
	if err != nil {
		return SupersededMemories{}, err
	}
	ids := slices.Clone(memoryIDs)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	return rawTx(ctx, s, hooks, func(tx pgx.Tx) (SupersededMemories, error) {
		for _, id := range ids {
			m, err := getMemory(ctx, tx, tenant, id, true)
			if err != nil {
				return SupersededMemories{}, err
			}
			if m.Status != domain.MemoryActive {
				return SupersededMemories{}, domain.ErrMemorySuperseded
			}
		}
		created, err := insertMemory(ctx, tx, in)
		if err != nil {
			return SupersededMemories{}, err
		}
		rows, err := tx.Query(ctx, `UPDATE tangent_memory SET status = 'superseded', superseded_by = $2, updated_at = clock_timestamp()
WHERE id = ANY($1::uuid[]) RETURNING `+memoryColumns, ids, created.ID)
		if err != nil {
			return SupersededMemories{}, fmt.Errorf("supersede memories: %w", err)
		}
		old, err := collectMemories(rows)
		return SupersededMemories{New: created, Old: old}, err
	})
}

// SimilarMemories are the tenant's active memories of the embedding's size,
// the most similar (cosine) first, at most limit.
func (s *Store) SimilarMemories(ctx context.Context, tenant string, embedding []float32, limit int) ([]domain.MemoryCandidate, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+memoryColumns+`, 1 - (embedding <=> $2::vector) AS similarity FROM tangent_memory
WHERE tenant_id = $1 AND status = 'active' AND embedding_dim = $3
ORDER BY embedding <=> $2::vector, created_at DESC LIMIT $4`, tenant, domain.VectorLiteral(embedding), len(embedding), max(limit, 1))
	if err != nil {
		return nil, fmt.Errorf("similar memories: %w", err)
	}
	defer rows.Close()
	out := []domain.MemoryCandidate{}
	for rows.Next() {
		c, err := scanCandidate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func scanCandidate(rows pgx.Rows) (domain.MemoryCandidate, error) {
	var similarity float64
	m, err := scanMemory(rows, &similarity)
	if err != nil {
		return domain.MemoryCandidate{}, fmt.Errorf("read memory: %w", err)
	}
	return domain.MemoryCandidate{Memory: m, Similarity: similarity}, nil
}
