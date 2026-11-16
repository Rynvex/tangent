package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Job statuses: pending → done | failed | superseded, one way.
const (
	JobPending    = "pending"
	JobDone       = "done"
	JobFailed     = "failed"
	JobSuperseded = "superseded"
)

// Job kinds of the core features.
const (
	JobKindCardDraft = "card_draft"
	JobKindSummary   = "summary"
)

// FeatureCore is the feature of the core's own jobs.
const FeatureCore = "core"

// Job is one background job as stored.
type Job struct {
	ID       string
	TenantID string
	Kind     string
	Feature  string
	// LineID is "" for a job that is not about one line.
	LineID     string
	Status     string
	Input      json.RawMessage
	Error      string
	CreatedAt  time.Time
	FinishedAt *time.Time
}

func jobFromRow(row db.TangentJob) Job {
	return Job{
		ID: row.ID.String(), TenantID: row.TenantID, Kind: row.Kind, Feature: row.Feature, LineID: idString(row.LineID),
		Status: row.Status, Input: hostMeta(row.Input), Error: row.Error, CreatedAt: row.CreatedAt.UTC(), FinishedAt: timePtr(row.FinishedAt),
	}
}

// CreateJobInput is a new pending job. Input holds the cursors the job
// started from (a JSON object). Supersede marks the pending jobs of the same
// kind on the same line superseded first.
type CreateJobInput struct {
	Tenant    string
	Kind      string
	Feature   string
	LineID    string
	Input     json.RawMessage
	Supersede bool
}

// CreateJob records a pending job. A job on a line is created under the
// line's row lock, so superseding and inserting cannot interleave with
// another CreateJob or a draft claim on that line.
func (s *Store) CreateJob(ctx context.Context, in CreateJobInput, hooks ...TxHook) (Job, error) {
	return runTx(ctx, s, hooks, func(q *db.Queries) (Job, error) {
		row, err := s.createJob(ctx, q, in)
		if err != nil {
			return Job{}, err
		}
		return jobFromRow(row), nil
	})
}

func (s *Store) createJob(ctx context.Context, q *db.Queries, in CreateJobInput) (db.TangentJob, error) {
	kind, feature := strings.TrimSpace(in.Kind), strings.TrimSpace(in.Feature)
	if kind == "" || strings.TrimSpace(in.Tenant) == "" {
		return db.TangentJob{}, invalidInput("a job needs a tenant and a kind")
	}
	if feature == "" {
		feature = FeatureCore
	}
	input, err := jsonObject(in.Input, "input")
	if err != nil {
		return db.TangentJob{}, err
	}
	line := uuid.NullUUID{}
	if strings.TrimSpace(in.LineID) != "" {
		row, err := s.lockLine(ctx, q, in.Tenant, in.LineID)
		if err != nil {
			return db.TangentJob{}, err
		}
		line = uuid.NullUUID{UUID: row.ID, Valid: true}
	}
	if in.Supersede && line.Valid {
		if _, err := q.SupersedePendingJobs(ctx, db.SupersedePendingJobsParams{LineIds: []uuid.UUID{line.UUID}, Kind: kind}); err != nil {
			return db.TangentJob{}, fmt.Errorf("supersede pending jobs: %w", err)
		}
	}
	row, err := q.InsertJob(ctx, db.InsertJobParams{ID: uuid.New(), TenantID: in.Tenant, Kind: kind, Feature: feature, LineID: line, Input: input})
	if err != nil {
		return db.TangentJob{}, fmt.Errorf("insert job: %w", err)
	}
	return row, nil
}

// GetJob loads a job by id (the runner that reports a result knows only the
// id; the job carries its tenant).
func (s *Store) GetJob(ctx context.Context, jobID string) (Job, error) {
	id, ok := parseID(jobID)
	if !ok {
		return Job{}, domain.ErrJobNotFound
	}
	row, err := s.q.GetJob(ctx, id)
	if err != nil {
		return Job{}, lookup(err, domain.ErrJobNotFound, "get job")
	}
	return jobFromRow(row), nil
}

// PendingJob returns the newest pending job of a kind on a line; ok is false
// when there is none.
func (s *Store) PendingJob(ctx context.Context, tenant, lineID, kind string) (Job, bool, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return Job{}, false, err
	}
	row, err := s.q.LatestPendingJob(ctx, db.LatestPendingJobParams{LineID: uuid.NullUUID{UUID: line.ID, Valid: true}, Kind: kind})
	if noRows(err) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, fmt.Errorf("pending job: %w", err)
	}
	return jobFromRow(row), true, nil
}

// FinishJob ends a pending job as done or failed. A job that is no longer
// pending (finished, superseded, timed out) returns ErrJobNotPending; a
// card draft is refused (FinishBranchDraft owns it).
func (s *Store) FinishJob(ctx context.Context, jobID, status, errText string, hooks ...TxHook) (Job, error) {
	if status != JobDone && status != JobFailed {
		return Job{}, invalidInput("a job finishes as done or failed")
	}
	return runTx(ctx, s, hooks, func(q *db.Queries) (Job, error) {
		job, err := lockJob(ctx, q, jobID)
		if err != nil {
			return Job{}, err
		}
		if job.Kind == JobKindCardDraft {
			return Job{}, invalidInput("a card draft is finished with FinishBranchDraft")
		}
		row, err := finishJob(ctx, q, job.ID, status, errText)
		if err != nil {
			return Job{}, err
		}
		return jobFromRow(row), nil
	})
}

func lockJob(ctx context.Context, q *db.Queries, jobID string) (db.TangentJob, error) {
	id, ok := parseID(jobID)
	if !ok {
		return db.TangentJob{}, domain.ErrJobNotFound
	}
	row, err := q.GetJobForUpdate(ctx, id)
	if err != nil {
		return db.TangentJob{}, lookup(err, domain.ErrJobNotFound, "lock job")
	}
	return row, nil
}

func finishJob(ctx context.Context, q *db.Queries, id uuid.UUID, status, errText string) (db.TangentJob, error) {
	row, err := q.FinishJob(ctx, db.FinishJobParams{ID: id, Status: status, Error: errText})
	if err != nil {
		return db.TangentJob{}, lookup(err, domain.ErrJobNotPending, "finish job")
	}
	return row, nil
}

// LatestJob returns the newest job of a kind on a line of the tenant,
// whatever its status; ok is false when there is none.
func (s *Store) LatestJob(ctx context.Context, tenant, lineID, kind string) (Job, bool, error) {
	line, err := s.lineRow(ctx, s.q, tenant, lineID)
	if err != nil {
		return Job{}, false, err
	}
	row, err := s.q.LatestJobOfKind(ctx, db.LatestJobOfKindParams{LineID: uuid.NullUUID{UUID: line.ID, Valid: true}, Kind: kind})
	if noRows(err) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, fmt.Errorf("latest job: %w", err)
	}
	return jobFromRow(row), true, nil
}
