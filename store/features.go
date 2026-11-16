package store

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"path"
	"slices"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// FeatureMigrationsFS holds the migrations of the features that need a
// database extension (DESIGN §11): features/<feature>/NNN_name.up.sql and
// .down.sql. They run only for features a host enables, through
// MigrateFeatures; every other feature's tables come with the core
// migrations.
//
//go:embed features/*/*.sql
var FeatureMigrationsFS embed.FS

const (
	featuresDir               = "features"
	createFeatureVersionTable = `CREATE TABLE IF NOT EXISTS tangent_feature_migrations (
    feature TEXT NOT NULL,
    version INT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (feature, version)
)`
	sqlStateUniqueViolation = "23505"
	sqlStateUndefinedTable  = "42P01"
)

// featureExtensions names the Postgres extension each feature needs. A
// variable so tests can ask for an extension the server does not have.
var featureExtensions = map[string]string{"search": "pg_trgm", "memory": "vector"}

// FeatureExtension names the extension of a feature that brings its own
// migrations; ok is false for every other feature (nothing to migrate).
func FeatureExtension(feature string) (extension string, ok bool) {
	extension, ok = featureExtensions[feature]
	return extension, ok
}

// MigrateFeatures installs what the named features need: their extension
// (CREATE EXTENSION IF NOT EXISTS, which needs the right to create it) and
// their pending migrations, each in its own transaction, recorded in
// tangent_feature_migrations. It runs under the same advisory lock as
// Migrate, after it. A feature without migrations is an error, so a typo
// never passes silently.
//
// The extension is created without a schema, so it lands in the first
// schema of the connection's search_path, like tangent's tables. A host
// that wants it in a shared schema installs it there beforehand (CREATE
// EXTENSION ... SCHEMA ...); an installed extension is then only checked
// to be on the search_path.
func MigrateFeatures(ctx context.Context, pool *pgxpool.Pool, features ...string) error {
	plans, err := featurePlans(features)
	if err != nil {
		return err
	}
	return withMigrationLock(ctx, pool, func(conn *pgx.Conn) error {
		if _, err := conn.Exec(ctx, createFeatureVersionTable); err != nil {
			return fmt.Errorf("migrate features: create the version table: %w", err)
		}
		for _, plan := range plans {
			if err := migrateFeature(ctx, conn, plan); err != nil {
				return err
			}
		}
		return nil
	})
}

// MigrateFeaturesDown reverts every applied migration of the named
// features, newest first. Extensions stay installed.
func MigrateFeaturesDown(ctx context.Context, pool *pgxpool.Pool, features ...string) error {
	plans, err := featurePlans(features)
	if err != nil {
		return err
	}
	return withMigrationLock(ctx, pool, func(conn *pgx.Conn) error {
		if _, err := conn.Exec(ctx, createFeatureVersionTable); err != nil {
			return fmt.Errorf("migrate features: create the version table: %w", err)
		}
		return revertFeatures(ctx, conn, plans)
	})
}

// revertFeatures reverts the applied migrations of the planned features,
// newest first. A missing version table means nothing was applied.
func revertFeatures(ctx context.Context, conn *pgx.Conn, plans []featurePlan) error {
	for _, plan := range plans {
		applied, err := featureVersions(ctx, conn, plan.feature)
		if err != nil {
			return err
		}
		for _, m := range slices.Backward(plan.migrations) {
			if applied[m.version] {
				if err := applyFeatureStep(ctx, conn, plan.feature, m.version, m.down, false); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// CheckFeatures reports, with an error that says what to run, a feature
// whose extension is missing or not on the search_path, or whose
// migrations were not applied. tangent.New calls it for the features it is
// given.
func CheckFeatures(ctx context.Context, pool *pgxpool.Pool, features ...string) error {
	plans, err := featurePlans(features)
	if err != nil {
		return err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("check features: acquire connection: %w", err)
	}
	defer conn.Release()
	for _, plan := range plans {
		if err := checkExtensionVisible(ctx, conn.Conn(), plan.feature, plan.extension); err != nil {
			return err
		}
		applied, err := featureVersions(ctx, conn.Conn(), plan.feature)
		if err != nil {
			return err
		}
		for _, m := range plan.migrations {
			if !applied[m.version] {
				return fmt.Errorf("feature %q is not migrated: run store.MigrateFeatures(ctx, pool, %q)", plan.feature, plan.feature)
			}
		}
	}
	return nil
}

// featurePlan is one feature's extension and migrations.
type featurePlan struct {
	feature    string
	extension  string
	migrations []migration
}

// featurePlans loads the named features' migrations, each feature once, in
// name order.
func featurePlans(features []string) ([]featurePlan, error) {
	names := slices.Clone(features)
	sort.Strings(names)
	names = slices.Compact(names)
	plans := make([]featurePlan, 0, len(names))
	for _, name := range names {
		extension, ok := featureExtensions[name]
		if !ok {
			return nil, fmt.Errorf("migrate features: feature %q has no migrations of its own", name)
		}
		migrations, err := loadMigrationsFrom(FeatureMigrationsFS, path.Join(featuresDir, name))
		if err != nil {
			return nil, err
		}
		plans = append(plans, featurePlan{feature: name, extension: extension, migrations: migrations})
	}
	return plans, nil
}

// migrateFeature installs the extension, then applies the pending steps.
func migrateFeature(ctx context.Context, conn *pgx.Conn, plan featurePlan) error {
	if err := ensureExtension(ctx, conn, plan.feature, plan.extension); err != nil {
		return err
	}
	applied, err := featureVersions(ctx, conn, plan.feature)
	if err != nil {
		return err
	}
	for _, m := range plan.migrations {
		if applied[m.version] {
			continue
		}
		if err := applyFeatureStep(ctx, conn, plan.feature, m.version, m.up, true); err != nil {
			return err
		}
	}
	return nil
}

// ensureExtension creates the extension when the server has it and it is
// not installed yet, and then checks its objects are on the search_path.
func ensureExtension(ctx context.Context, conn *pgx.Conn, feature, extension string) error {
	installed, _, err := extensionSchema(ctx, conn, extension)
	if err != nil {
		return err
	}
	if !installed {
		var available bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = $1)`, extension).Scan(&available); err != nil {
			return fmt.Errorf("feature %q: look up the %s extension: %w", feature, extension, err)
		}
		if !available {
			return fmt.Errorf("feature %q needs the Postgres extension %s, which this database server does not have (install the postgresql contrib package, or leave the feature off)", feature, extension)
		}
		_, err := conn.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS "+pgx.Identifier{extension}.Sanitize())
		var pgErr *pgconn.PgError
		// Another process created it at the same moment: that is fine.
		if err != nil && !(errors.As(err, &pgErr) && pgErr.Code == sqlStateUniqueViolation) {
			return fmt.Errorf("feature %q: CREATE EXTENSION %s failed (a superuser or the database owner can run it once): %w", feature, extension, err)
		}
	}
	return checkExtensionVisible(ctx, conn, feature, extension)
}

// checkExtensionVisible refuses an extension that is missing or installed in
// a schema the connection's search_path does not include.
func checkExtensionVisible(ctx context.Context, conn *pgx.Conn, feature, extension string) error {
	installed, visible, err := extensionSchema(ctx, conn, extension)
	switch {
	case err != nil:
		return err
	case !installed:
		return fmt.Errorf("feature %q needs the Postgres extension %s: run store.MigrateFeatures(ctx, pool, %q) (it runs CREATE EXTENSION %s)", feature, extension, feature, extension)
	case visible == "":
		return nil
	}
	return fmt.Errorf("feature %q: the %s extension is installed in schema %q, which is not on the connection's search_path; add it to the search_path", feature, extension, visible)
}

// extensionSchema reports whether the extension is installed and, when its
// schema is not on the search_path, that schema's name ("" when visible).
func extensionSchema(ctx context.Context, conn *pgx.Conn, extension string) (installed bool, invisibleIn string, err error) {
	var schema string
	var visible bool
	err = conn.QueryRow(ctx, `SELECT n.nspname, n.nspname = ANY (current_schemas(false))
		FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1`, extension).Scan(&schema, &visible)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, "", nil
	}
	if err != nil {
		return false, "", fmt.Errorf("look up the %s extension: %w", extension, err)
	}
	if visible {
		return true, "", nil
	}
	return true, schema, nil
}

// featureVersions reads the applied versions of one feature; none when the
// version table does not exist yet.
func featureVersions(ctx context.Context, conn *pgx.Conn, feature string) (map[int]bool, error) {
	var versions []int32
	rows, err := conn.Query(ctx, `SELECT version FROM tangent_feature_migrations WHERE feature = $1`, feature)
	if err == nil {
		versions, err = pgx.CollectRows(rows, pgx.RowTo[int32])
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == sqlStateUndefinedTable {
		return map[int]bool{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("feature %q: read applied versions: %w", feature, err)
	}
	out := make(map[int]bool, len(versions))
	for _, v := range versions {
		out[int(v)] = true
	}
	return out, nil
}

// applyFeatureStep runs one direction of a feature migration and records it,
// atomically.
func applyFeatureStep(ctx context.Context, conn *pgx.Conn, feature string, version int, sql string, up bool) error {
	record := `DELETE FROM tangent_feature_migrations WHERE feature = $1 AND version = $2`
	direction := "down"
	if up {
		record, direction = `INSERT INTO tangent_feature_migrations (feature, version) VALUES ($1, $2)`, "up"
	}
	err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, sql); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, record, feature, version)
		return err
	})
	if err != nil {
		return fmt.Errorf("migrate feature %q: %s %03d: %w", feature, direction, version, err)
	}
	return nil
}
