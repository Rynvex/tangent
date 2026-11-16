package embedding

import (
	"context"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// Step is one migration file as a host's own migrator sees it.
type Step struct {
	Version int
	Name    string // the file name, for the host's log
	SQL     string
}

// snippet:own-migrator
// TangentSteps lists the up migrations of an embedded tangent FS directory
// in order: "migrations" in store.MigrationsFS, or "features/<name>" in
// store.FeatureMigrationsFS. File names are NNN_name.up.sql.
func TangentSteps(fsys fs.FS, dir string) ([]Step, error) {
	names, err := fs.Glob(fsys, path.Join(dir, "*.up.sql"))
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	steps := make([]Step, 0, len(names))
	for _, name := range names {
		base := path.Base(name)
		version, err := strconv.Atoi(strings.SplitN(base, "_", 2)[0])
		if err != nil {
			return nil, fmt.Errorf("%s: no version prefix", name)
		}
		sql, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil, err
		}
		steps = append(steps, Step{Version: version, Name: base, SQL: string(sql)})
	}
	return steps, nil
}

// ApplyWithOwnMigrator applies tangent's core steps (and the search
// feature's) the way a host migrator would, each step in its own
// transaction. It records each step with store.RecordCoreMigration /
// store.RecordFeatureMigration in the step's transaction: tangent.New
// checks tangent_feature_migrations for features with migrations, and
// keeping tangent_schema_migrations right lets the host switch to
// store.Migrate later without replaying anything.
func ApplyWithOwnMigrator(ctx context.Context, pool *pgxpool.Pool) error {
	core, err := TangentSteps(store.MigrationsFS, "migrations")
	if err != nil {
		return err
	}
	search, err := TangentSteps(store.FeatureMigrationsFS, "features/search")
	if err != nil {
		return err
	}
	for _, s := range core {
		record := func(tx pgx.Tx) (bool, error) { return store.RecordCoreMigration(ctx, tx, s.Version) }
		if err := applyOnce(ctx, pool, s, record); err != nil {
			return err
		}
	}
	// The feature's extension (pg_trgm) is installed beforehand by whoever may
	// create extensions, in a schema on the connection's search_path.
	for _, s := range search {
		record := func(tx pgx.Tx) (bool, error) {
			return store.RecordFeatureMigration(ctx, tx, tangent.FeatureSearch, s.Version)
		}
		if err := applyOnce(ctx, pool, s, record); err != nil {
			return err
		}
	}
	return nil
}

// endsnippet

// applyOnce records the step and, only when it was not recorded before,
// runs it, in one transaction.
func applyOnce(ctx context.Context, pool *pgxpool.Pool, s Step, record func(pgx.Tx) (bool, error)) error {
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		recorded, err := record(tx)
		if err != nil {
			return fmt.Errorf("%s: record: %w", s.Name, err)
		}
		if !recorded {
			return nil // applied before
		}
		if _, err := tx.Exec(ctx, s.SQL); err != nil {
			return fmt.Errorf("%s: %w", s.Name, err)
		}
		return nil
	})
}
