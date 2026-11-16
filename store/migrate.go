package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MigrationsFS holds the core migrations, migrations/NNN_name.up.sql and
// .down.sql. A host with its own migrator can apply these files instead of
// calling Migrate.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS

const (
	migrationsDir = "migrations"
	// migrationLockName is the first key of the advisory lock that
	// serialises migrators of one schema (the schema is the second).
	migrationLockName  = "tangent_schema_migrations"
	createVersionTable = `CREATE TABLE IF NOT EXISTS tangent_schema_migrations (
    version INT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`
)

// migration is one numbered step with both directions.
type migration struct {
	version  int
	up, down string
}

// Migrate applies every pending core migration in order, each in its own
// transaction, recording it in tangent_schema_migrations. A Postgres
// advisory lock makes concurrent processes wait for each other instead of
// racing. Tables are created unqualified, in the first schema of the
// connection's search_path.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	return withMigrationLock(ctx, pool, func(conn *pgx.Conn) error {
		applied, err := appliedVersions(ctx, conn)
		if err != nil {
			return err
		}
		for _, m := range migrations {
			if applied[m.version] {
				continue
			}
			if err := applyStep(ctx, conn, m.version, m.up, true); err != nil {
				return err
			}
		}
		return nil
	})
}

// MigrateDown reverts the applied core migrations newer than target, newest
// first; target 0 removes every core table (the version table stays).
// Feature migrations build on the core tables, so when any core step is
// reverted every applied feature migration is reverted first (as
// MigrateFeaturesDown does); a later MigrateFeatures applies them again.
func MigrateDown(ctx context.Context, pool *pgxpool.Pool, target int) error {
	if target < 0 {
		return fmt.Errorf("migrate: target version %d must not be negative", target)
	}
	migrations, err := loadMigrations()
	if err != nil {
		return err
	}
	slices.Reverse(migrations)
	features, err := featurePlans(slices.Collect(maps.Keys(featureExtensions)))
	if err != nil {
		return err
	}
	return withMigrationLock(ctx, pool, func(conn *pgx.Conn) error {
		applied, err := appliedVersions(ctx, conn)
		if err != nil {
			return err
		}
		var steps []migration
		for _, m := range migrations {
			if m.version > target && applied[m.version] {
				steps = append(steps, m)
			}
		}
		if len(steps) == 0 {
			return nil
		}
		if err := revertFeatures(ctx, conn, features); err != nil {
			return err
		}
		for _, m := range steps {
			if err := applyStep(ctx, conn, m.version, m.down, false); err != nil {
				return err
			}
		}
		return nil
	})
}

// withMigrationLock holds the advisory lock on one connection while fn runs.
func withMigrationLock(ctx context.Context, pool *pgxpool.Pool, fn func(*pgx.Conn) error) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("migrate: acquire connection: %w", err)
	}
	defer conn.Release()
	var schema *string
	if err := conn.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		return fmt.Errorf("migrate: read the current schema: %w", err)
	}
	if schema == nil {
		return errors.New("migrate: no schema of the search_path exists; create it or fix the search_path")
	}
	// Two int4 keys: one for tangent's migrator, one for the schema.
	const key = `hashtext($1), hashtext($2)`
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(`+key+`)`, migrationLockName, *schema); err != nil {
		return fmt.Errorf("migrate: take the lock: %w", err)
	}
	defer func() {
		// The lock must go even when ctx was cancelled; a failure here closes
		// the session, which releases it too.
		if _, err := conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(`+key+`)`, migrationLockName, *schema); err != nil {
			_ = conn.Conn().Close(context.WithoutCancel(ctx))
		}
	}()
	if _, err := conn.Exec(ctx, createVersionTable); err != nil {
		return fmt.Errorf("migrate: create the version table: %w", err)
	}
	return fn(conn.Conn())
}

func appliedVersions(ctx context.Context, conn *pgx.Conn) (map[int]bool, error) {
	rows, err := conn.Query(ctx, `SELECT version FROM tangent_schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("migrate: read applied versions: %w", err)
	}
	versions, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	if err != nil {
		return nil, fmt.Errorf("migrate: read applied versions: %w", err)
	}
	out := make(map[int]bool, len(versions))
	for _, v := range versions {
		out[int(v)] = true
	}
	return out, nil
}

// applyStep runs one direction of a migration and records it, atomically.
func applyStep(ctx context.Context, conn *pgx.Conn, version int, sql string, up bool) error {
	record := `DELETE FROM tangent_schema_migrations WHERE version = $1`
	direction := "down"
	if up {
		record, direction = `INSERT INTO tangent_schema_migrations (version) VALUES ($1)`, "up"
	}
	err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, sql); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, record, version)
		return err
	})
	if err != nil {
		return fmt.Errorf("migrate: %s %03d: %w", direction, version, err)
	}
	return nil
}

// loadMigrations reads and pairs the embedded core files, ordered by version.
func loadMigrations() ([]migration, error) {
	return loadMigrationsFrom(MigrationsFS, migrationsDir)
}

// loadMigrationsFrom reads and pairs the files of one directory, ordered by
// version.
func loadMigrationsFrom(fsys fs.FS, dir string) ([]migration, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("migrate: read migrations: %w", err)
	}
	byVersion := map[int]*migration{}
	for _, entry := range entries {
		version, up, ok := parseMigrationName(entry.Name())
		if !ok {
			return nil, fmt.Errorf("migrate: unexpected file %s", entry.Name())
		}
		body, err := fs.ReadFile(fsys, path.Join(dir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("migrate: read %s: %w", entry.Name(), err)
		}
		m := byVersion[version]
		if m == nil {
			m = &migration{version: version}
			byVersion[version] = m
		}
		if up {
			m.up = string(body)
		} else {
			m.down = string(body)
		}
	}
	out := make([]migration, 0, len(byVersion))
	for _, m := range byVersion {
		if m.up == "" || m.down == "" {
			return nil, fmt.Errorf("migrate: version %03d lacks its up or down file", m.version)
		}
		out = append(out, *m)
	}
	slices.SortFunc(out, func(a, b migration) int { return a.version - b.version })
	return out, nil
}

// parseMigrationName splits "NNN_name.up.sql" into its version and direction.
func parseMigrationName(name string) (version int, up bool, ok bool) {
	var rest string
	switch {
	case strings.HasSuffix(name, ".up.sql"):
		rest, up = strings.TrimSuffix(name, ".up.sql"), true
	case strings.HasSuffix(name, ".down.sql"):
		rest = strings.TrimSuffix(name, ".down.sql")
	default:
		return 0, false, false
	}
	number, _, found := strings.Cut(rest, "_")
	if !found {
		return 0, false, false
	}
	version, err := strconv.Atoi(number)
	if err != nil || version <= 0 {
		return 0, false, false
	}
	return version, up, true
}
