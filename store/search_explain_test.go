package store_test

import (
	"os"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangenttest/seed"
)

// TestSearch_Explain prints the plans and timings of the search statement on
// ten seeded trees (34k messages); run with TANGENT_PERF_EXPLAIN=1.
func TestSearch_Explain(t *testing.T) {
	if os.Getenv("TANGENT_PERF_EXPLAIN") != "1" {
		t.Skip("set TANGENT_PERF_EXPLAIN=1 to print the search plans")
	}
	f := newSearchFixture(t)
	for i := range 10 {
		if _, err := seed.Write(f.ctx, f.pool, seed.Config{Tenant: tenant, Seed: uint64(300 + i)}); err != nil {
			t.Fatal(err)
		}
	}
	f.exec("ANALYZE")
	var floor int64
	if err := f.pool.QueryRow(f.ctx, `SELECT seq FROM tangent_message WHERE tenant_id = $1 ORDER BY seq DESC OFFSET $2 LIMIT 1`, tenant, store.SearchWindow-1).Scan(&floor); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"分岔", "龍貓", "效能 latency", "deploy", "nowhere to be found"} {
		for _, older := range []bool{false, true} {
			lo, hi := floor, int64(1<<62)
			if older {
				lo, hi = 0, floor
			}
			t.Logf("%q older=%v:\n%s", query, older, f.explain(store.SearchSQLFor(query, older),
				tenant, domain.SearchLikePattern(query), query, false, store.SearchCandidates, lo, hi))
		}
	}
}

// explain runs EXPLAIN ANALYZE and returns the plan.
func (f *fixture) explain(sql string, args ...any) string {
	f.t.Helper()
	rows, err := f.pool.Query(f.ctx, "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) "+sql, args...)
	if err != nil {
		f.t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			f.t.Fatal(err)
		}
		plan = append(plan, line)
	}
	return strings.Join(plan, "\n")
}
