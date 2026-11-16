package tangent

import (
	"context"

	"github.com/Rynvex/tangent/domain"
)

// JobFailed is the data of job.failed: a feature's background job that
// failed (its run failed, its output was unusable, or it timed out) and has
// no other channel to say so. Error.Code is run_failed, unusable,
// timed_out or failed.
type JobFailed struct {
	JobID      string          `json:"jobId"`
	Kind       string          `json:"kind"`
	LineID     string          `json:"lineId"`
	RootLineID string          `json:"rootLineId"`
	Error      domain.JobError `json:"error"`
}

// publishJobFailed publishes job.failed for a job that ended failed with
// the fixed text.
func (e *Engine) publishJobFailed(ctx context.Context, job JobRecord, text string) {
	root := job.LineID
	if line, err := e.store.GetLine(ctx, job.TenantID, job.LineID); err == nil && line.ConversationBranch != nil {
		root = line.ConversationBranch.RootLineID
	}
	e.publish(ctx, Event{
		Type: EventJobFailed, Tenant: job.TenantID, RootLineID: root, LineID: job.LineID,
		Data: JobFailed{JobID: job.ID, Kind: job.Kind, LineID: job.LineID, RootLineID: root, Error: domain.JobErrorFor(text)},
	})
}

// staleJobFailed is the onStale of the jobs that report failures with
// job.failed.
func staleJobFailed(ctx context.Context, e *Engine, job JobRecord) {
	e.publishJobFailed(ctx, job, job.Error)
}
