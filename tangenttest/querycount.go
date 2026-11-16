package tangenttest

import (
	"context"
	"maps"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// queryKeyMaxRunes bounds the key of a statement without a sqlc name.
const queryKeyMaxRunes = 60

// QueryCounter counts the statements a pool sends (a pgx.QueryTracer):
// every Query, QueryRow and Exec, transaction control (begin, commit,
// rollback, savepoints) included. A statement is keyed by its sqlc name
// ("-- name: GetLine :one" gives "GetLine"), or else by its first words.
// It is safe for concurrent use.
type QueryCounter struct {
	mu     sync.Mutex
	counts map[string]int
	total  int
}

// CountQueries returns a second pool over pool's database and schema
// (pool.Config with a tracer) whose statements the returned counter counts.
// The pool is closed when the test ends. Build the code under measurement
// on the returned pool; pool itself stays uncounted.
func CountQueries(t testing.TB, pool *pgxpool.Pool) (*pgxpool.Pool, *QueryCounter) {
	t.Helper()
	counter := &QueryCounter{counts: map[string]int{}}
	cfg := pool.Config()
	cfg.ConnConfig.Tracer = counter
	counted, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("tangenttest: open a counted pool: %v", err)
	}
	t.Cleanup(counted.Close)
	return counted, counter
}

// TraceQueryStart counts one statement.
func (c *QueryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	key := queryKey(data.SQL)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counts[key]++
	c.total++
	return ctx
}

// TraceQueryEnd does nothing: a statement counts when it starts.
func (c *QueryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// Reset forgets everything counted so far.
func (c *QueryCounter) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counts = map[string]int{}
	c.total = 0
}

// Total is how many statements were sent since the last Reset.
func (c *QueryCounter) Total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
}

// Counts is how often each statement was sent since the last Reset (a copy).
func (c *QueryCounter) Counts() map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return maps.Clone(c.counts)
}

// queryKey names a statement: its sqlc name, or its first words, lower
// case and on one line.
func queryKey(sql string) string {
	text := strings.TrimSpace(sql)
	if rest, ok := strings.CutPrefix(text, "-- name: "); ok {
		if name, _, found := strings.Cut(rest, " "); found {
			return name
		}
	}
	key := strings.ToLower(strings.Join(strings.Fields(text), " "))
	if runes := []rune(key); len(runes) > queryKeyMaxRunes {
		key = string(runes[:queryKeyMaxRunes])
	}
	return key
}
