package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Aside is the one-question branch (kind aside): answered once, then ended,
// and purged with its messages after Limits.Branch.AsideRetention. Off:
// opening an aside (or moving into one) returns feature_disabled and
// Maintain purges nothing; existing asides are kept.
func Aside() Feature { return onOff(FeatureAside, registerAside) }

func registerAside(r *registry, _ *module) {
	r.addMaintainer(TaskPurgeAsides, func(ctx context.Context, e *Engine) (int, error) {
		purged, err := e.purgeExpiredAsides(ctx)
		return len(purged), err
	})
}

// TaskPurgeAsides is the aside feature's maintenance task (in
// MaintenanceReport.Tasks).
const TaskPurgeAsides = "aside.purge"

// PurgedAside is one expired aside deleted with everything below it.
type PurgedAside = store.PurgedAside

// PurgeExpiredAsides deletes the asides that ended more than
// AsideRetention ago, at most 100 per call (Maintain calls it). It is a
// sweep over every tenant, so it follows the configuration, not the
// FeaturePolicy.
func (e *Engine) PurgeExpiredAsides(ctx context.Context) ([]PurgedAside, error) {
	if _, ok := e.features.modes[FeatureAside]; !ok {
		return nil, domain.FeatureDisabled(FeatureAside)
	}
	return e.purgeExpiredAsides(ctx)
}

func (e *Engine) purgeExpiredAsides(ctx context.Context) ([]PurgedAside, error) {
	purged, err := e.store.PurgeExpiredAsides(ctx, 0)
	for _, aside := range purged {
		e.forgetLines(aside.Tenant, aside.LineIDs, aside.PendingJobIDs)
		e.publish(ctx, Event{
			Type: EventLineDeleted, Tenant: aside.Tenant, RootLineID: aside.RootLineID, LineID: aside.LineID,
			Data: LinesDeleted{RootLineID: aside.RootLineID, LineIDs: aside.LineIDs},
		})
		e.publish(ctx, e.suggestionEvents(ctx, Scope{Tenant: aside.Tenant}, aside.ExpiredSuggestions...)...)
	}
	return purged, err
}

// forgetLines stops the runs of jobs that went with deleted lines and drops
// everything this process remembers about the lines.
func (e *Engine) forgetLines(tenant string, lineIDs, jobIDs []string) {
	e.inflight.cancel(jobIDs...)
	e.turns.dropLines(lineIDs)
	e.deltas.forget(tenant, lineIDs)
}
