package tangent

import (
	"context"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// OpenLoops lists what conversations left unfinished (DESIGN §12 B9): open
// branches idle longer than N days (default Limits.OpenLoops.StaleAfter,
// 3 days), notes to confirm (while notes is on), open seeds (while parking
// is on) and open suggestions (of the features that are on), for the whole
// tenant or one conversation. Read-only, no model and no table of its own;
// the items are acted on with the existing calls (discard, notes, seeds,
// the inbox). Off: OpenLoops returns feature_disabled.
func OpenLoops() Feature { return onOff(FeatureOpenLoops, nil) }

// OpenLoopsInput asks for the open loops of the tenant, or of the
// conversation of LineID (any of its lines). StaleDays (1..365, 0 for the
// default) is how many idle days make an open branch stale.
type OpenLoopsInput struct {
	LineID    string
	StaleDays int
}

// OpenLoopsList is the listing: the kinds whose feature is off are nil.
// StaleDays is the idle threshold that was applied.
type OpenLoopsList struct {
	store.OpenLoops
	StaleDays int `json:"staleDays"`
}

// Open-loop item types, as the store returns them.
type (
	OpenBranch     = store.OpenBranch
	OpenNote       = store.OpenNote
	OpenSeed       = store.OpenSeed
	OpenSuggestion = store.OpenSuggestion
)

// OpenLoops lists the open loops asked for.
func (e *Engine) OpenLoops(ctx context.Context, scope Scope, in OpenLoopsInput) (OpenLoopsList, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureOpenLoops)
	if err != nil {
		return OpenLoopsList{}, err
	}
	age, err := domain.OpenLoopStaleAge(in.StaleDays, e.limits.OpenLoops)
	if err != nil {
		return OpenLoopsList{}, err
	}
	loops, err := e.store.OpenLoops(ctx, store.OpenLoopsQuery{
		Tenant: scope.Tenant, LineID: in.LineID, IdleBefore: e.now().Add(-age),
		Notes: modes.of(FeatureNotes) != ModeOff, Seeds: modes.of(FeatureParking) != ModeOff, SuggestionFeatures: e.features.producers(modes),
	})
	if err != nil {
		return OpenLoopsList{}, err
	}
	return OpenLoopsList{OpenLoops: loops, StaleDays: int(age / (24 * time.Hour))}, nil
}
