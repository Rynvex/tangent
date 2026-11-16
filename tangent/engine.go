// Package tangent is the conversation-branch engine: it combines the store
// and the domain logic with the host's hooks into the turn protocol, the
// branch operations and background jobs, and publishes events after every
// commit. See docs/DESIGN.md §6.
package tangent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Scope is who a call is for. Tenant is required; Actor is written into
// created_by.
type Scope struct {
	Tenant string
	Actor  string
}

// TxHook runs inside a write's transaction before the commit; an error rolls
// the whole write back. See store.TxHook.
type TxHook = store.TxHook

// TxOption adds to a write's transaction.
type TxOption func(*txOptions)

type txOptions struct {
	hooks []TxHook
	// first run before the features' hooks (an accepted suggestion is
	// marked before a closing branch expires the others about it).
	first []TxHook
}

// InTx runs h inside the write's transaction, after the library's own writes
// (DeleteTree: before the rows go) and before the commit.
func InTx(h TxHook) TxOption {
	return func(o *txOptions) {
		if h != nil {
			o.hooks = append(o.hooks, h)
		}
	}
}

func hooksOf(opts []TxOption) []TxHook {
	first, host := splitHooks(opts)
	return append(first, host...)
}

// splitHooks separates the hooks that run before the features' from the
// host's.
func splitHooks(opts []TxOption) (first, host []TxHook) {
	o := txOptions{}
	for _, opt := range opts {
		if opt != nil {
			opt(&o)
		}
	}
	return o.first, o.hooks
}

// inTxFirst runs h before the features' in-transaction hooks.
func inTxFirst(h TxHook) TxOption {
	return func(o *txOptions) { o.first = append(o.first, h) }
}

// Engine runs conversations with branches over a host's pool.
type Engine struct {
	store       *store.Store
	limits      domain.Limits
	publisher   Publisher
	contributor PromptContributor
	gate        TurnGate
	markers     []string
	leafTexts   domain.LeafTexts
	now         func() time.Time
	log         *slog.Logger
	features    *registry
	policy      FeaturePolicy
	deltas      *deltaRegistry
	turns       *turnCache
	inflight    *inflightRuns
	staleTurn   time.Duration
	jobsMu      sync.Mutex
	jobSink     Dispatcher
	pricing     map[string]Price
	streams     *streamFilters
	defaults    modelPair
	allowModel  func(provider, model string) bool
	catalog     []ModelGroup
	// deltaSink, when set, takes the deltas instead of this process's
	// buffer (WithDeltaSink: a worker process).
	deltaSink DeltaSink
}

// New builds an engine over the pool. The schema must be migrated
// (store.Migrate, and store.MigrateFeatures for a feature with migrations of
// its own, such as Search). It refuses limits that cannot work, features
// whose dependencies are missing and features whose migrations were not
// applied (checked against the database, within 10 seconds).
func New(pool *pgxpool.Pool, opts ...Option) (*Engine, error) {
	if pool == nil {
		return nil, errors.New("tangent: pool is required")
	}
	cfg := defaultConfig()
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	features, err := buildRegistry(cfg.features)
	if err != nil {
		return nil, err
	}
	if err := checkFeatureSchema(pool, features); err != nil {
		return nil, err
	}
	storeOpts := []store.Option{store.WithClock(cfg.now)}
	if cfg.labels != nil {
		storeOpts = append(storeOpts, store.WithNoteSourceLabels(*cfg.labels))
	}
	s, err := store.New(pool, cfg.limits, storeOpts...)
	if err != nil {
		return nil, fmt.Errorf("tangent: %w", err)
	}
	return &Engine{
		store: s, limits: s.Limits(), publisher: cfg.publisher, contributor: cfg.contributor, gate: cfg.gate,
		markers: cfg.markers, leafTexts: cfg.leafTexts, now: cfg.now, log: cfg.logger, features: features, policy: cfg.policy,
		deltas: newDeltaRegistry(cfg.now), turns: newTurnCache(), inflight: newInflightRuns(), staleTurn: cfg.staleTurn,
		pricing: cfg.pricing, defaults: cfg.defaults, streams: newStreamFilters(domain.ProtocolMarkers(cfg.markers), cfg.partialEvery, cfg.partialBytes), allowModel: cfg.allowModel,
		catalog: cfg.catalog, deltaSink: cfg.deltaSink,
	}, nil
}

// checkFeatureSchema refuses features whose own migrations (and extension)
// are missing, with an error that names what to run.
func checkFeatureSchema(pool *pgxpool.Pool, features *registry) error {
	names := featuresNeedingMigrations(features)
	if len(names) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), checkFeatureSchemaTimeout)
	defer cancel()
	if err := store.CheckFeatures(ctx, pool, names...); err != nil {
		return fmt.Errorf("tangent: %w", err)
	}
	return nil
}

// FeatureConfigured reports whether the engine was built with the feature
// enabled (any mode but off), before any FeaturePolicy narrows it. httpapi
// mounts a feature's routes only when it is.
func (e *Engine) FeatureConfigured(name string) bool {
	if name == FeatureSuggestions {
		return len(e.features.suggestionKinds) > 0
	}
	_, ok := e.features.modes[name]
	return ok
}

// Limits returns the limits the engine applies, defaults filled in.
func (e *Engine) Limits() domain.Limits { return e.limits }

// checkScope refuses a call without a tenant.
func checkScope(scope Scope) (Scope, error) {
	scope.Tenant = strings.TrimSpace(scope.Tenant)
	scope.Actor = strings.TrimSpace(scope.Actor)
	if scope.Tenant == "" {
		return scope, domain.NewError(domain.CodeInvalidInput, "the scope has no tenant", nil)
	}
	return scope, nil
}

// detached is a context for writing a result back after the caller's
// context ended (a cancelled request must still record what happened).
func detached(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), writeBackTimeout)
}

// writeBackTimeout bounds a write-back on a detached context.
const writeBackTimeout = 15 * time.Second
