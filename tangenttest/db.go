// Package tangenttest holds test helpers for tangent and for hosts that embed
// it: a fresh, fully migrated Postgres schema per test, a programmable fake
// Runner and an event Recorder.
//
// Connection budget: every Open / OpenSchema holds a small admin pool (at
// most 2 connections) and the schema's pool (at most 8) until the test ends,
// so up to 10 connections per test; run fewer parallel DB tests than
// max_connections / 10.
package tangenttest

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/url"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/store"
)

const (
	// EnvDatabaseURL overrides the test database connection string.
	EnvDatabaseURL = "TANGENT_TEST_DATABASE_URL"
	// DefaultDatabaseURL is the docker compose test database.
	DefaultDatabaseURL = "postgres://tangent:tangent@localhost:5444/tangent_test?sslmode=disable"
	// EnvRequireDB set to 1 turns "database unreachable" from a skip into a
	// failure (CI, where the database must be there).
	EnvRequireDB = "TANGENT_TEST_REQUIRE_DB"
	// TestTimeout bounds the context Context returns.
	TestTimeout = 30 * time.Second

	// schemaPrefix names every test schema, so leftovers of a crashed run are
	// easy to spot.
	schemaPrefix = "tangent_test_"
	// schemaIDLength is how many hex characters of a random id the name keeps.
	schemaIDLength = 16

	connectTimeout = 5 * time.Second
	basePoolSize   = 2
	schemaPoolSize = 8
)

// URL returns the configured test database URL.
func URL() string {
	if url := strings.TrimSpace(os.Getenv(EnvDatabaseURL)); url != "" {
		return url
	}
	return DefaultDatabaseURL
}

// Open returns a pool scoped to a fresh schema with every migration applied.
// The schema is dropped when the test ends. The test is skipped, with a clear
// message, when the database cannot be reached.
func Open(t testing.TB) *pgxpool.Pool {
	t.Helper()
	pool := OpenSchema(t)
	if err := store.Migrate(context.Background(), pool); err != nil {
		t.Fatalf("tangenttest: migrate: %v", err)
	}
	return pool
}

// OpenFeatures is Open plus the migrations of the named features
// (store.MigrateFeatures). Their extensions are installed once per test
// database in the public schema (EnsureExtensions), which this pool has on
// its search_path after the test schema.
func OpenFeatures(t testing.TB, features ...string) *pgxpool.Pool {
	t.Helper()
	EnsureExtensions(t, features...)
	pool := openSchema(t, true)
	if err := store.Migrate(context.Background(), pool); err != nil {
		t.Fatalf("tangenttest: migrate: %v", err)
	}
	if err := store.MigrateFeatures(context.Background(), pool, features...); err != nil {
		t.Fatalf("tangenttest: migrate features: %v", err)
	}
	return pool
}

// EnsureExtensions installs the extensions of the named features in the
// public schema of the test database, once (under an advisory lock, so
// parallel test binaries do not race). Installing them anywhere else would
// tie them to a test schema, and dropping that schema would drop them for
// every other test.
func EnsureExtensions(t testing.TB, features ...string) {
	t.Helper()
	for _, feature := range features {
		extension, err := installExtension(t, feature)
		if unavailableExtension(err) {
			t.Skipf("tangenttest: the %s extension is not installed on this Postgres server (%v); the %s tests need it (the dev database is pgvector/pgvector:pg17)", extension, err, feature)
		}
		if err != nil {
			t.Fatalf("tangenttest: install the %s extension: %v", extension, err)
		}
	}
}

// ExtensionAvailable installs the feature's extension like EnsureExtensions
// and reports whether the server has it (instead of skipping), so a test
// can leave the feature out.
func ExtensionAvailable(t testing.TB, feature string) bool {
	t.Helper()
	extension, err := installExtension(t, feature)
	if err != nil && !unavailableExtension(err) {
		t.Fatalf("tangenttest: install the %s extension: %v", extension, err)
	}
	return err == nil
}

// installExtension installs a feature's extension in the public schema,
// under an advisory lock; a feature without one needs nothing.
func installExtension(t testing.TB, feature string) (string, error) {
	t.Helper()
	extension, ok := store.FeatureExtension(feature)
	if !ok {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	base := openBase(ctx, t)
	defer base.Close()
	err := pgx.BeginFunc(ctx, base, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('tangenttest_extensions'))`); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, "CREATE EXTENSION IF NOT EXISTS "+pgx.Identifier{extension}.Sanitize()+" SCHEMA public")
		return err
	})
	return extension, err
}

// OpenSchema is Open without the migrations: an empty schema, for tests of
// the migrator itself. Only the test schema is on the search_path.
func OpenSchema(t testing.TB) *pgxpool.Pool {
	t.Helper()
	return openSchema(t, false)
}

// openSchema creates a fresh schema and a pool that resolves names in it
// (and then in public, withPublic).
func openSchema(t testing.TB, withPublic bool) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	base := openBase(ctx, t)
	schema := schemaPrefix + strings.ReplaceAll(uuid.NewString(), "-", "")[:schemaIDLength]
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := base.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		base.Close()
		t.Fatalf("tangenttest: create schema: %v", err)
	}
	cfg := base.Config()
	cfg.MaxConns = schemaPoolSize
	// Every pooled connection resolves unqualified names in the test schema.
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	if withPublic {
		cfg.ConnConfig.RuntimeParams["search_path"] = schema + ", public"
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		dropSchema(base, schema)
		base.Close()
		t.Fatalf("tangenttest: open schema pool: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		dropSchema(base, schema)
		base.Close()
	})
	return pool
}

// Context returns a context for one test: it ends with the test and after
// TestTimeout at the latest.
func Context(t testing.TB) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), TestTimeout)
	t.Cleanup(cancel)
	return ctx
}

// openBase connects to the test database. Only a database that cannot be
// reached (connection refused, timeout) skips the test, and not even that
// when EnvRequireDB is 1; bad credentials or a missing database fail it.
func openBase(ctx context.Context, t testing.TB) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(URL())
	if err != nil {
		t.Fatalf("tangenttest: parse %s: %v", EnvDatabaseURL, err)
	}
	cfg.MaxConns = basePoolSize
	cfg.ConnConfig.ConnectTimeout = connectTimeout
	base, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("tangenttest: open a pool for the test database: %v", err)
	}
	if err := base.Ping(ctx); err != nil {
		base.Close()
		if !unreachable(err) || os.Getenv(EnvRequireDB) == "1" {
			t.Fatalf("tangenttest: test database at %s: %v", redacted(), err)
		}
		t.Skipf("tangenttest: test database unreachable (run `make db-up`, set %s, or %s=1 to fail instead): %v", EnvDatabaseURL, EnvRequireDB, err)
	}
	return base
}

// unreachable reports whether err means nothing answered: the connection was
// refused or timed out.
func unreachable(err error) bool {
	if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// redacted is the test database URL without its password.
func redacted() string {
	cfg, err := pgxpool.ParseConfig(URL())
	if err != nil {
		return "(unparseable URL)"
	}
	return cfg.ConnConfig.Host + "/" + cfg.ConnConfig.Database
}

// dropSchema removes a test schema; a failure is logged, never fatal, so a
// cleanup problem does not hide the test's own result.
func dropSchema(base *pgxpool.Pool, schema string) {
	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	if _, err := base.Exec(ctx, "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
		slog.Warn("tangenttest: drop schema failed", "schema", schema, "error", err)
	}
}

// SchemaURL is a postgres:// URL that resolves names in pool's test schema
// (the pool's own connection string does not carry its search_path, so a
// host process opened with it would migrate into public). It checks the URL
// before returning it, and skips the test when the database is not given as
// a URL.
func SchemaURL(t testing.TB, pool *pgxpool.Pool) string {
	t.Helper()
	cfg := pool.Config()
	path := cfg.ConnConfig.RuntimeParams["search_path"]
	u, err := url.Parse(cfg.ConnString())
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		t.Skipf("the test database is not given as a postgres:// URL: %v", err)
	}
	query := u.Query()
	query.Set("search_path", path)
	u.RawQuery = query.Encode()
	conn, err := pgx.Connect(Context(t), u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(Context(t))
	var schema string
	if err := conn.QueryRow(Context(t), `SELECT current_schema()`).Scan(&schema); err != nil || schema != path {
		t.Fatalf("tangenttest: the URL resolves names in %q, not %q (%v)", schema, path, err)
	}
	return u.String()
}

// unavailableExtension: CREATE EXTENSION failed because the server does not
// ship the extension (feature_not_supported, or its control file is
// missing on older servers).
func unavailableExtension(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "0A000" || pgErr.Code == "58P01")
}
