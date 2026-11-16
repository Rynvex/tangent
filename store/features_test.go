package store_test

import (
	"context"
	"fmt"
	"io/fs"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangenttest"
)

var searchIndexes = []string{
	"idx_tangent_line_title_trgm", "idx_tangent_branch_purpose_trgm", "idx_tangent_message_content_trgm", "idx_tangent_message_search_recent",
}

func indexCount(t *testing.T, pool *pgxpool.Pool, names []string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM pg_indexes
		WHERE schemaname = current_schema() AND indexname = ANY($1)`, names).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func wantErrorContaining(t *testing.T, err error, parts ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("no error, want one containing %q", parts)
	}
	for _, part := range parts {
		if !strings.Contains(err.Error(), part) {
			t.Fatalf("error %q does not mention %q", err, part)
		}
	}
}

func TestFeatureMigrationsFS_PairsEveryStep(t *testing.T) {
	ups, _ := fs.Glob(store.FeatureMigrationsFS, "features/*/*.up.sql")
	downs, _ := fs.Glob(store.FeatureMigrationsFS, "features/*/*.down.sql")
	if len(ups) == 0 || len(ups) != len(downs) {
		t.Fatalf("ups %v downs %v", ups, downs)
	}
	if ext, ok := store.FeatureExtension("search"); !ok || ext != "pg_trgm" {
		t.Fatalf("search needs %q, %v", ext, ok)
	}
	if _, ok := store.FeatureExtension("notes"); ok {
		t.Fatal("notes has no migrations of its own")
	}
}

func TestMigrateFeatures_UpCheckDownUp(t *testing.T) {
	tangenttest.EnsureExtensions(t, "search")
	pool := tangenttest.OpenFeatures(t) // core only, public on the search_path
	ctx := context.Background()
	wantErrorContaining(t, store.CheckFeatures(ctx, pool, "search"), `feature "search" is not migrated`, "store.MigrateFeatures")
	if err := store.MigrateFeatures(ctx, pool, "search", "search"); err != nil {
		t.Fatal(err)
	}
	if got := indexCount(t, pool, searchIndexes); got != len(searchIndexes) {
		t.Fatalf("%d search indexes after up", got)
	}
	if err := store.MigrateFeatures(ctx, pool, "search"); err != nil {
		t.Fatalf("a second run must be a no-op: %v", err)
	}
	if err := store.CheckFeatures(ctx, pool, "search"); err != nil {
		t.Fatal(err)
	}
	if err := store.MigrateFeaturesDown(ctx, pool, "search"); err != nil {
		t.Fatal(err)
	}
	if got := indexCount(t, pool, searchIndexes); got != 0 {
		t.Fatalf("%d search indexes after down", got)
	}
	wantErrorContaining(t, store.CheckFeatures(ctx, pool, "search"), "not migrated")
	if err := store.MigrateFeatures(ctx, pool, "search"); err != nil {
		t.Fatal(err)
	}
	if err := store.CheckFeatures(ctx, pool, "search"); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateFeatures_RefusesUnknownFeaturesAndMissingExtensions(t *testing.T) {
	pool := tangenttest.OpenFeatures(t)
	ctx := context.Background()
	wantErrorContaining(t, store.MigrateFeatures(ctx, pool, "notes"), `"notes" has no migrations`)
	wantErrorContaining(t, store.CheckFeatures(ctx, pool, "nope"), `"nope" has no migrations`)
	wantErrorContaining(t, store.MigrateFeaturesDown(ctx, pool, "nope"), `"nope" has no migrations`)

	restore := store.SetFeatureExtension("search", "tangent_no_such_extension")
	defer restore()
	wantErrorContaining(t, store.MigrateFeatures(ctx, pool, "search"), "tangent_no_such_extension", "does not have", "leave the feature off")
	wantErrorContaining(t, store.CheckFeatures(ctx, pool, "search"), "needs the Postgres extension tangent_no_such_extension", "store.MigrateFeatures")
	if got := indexCount(t, pool, searchIndexes); got != 0 {
		t.Fatalf("a refused migration left %d indexes", got)
	}
}

func TestMigrateFeatures_RefusesAnExtensionOffTheSearchPath(t *testing.T) {
	tangenttest.EnsureExtensions(t, "search") // in public
	pool := tangenttest.OpenSchema(t)         // only the test schema on the search_path
	ctx := context.Background()
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	wantErrorContaining(t, store.MigrateFeatures(ctx, pool, "search"), `installed in schema "public"`, "search_path")
	wantErrorContaining(t, store.CheckFeatures(ctx, pool, "search"), `installed in schema "public"`)
}

// latestCoreVersion is the newest applied core migration.
func latestCoreVersion(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	versions := appliedVersions(t, pool)
	if len(versions) == 0 {
		t.Fatal("no core migration applied")
	}
	return versions[len(versions)-1]
}

// Reverting core tables drops the indexes built on them, so their feature
// migrations must be reverted too, or a re-run would skip them.
func TestMigrateDown_RevertsFeatureMigrationsBeforeCoreSteps(t *testing.T) {
	for _, target := range []int{0, 1} {
		t.Run(fmt.Sprintf("target %d", target), func(t *testing.T) {
			pool := tangenttest.OpenFeatures(t, "search")
			ctx := context.Background()
			if err := store.MigrateDown(ctx, pool, target); err != nil {
				t.Fatal(err)
			}
			wantErrorContaining(t, store.CheckFeatures(ctx, pool, "search"), "not migrated")
			if err := store.Migrate(ctx, pool); err != nil {
				t.Fatal(err)
			}
			if err := store.MigrateFeatures(ctx, pool, "search"); err != nil {
				t.Fatal(err)
			}
			if got := indexCount(t, pool, searchIndexes); got != len(searchIndexes) {
				t.Fatalf("%d of %d search indexes after the re-run", got, len(searchIndexes))
			}
			if err := store.CheckFeatures(ctx, pool, "search"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMigrateDown_ToTheCurrentVersionKeepsFeatureMigrations(t *testing.T) {
	pool := tangenttest.OpenFeatures(t, "search")
	ctx := context.Background()
	latest := latestCoreVersion(t, pool)
	for _, target := range []int{latest, latest + 10} {
		if err := store.MigrateDown(ctx, pool, target); err != nil {
			t.Fatal(err)
		}
		if got := indexCount(t, pool, searchIndexes); got != len(searchIndexes) {
			t.Fatalf("MigrateDown(%d) left %d of %d search indexes", target, got, len(searchIndexes))
		}
		if err := store.CheckFeatures(ctx, pool, "search"); err != nil {
			t.Fatalf("MigrateDown(%d): %v", target, err)
		}
	}
}
