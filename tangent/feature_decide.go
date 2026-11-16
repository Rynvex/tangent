package tangent

import (
	"context"
	"slices"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// DecideInput chooses a compared branch; Line replaces the decision leaf's
// line (by default the recommendation's reason when it is the recommended
// one, else the branch's purpose).
type DecideInput struct {
	LineID string
	Line   string
}

// DecidedComparison is what a decision changed (the comparison, the chosen
// branch and its decision leaf, the branches it discarded and their
// dead-end leaves).
type DecidedComparison = store.DecidedComparison

// DecideComparison decides a ready comparison in one transaction: the
// chosen branch gets a decision leaf (its matrix column as the body) and
// stays open; every other compared branch still open under the parent is
// discarded with a dead-end leaf (WithLeafTexts: "沒選：改走「…」" by default, its column as
// the body), and open suggestions about them expire. No AfterCommit hook of
// a discard runs (no leaf draft, relation or group suggestion is started).
// Refusals: comparison_not_found, comparison_decided, comparison_not_ready,
// invalid_comparison (not an option), branch_closed, branch_busy,
// branch_drafting, archived.
// InTx hooks receive store.DecidedComparison.
func (e *Engine) DecideComparison(ctx context.Context, scope Scope, comparisonID string, in DecideInput, opts ...TxOption) (DecidedComparison, error) {
	scope, modes, err := e.needScoped(ctx, scope, FeatureDiverge)
	if err != nil {
		return DecidedComparison{}, err
	}
	ctx = e.inbox(ctx, modes)
	decide, err := e.decideInput(ctx, scope, comparisonID, in)
	if err != nil {
		return DecidedComparison{}, err
	}
	var expired []domain.Suggestion
	expire := inTxFirst(func(ctx context.Context, tx store.Tx, result any) (err error) {
		decided, _ := result.(store.DecidedComparison)
		ids := make([]string, 0, len(decided.Discarded))
		for _, view := range decided.Discarded {
			ids = append(ids, view.LineID)
		}
		expired, err = store.ExpireSuggestions(ctx, tx, ids)
		return err
	})
	out, err := e.store.DecideComparison(ctx, decide, hooksOf(append([]TxOption{expire}, opts...))...)
	if err != nil {
		return DecidedComparison{}, err
	}
	e.publishDecided(ctx, scope, out, expired)
	return out, nil
}

// decideInput reads the comparison and builds the leaves from its matrix
// (the store checks the comparison again under its locks).
func (e *Engine) decideInput(ctx context.Context, scope Scope, comparisonID string, in DecideInput) (store.DecideInput, error) {
	c, err := e.store.GetComparison(ctx, scope.Tenant, comparisonID)
	switch {
	case err != nil:
		return store.DecideInput{}, err
	case c.Status == domain.ComparisonDecided:
		return store.DecideInput{}, domain.ErrComparisonDecided
	case c.Status != domain.ComparisonReady || c.Matrix == nil:
		return store.DecideInput{}, domain.ErrComparisonNotReady
	case !slices.Contains(c.LineIDs, in.LineID):
		return store.DecideInput{}, domain.InvalidComparison("the chosen branch is not one of the compared ones")
	}
	out := store.DecideInput{
		Tenant: scope.Tenant, ComparisonID: c.ID, LineID: in.LineID, Actor: scope.Actor,
		Decision: domain.DecisionLeaf(*c.Matrix, in.LineID, in.Line, e.limits), DeadEnds: map[string]domain.LeafInput{},
	}
	for _, id := range c.LineIDs {
		if id != in.LineID {
			out.DeadEnds[id] = domain.DeadEndLeaf(*c.Matrix, id, in.LineID, e.leafTexts, e.limits)
		}
	}
	return out, nil
}

// publishDecided: each discarded branch's branch.changed{discarded}, the
// parent's line.updated, the dead-end leaves then the decision's
// leaf.changed, comparison.changed and the expired suggestions.
func (e *Engine) publishDecided(ctx context.Context, scope Scope, out store.DecidedComparison, expired []domain.Suggestion) {
	events := []Event{}
	for _, view := range out.Discarded {
		events = append(events, branchEvent(scope.Tenant, BranchDiscarded, view))
	}
	if len(out.Discarded) > 0 {
		events = append(events, e.lineEvents(ctx, scope, out.ParentLineID)...)
	}
	for _, leaf := range out.DeadEnds {
		events = append(events, leafEvent(scope, leaf.LineID, out.RootLineID, &leaf))
	}
	events = append(events, leafEvent(scope, out.Decision.LineID, out.RootLineID, &out.Decision), comparisonEvent(scope.Tenant, out.Comparison))
	e.publish(ctx, append(events, e.suggestionEvents(ctx, scope, expired...)...)...)
}
