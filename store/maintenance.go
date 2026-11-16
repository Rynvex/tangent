package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Maintenance sweeps. They take no TxHook (DESIGN §12): each item is its own
// transaction. Partial results: a sweep returns everything it finished
// before an error, together with that error; items that vanished or changed
// meanwhile are skipped, never reported as errors.

const (
	// StaleTurnDetail is the status detail of a turn FailStaleTurns ended.
	StaleTurnDetail = "the turn timed out"
	// StaleJobError is the error of a job FailStaleJobs ended.
	StaleJobError = domain.JobTimedOutText
	// sweepBatch bounds one sweep of each kind.
	sweepBatch = 200
	// asidePurgeBatch bounds one PurgeExpiredAsides call.
	asidePurgeBatch = 100
	// DefaultSummaryJobTimeout is how long a summary job may stay pending.
	DefaultSummaryJobTimeout = 5 * time.Minute
)

// StaleTurn is one pending turn FailStaleTurns ended.
type StaleTurn struct {
	Tenant  string
	Line    domain.LineView
	Message domain.Message
}

// FailStaleTurns fails every pending turn created more than maxAge before
// the store's clock (at most 200 per call) with StaleTurnDetail and parks
// its line in error. A turn that finished, or whose line went away,
// meanwhile is skipped. On any other error it stops and returns the turns it
// already failed (those are committed) with the error.
func (s *Store) FailStaleTurns(ctx context.Context, maxAge time.Duration) ([]StaleTurn, error) {
	if maxAge <= 0 {
		return nil, invalidInput("maxAge must be positive")
	}
	rows, err := s.q.ListStalePendingMessages(ctx, db.ListStalePendingMessagesParams{Cutoff: s.now().Add(-maxAge), RowLimit: sweepBatch})
	if err != nil {
		return nil, fmt.Errorf("list stale turns: %w", err)
	}
	out := make([]StaleTurn, 0, len(rows))
	outcome := domain.ResolveTurnOutcome("", StaleTurnDetail)
	for _, row := range rows {
		done, err := s.CompleteTurn(ctx, CompleteTurnInput{TurnID: row.ID.String(), Outcome: outcome})
		if errors.Is(err, domain.ErrTurnNotPending) || errors.Is(err, domain.ErrLineNotFound) {
			continue
		}
		if err != nil {
			return out, err
		}
		out = append(out, StaleTurn{Tenant: done.Tenant, Line: done.Line, Message: done.Message})
	}
	return out, nil
}

// DefaultJobTimeouts are the pending timeouts of the core job kinds: a card
// draft gets Limits.Branch.DraftTimeout, a summary DefaultSummaryJobTimeout.
func (s *Store) DefaultJobTimeouts() map[string]time.Duration {
	return map[string]time.Duration{JobKindCardDraft: s.limits.Branch.DraftTimeout, JobKindSummary: DefaultSummaryJobTimeout}
}

// FailStaleJobs marks failed (StaleJobError) every pending job that has been
// pending longer than the timeout of its kind; kinds missing from timeouts
// are left alone, and nil means DefaultJobTimeouts. At most 200 jobs per
// kind per call; rows another transaction holds wait for the next sweep. On
// an error it returns the jobs already failed (committed) with the error.
func (s *Store) FailStaleJobs(ctx context.Context, timeouts map[string]time.Duration) ([]Job, error) {
	if timeouts == nil {
		timeouts = s.DefaultJobTimeouts()
	}
	out := []Job{}
	for kind, timeout := range timeouts {
		if timeout <= 0 {
			return out, invalidInput("the timeout of job kind " + kind + " must be positive")
		}
		rows, err := s.q.FailStaleJobs(ctx, db.FailStaleJobsParams{Kind: kind, Cutoff: s.now().Add(-timeout), Error: StaleJobError, RowLimit: sweepBatch})
		if err != nil {
			return out, fmt.Errorf("fail stale %s jobs: %w", kind, err)
		}
		for _, row := range rows {
			out = append(out, jobFromRow(row))
		}
	}
	return out, nil
}

// PurgedAside is one expired aside deleted with everything below it.
type PurgedAside struct {
	Tenant     string
	LineID     string
	RootLineID string
	// LineIDs are the aside and every line below it.
	LineIDs  []string
	Messages []MessageHostMeta
	// PendingJobIDs are the pending jobs deleted with the lines.
	PendingJobIDs []string
	// ExpiredSuggestions are the tree's open suggestions that named one of
	// the deleted lines.
	ExpiredSuggestions []domain.Suggestion
}

// PurgeExpiredAsides deletes asides that ended more than retention before
// the store's clock (retention 0 means Limits.Branch.AsideRetention), with
// their messages, at most 100 per call. A kept aside (B23) is never purged. An aside whose tree is answering,
// or that changed or went away meanwhile, is skipped. On an error it stops
// and returns the asides already deleted (committed) with the error.
func (s *Store) PurgeExpiredAsides(ctx context.Context, retention time.Duration) ([]PurgedAside, error) {
	if retention < 0 {
		return nil, invalidInput("retention must not be negative")
	}
	if retention == 0 {
		retention = s.limits.Branch.AsideRetention
	}
	expired, err := s.q.ListExpiredAsides(ctx, db.ListExpiredAsidesParams{
		Cutoff: pgtype.Timestamptz{Time: s.now().Add(-retention), Valid: true}, RowLimit: asidePurgeBatch,
	})
	if err != nil {
		return nil, fmt.Errorf("list expired asides: %w", err)
	}
	out := []PurgedAside{}
	for _, item := range expired {
		purged, err := s.purgeAside(ctx, item.LineID, item.RootLineID)
		if err != nil {
			return out, err
		}
		if purged != nil {
			out = append(out, *purged)
		}
	}
	return out, nil
}

// purgeAside deletes one ended aside under the locks root → aside → lines
// below; nil when it is answering or no longer an ended aside.
func (s *Store) purgeAside(ctx context.Context, asideID, rootID uuid.UUID) (*PurgedAside, error) {
	return runTx(ctx, s, nil, func(q *db.Queries) (*PurgedAside, error) {
		if _, err := lockLineByID(ctx, q, rootID); err != nil {
			return nil, skipMissing(err)
		}
		aside, err := lockLineByID(ctx, q, asideID)
		if err != nil {
			return nil, skipMissing(err)
		}
		row, isBranch, err := branchRowFor(ctx, q, aside.ID)
		// Re-read under the lock: it may have been kept (B23) since the sweep
		// listed it.
		if err != nil || !isBranch || row.Kind != domain.BranchKindAside || row.Status == domain.BranchStatusOpen || row.KeptAt.Valid {
			return nil, err
		}
		below, err := s.subtreeIDs(ctx, q, aside.ID)
		if err != nil {
			return nil, err
		}
		ids, err := lockLines(ctx, q, aside.ID, below)
		if errors.Is(err, domain.ErrDeleteBusy) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		tree, err := readDeletedTree(ctx, q, aside.ID, ids)
		if err != nil {
			return nil, err
		}
		expired, err := expireNamingLines(ctx, q, rootID, ids)
		if err != nil {
			return nil, err
		}
		if err := q.DeleteLines(ctx, db.DeleteLinesParams{TenantID: aside.TenantID, LineIds: ids}); err != nil {
			return nil, fmt.Errorf("delete aside: %w", err)
		}
		return &PurgedAside{
			Tenant: aside.TenantID, LineID: aside.ID.String(), RootLineID: rootID.String(), LineIDs: tree.LineIDs, Messages: tree.Messages,
			PendingJobIDs: tree.PendingJobIDs, ExpiredSuggestions: expired,
		}, nil
	})
}

// skipMissing treats a line that is already gone as nothing to do.
func skipMissing(err error) error {
	if errors.Is(err, domain.ErrLineNotFound) {
		return nil
	}
	return err
}
