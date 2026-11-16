package embedding

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
)

// snippet:features
func NewEngine(ctx context.Context, pool *pgxpool.Pool, tiers TierLookup) (*tangent.Engine, error) {
	if err := store.Migrate(ctx, pool); err != nil {
		return nil, fmt.Errorf("migrate tangent: %w", err)
	}
	// search needs pg_trgm: install it (or check it) and the feature's indexes.
	if err := store.MigrateFeatures(ctx, pool, tangent.FeatureSearch); err != nil {
		return nil, fmt.Errorf("migrate tangent search: %w", err)
	}
	return tangent.New(pool,
		tangent.WithFeatures(
			tangent.Notes(),
			tangent.Chapters(),
			tangent.Aside(),
			// Summaries and card drafts run on a cheaper model than the conversation.
			tangent.Summary(tangent.ModeAuto, tangent.JobModel("anthropic", "claude-haiku-4-5")),
			tangent.CardDraft(tangent.JobModel("anthropic", "claude-haiku-4-5")),
			tangent.BranchSuggest(tangent.ModeSuggest),
			tangent.Search(),
		),
		tangent.WithFeaturePolicy(TierPolicy{Tiers: tiers}),
	)
}

// endsnippet

// snippet:policy
// TierLookup is the host's own answer to "which plan is this tenant on".
type TierLookup func(ctx context.Context, tenant string) string

// TierPolicy narrows the configured features for tenants on the free plan.
// A policy can only narrow: returning ModeAuto keeps what was configured.
type TierPolicy struct{ Tiers TierLookup }

func (p TierPolicy) Mode(ctx context.Context, scope tangent.Scope, feature string) tangent.Mode {
	if p.Tiers(ctx, scope.Tenant) != "free" {
		return tangent.ModeAuto
	}
	switch feature {
	case tangent.FeatureSummary:
		return tangent.ModeManual // only when the operator presses "compact"
	case tangent.FeatureBranchSuggest, tangent.FeatureSearch:
		return tangent.ModeOff // capabilities say disabled; the routes answer 404 feature_disabled
	}
	return tangent.ModeAuto
}

// endsnippet
