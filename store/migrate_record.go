package store

import (
	"context"
	"fmt"
	"strings"
)

// A host that applies MigrationsFS and FeatureMigrationsFS with its own
// migrator records each step here, inside the transaction that applied it:
// tangent.New checks tangent_feature_migrations for features with
// migrations, and with tangent_schema_migrations kept right the host can
// switch to Migrate later without replaying anything. Both create their
// version table when it is missing; recorded is false for a step that was
// recorded before (so a migrator can record first and apply only a new
// step, in one transaction).

// RecordFeatureMigration records that version of feature's migrations was
// applied (feature as in FeatureMigrationsFS, for example "search").
func RecordFeatureMigration(ctx context.Context, tx Tx, feature string, version int) (recorded bool, err error) {
	feature = strings.TrimSpace(feature)
	if feature == "" || version < 1 {
		return false, fmt.Errorf("record feature migration: a feature name and a version from 1 are required")
	}
	if _, err := tx.Exec(ctx, createFeatureVersionTable); err != nil {
		return false, fmt.Errorf("record feature migration: %w", err)
	}
	tag, err := tx.Exec(ctx, `INSERT INTO tangent_feature_migrations (feature, version) VALUES ($1, $2) ON CONFLICT DO NOTHING`, feature, version)
	if err != nil {
		return false, fmt.Errorf("record feature migration: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// RecordCoreMigration records that core migration version was applied.
func RecordCoreMigration(ctx context.Context, tx Tx, version int) (recorded bool, err error) {
	if version < 1 {
		return false, fmt.Errorf("record migration: versions start at 1")
	}
	if _, err := tx.Exec(ctx, createVersionTable); err != nil {
		return false, fmt.Errorf("record migration: %w", err)
	}
	tag, err := tx.Exec(ctx, `INSERT INTO tangent_schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING`, version)
	if err != nil {
		return false, fmt.Errorf("record migration: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}
