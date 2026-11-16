package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/Rynvex/tangent/domain"
)

// MemoryPair is two active memories of a tenant that look alike, the
// conversation line its consolidation suggestion is raised on (a source
// line of the pair that still exists) and the pair's key ("<id>:<id>", ids
// in order). A is the older memory, B the newer.
type MemoryPair struct {
	Tenant     string
	A, B       domain.Memory
	Similarity float64
	LineID     string
	Key        string
}

// memoryPairWindow bounds the pairs a sweep looks at: the newer memory of
// a pair was written in that window.
const memoryPairWindow = "7 days"

// duplicatePairsSQL finds, across tenants, pairs of active memories of the
// same size at least $1 similar, one of them written recently and one of
// them with its source line still there, with no pending or finished
// consolidation job for the pair yet; the most similar first.
const duplicatePairsSQL = `SELECT a.tenant_id, a.id, b.id, 1 - (a.embedding <=> b.embedding) AS similarity, COALESCE(lb.id, la.id)
FROM tangent_memory a
JOIN tangent_memory b ON b.tenant_id = a.tenant_id AND b.embedding_dim = a.embedding_dim AND b.id > a.id
LEFT JOIN tangent_line la ON la.id = a.source_line_id
LEFT JOIN tangent_line lb ON lb.id = b.source_line_id
WHERE a.status = 'active' AND b.status = 'active' AND (la.id IS NOT NULL OR lb.id IS NOT NULL)
  AND greatest(a.created_at, b.created_at) > now() - interval '` + memoryPairWindow + `'
  AND 1 - (a.embedding <=> b.embedding) >= $1
  AND NOT EXISTS (SELECT 1 FROM tangent_job j WHERE j.kind = '` + JobKindMemoryConsolidate + `' AND j.status IN ('pending','done')
                  AND j.input->>'pair' = a.id::text || ':' || b.id::text)
ORDER BY similarity DESC, greatest(a.created_at, b.created_at) DESC
LIMIT $2`

// DuplicateMemoryPairs are the pairs a consolidation sweep looks at, at
// most limit.
func (s *Store) DuplicateMemoryPairs(ctx context.Context, minSimilarity float64, limit int) ([]MemoryPair, error) {
	rows, err := s.pool.Query(ctx, duplicatePairsSQL, minSimilarity, max(limit, 1))
	if err != nil {
		return nil, fmt.Errorf("duplicate memories: %w", err)
	}
	type found struct {
		tenant, a, b, line string
		similarity         float64
	}
	pairs, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (found, error) {
		var f found
		err := row.Scan(&f.tenant, &f.a, &f.b, &f.similarity, &f.line)
		return f, err
	})
	if err != nil {
		return nil, fmt.Errorf("read duplicate memories: %w", err)
	}
	out := make([]MemoryPair, 0, len(pairs))
	for _, p := range pairs {
		a, err := s.GetMemory(ctx, p.tenant, p.a)
		if err != nil {
			return nil, err
		}
		b, err := s.GetMemory(ctx, p.tenant, p.b)
		if err != nil {
			return nil, err
		}
		if b.CreatedAt.Before(a.CreatedAt) {
			a, b = b, a
		}
		out = append(out, MemoryPair{Tenant: p.tenant, A: a, B: b, Similarity: p.similarity, LineID: p.line, Key: p.a + ":" + p.b})
	}
	return out, nil
}
