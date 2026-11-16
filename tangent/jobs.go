package tangent

import (
	"context"
	"errors"
	"fmt"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// Job kinds of the first-batch features.
const (
	JobKindCardDraft = store.JobKindCardDraft
	JobKindSummary   = store.JobKindSummary
)

// Job is one single-shot model call the host runs (a card draft, a rolling
// summary, a feature's job) and reports with FinishJob. Its prompt carries
// no tools. Provider and Model are a hint; empty means the runner's default.
type Job struct {
	ID       string
	Kind     string
	Feature  string
	Scope    Scope
	LineID   string
	Prompt   domain.Prompt
	Provider string
	Model    string
}

// JobRecord is a job as stored.
type JobRecord = store.Job

// jobPrompt wraps a single-text job prompt: the whole text is the one user
// message (Chat: no system, one user message; Text: the operator section).
func jobPrompt(text string) domain.Prompt {
	return domain.Prompt{Sections: []domain.PromptSection{}, History: []domain.ChatMessage{}, UserMessage: text}
}

// noHandlerText is the error of a job no enabled feature handles.
const noHandlerText = "no enabled feature handles this job"

// FinishJob reports a job's result: raw is the model's output, runErr the
// failure of the run (logged, never stored). The result goes to the
// JobHandler of the job's kind. A job that is no longer pending (finished,
// superseded, timed out) writes nothing and returns job_not_pending /
// draft_not_pending. A job of a kind no enabled feature handles is failed
// and feature_disabled returned.
//
// Runner side only: the bare job id carries no tenant check, so this must
// never be reachable by clients (httpapi does not route it).
func (e *Engine) FinishJob(ctx context.Context, jobID, raw string, runErr error) error {
	job, err := e.store.GetJob(ctx, jobID)
	if err != nil {
		return err
	}
	if job.Status != store.JobPending {
		return domain.ErrJobNotPending
	}
	if runErr != nil {
		e.log.Warn("tangent: job run failed", "job", job.ID, "kind", job.Kind, "error", runErr)
	}
	handler, ok := e.features.jobHandlers[job.Kind]
	if !ok {
		if err := e.failJob(ctx, job, noHandlerText); err != nil {
			return err
		}
		name := job.Feature
		if name == store.FeatureCore {
			name = job.Kind
		}
		return domain.FeatureDisabled(name)
	}
	err = handler.finish(ctx, e, job, raw, runErr)
	if err != nil && e.jobGone(ctx, jobID) {
		// The job went with its conversation (deleted while the handler
		// ran): there is nothing left to record.
		return domain.ErrJobNotFound
	}
	return err
}

// jobGone reports whether the job's row no longer exists.
func (e *Engine) jobGone(ctx context.Context, jobID string) bool {
	_, err := e.store.GetJob(ctx, jobID)
	return errors.Is(err, domain.ErrJobNotFound)
}

// failJob ends a job as failed with a fixed reason (the store knows how to
// end each of its own kinds).
func (e *Engine) failJob(ctx context.Context, job JobRecord, reason string) error {
	return e.store.FailJob(ctx, job.ID, reason)
}

// FailStaleJobs fails every job pending longer than its kind's timeout (the
// store's defaults, overridden by the features' JobHandlers) and tells the
// kind's handler (card_draft republishes the branch). On an error it returns
// the jobs already failed with the error.
func (e *Engine) FailStaleJobs(ctx context.Context) ([]JobRecord, error) {
	timeouts := e.store.DefaultJobTimeouts()
	for kind, handler := range e.features.jobHandlers {
		if handler.timeout > 0 {
			timeouts[kind] = handler.timeout
		}
	}
	failed, err := e.store.FailStaleJobs(ctx, timeouts)
	for _, job := range failed {
		e.inflight.cancel(job.ID)
		if handler, ok := e.features.jobHandlers[job.Kind]; ok && handler.onStale != nil {
			handler.onStale(ctx, e, job)
		}
	}
	return failed, err
}

// startJob records a pending job of a feature for a line.
func (e *Engine) startJob(ctx context.Context, scope Scope, in store.CreateJobInput, opts []TxOption) (JobRecord, error) {
	in.Tenant = scope.Tenant
	record, err := e.store.CreateJob(ctx, in, hooksOf(opts)...)
	if err != nil {
		return JobRecord{}, fmt.Errorf("start %s job: %w", in.Kind, err)
	}
	return record, nil
}

// conversationMessage is a finished operator or assistant message.
func conversationMessage(message domain.Message) bool {
	return message.Status == domain.MessageDone && (message.Role == domain.RoleUser || message.Role == domain.RoleAssistant)
}
