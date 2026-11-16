package store_test

import (
	"context"
	"io/fs"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangenttest"
)

var coreTables = []string{"tangent_line", "tangent_message", "tangent_branch", "tangent_note", "tangent_chapter_cut", "tangent_job"}

func tableCount(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.tables
		WHERE table_schema = current_schema() AND table_name = ANY($1)`, coreTables).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func appliedVersions(t *testing.T, pool *pgxpool.Pool) []int {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT version FROM tangent_schema_migrations ORDER BY version`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

func TestMigrationsFS_HasAnUpAndADownForEveryVersion(t *testing.T) {
	ups, _ := fs.Glob(store.MigrationsFS, "migrations/*.up.sql")
	downs, _ := fs.Glob(store.MigrationsFS, "migrations/*.down.sql")
	if len(ups) == 0 || len(ups) != len(downs) {
		t.Fatalf("ups %v downs %v", ups, downs)
	}
	for i := range ups {
		if strings.TrimSuffix(ups[i], ".up.sql") != strings.TrimSuffix(downs[i], ".down.sql") {
			t.Fatalf("unpaired migration %s / %s", ups[i], downs[i])
		}
	}
}

func TestMigrate_UpDownUp(t *testing.T) {
	pool := tangenttest.OpenSchema(t)
	ctx := context.Background()
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if got := tableCount(t, pool); got != len(coreTables) {
		t.Fatalf("tables after up = %d", got)
	}
	versions := appliedVersions(t, pool)
	if len(versions) < 4 || versions[0] != 1 {
		t.Fatalf("versions = %v", versions)
	}
	// Running it again is a no-op.
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if again := appliedVersions(t, pool); len(again) != len(versions) {
		t.Fatalf("second run applied %v", again)
	}

	if err := store.MigrateDown(ctx, pool, 0); err != nil {
		t.Fatal(err)
	}
	if got := tableCount(t, pool); got != 0 {
		t.Fatalf("tables after down = %d", got)
	}
	if left := appliedVersions(t, pool); len(left) != 0 {
		t.Fatalf("versions after down = %v", left)
	}

	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("up after down: %v", err)
	}
	if got := tableCount(t, pool); got != len(coreTables) {
		t.Fatalf("tables after the second up = %d", got)
	}
}

func TestMigrateDown_StopsAtTheTargetVersion(t *testing.T) {
	pool := tangenttest.Open(t)
	ctx := context.Background()
	if err := store.MigrateDown(ctx, pool, 1); err != nil {
		t.Fatal(err)
	}
	if versions := appliedVersions(t, pool); len(versions) != 1 || versions[0] != 1 {
		t.Fatalf("versions = %v, want only 1", versions)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if got := tableCount(t, pool); got != len(coreTables) {
		t.Fatalf("tables = %d", got)
	}
}

func TestMigrate_ConcurrentRunsApplyEachVersionOnce(t *testing.T) {
	pool := tangenttest.OpenSchema(t)
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[i] = store.Migrate(context.Background(), pool)
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatalf("a concurrent migrate failed: %v", err)
		}
	}
	versions := appliedVersions(t, pool)
	seen := map[int]bool{}
	for _, v := range versions {
		if seen[v] {
			t.Fatalf("version %d applied twice: %v", v, versions)
		}
		seen[v] = true
	}
	if tableCount(t, pool) != len(coreTables) {
		t.Fatal("tables missing after concurrent migrations")
	}
}
