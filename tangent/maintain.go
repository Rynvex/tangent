package tangent

import (
	"context"
	"errors"
	"fmt"
)

// MaintenanceReport counts what one Maintain call did.
// Tasks counts what each feature task did, by task name (for example
// TaskPurgeAsides).
type MaintenanceReport struct {
	StaleTurns     int            `json:"staleTurns"`
	StaleJobs      int            `json:"staleJobs"`
	DroppedBuffers int            `json:"droppedBuffers"`
	Tasks          map[string]int `json:"tasks"`
}

// Maintain runs the periodic sweeps once: turns pending longer than the
// stale-turn age (WithStaleTurnAge) fail, jobs past their kind's timeout
// fail, the features' tasks run (aside: purge expired asides) and expired
// delta buffers go. The reference server calls it from a loop. Every sweep
// runs even when an earlier one fails; the errors are joined.
func (e *Engine) Maintain(ctx context.Context) (MaintenanceReport, error) {
	report := MaintenanceReport{Tasks: map[string]int{}}
	var errs []error
	turns, err := e.FailStaleTurns(ctx, e.now().Add(-e.staleTurn))
	report.StaleTurns = len(turns)
	errs = append(errs, err)
	jobs, err := e.FailStaleJobs(ctx)
	report.StaleJobs = len(jobs)
	errs = append(errs, err)
	for _, h := range e.features.maintainers {
		n, err := h.fn.fn(ctx, e)
		report.Tasks[h.fn.task] += n
		if err != nil {
			errs = append(errs, fmt.Errorf("feature %s: %w", h.feature, err))
		}
	}
	report.DroppedBuffers = e.deltas.sweep()
	e.streams.sweep(e.now().Add(-e.staleTurn))
	e.streams.sweepTombstones(e.now().Add(-tombstoneTTL))
	return report, errors.Join(errs...)
}
