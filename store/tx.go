package store

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store/db"
)

// Tx is what a hook may run inside a write's transaction.
type Tx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// TxHook runs inside a write's transaction, after the store's own writes and
// before the commit; DeleteTree runs it before deleting, so the rows are
// still readable. result is the value the write is about to return (for
// example a BegunTurn or a MergedBranch), so a hook sees the ids the write
// generated. An error rolls the whole write back and comes back wrapped as
// "tx hook: …". A write that is retried (see runTx) runs its hooks again.
type TxHook func(ctx context.Context, tx Tx, result any) error

const (
	// maxTxAttempts bounds how often a write that lost a race (a deadlock, a
	// serialization failure, a branch re-hung while it was being locked) is
	// run again.
	maxTxAttempts = 5
	// retryBaseDelay is the first backoff; it doubles per attempt, plus jitter.
	retryBaseDelay = 5 * time.Millisecond
)

// Postgres SQLSTATEs a write is retried on.
const (
	sqlStateDeadlock      = "40P01"
	sqlStateSerialization = "40001"
)

// runTx runs fn and then the hooks in one transaction and returns fn's
// result. Every attempt starts from a fresh result; a retryable failure
// rolls back and runs the whole transaction again, with backoff, until
// maxTxAttempts or until ctx ends.
func runTx[T any](ctx context.Context, s *Store, hooks []TxHook, fn func(q *db.Queries) (T, error)) (T, error) {
	return runTxWith(ctx, s, func(q *db.Queries, tx pgx.Tx) (T, error) {
		out, err := fn(q)
		if err != nil {
			return out, err
		}
		return out, runHooks(ctx, tx, hooks, out)
	})
}

// runTxWith is runTx for a write that runs its hooks itself.
func runTxWith[T any](ctx context.Context, s *Store, fn func(q *db.Queries, tx pgx.Tx) (T, error)) (T, error) {
	var zero T
	var err error
	for attempt := range maxTxAttempts {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return zero, ctxErr
		}
		var out T
		err = attemptTx(ctx, s, func(tx pgx.Tx) error {
			var fnErr error
			out, fnErr = fn(s.q.WithTx(tx), tx)
			return fnErr
		})
		if err == nil {
			return out, nil
		}
		if !retryable(err) {
			return zero, err
		}
		if attempt+1 < maxTxAttempts {
			if waitErr := backoff(ctx, attempt); waitErr != nil {
				return zero, waitErr
			}
		}
	}
	return zero, fmt.Errorf("%w (%v)", domain.ErrConcurrentChange, err)
}

// commitTimeout bounds a commit or rollback, which runs on a context the
// caller's cancellation does not reach.
const commitTimeout = 15 * time.Second

// attemptTx runs fn in one transaction. A caller cancelled before the
// commit gets its error and the write rolls back. The COMMIT itself runs on
// a detached context: cancelling it half-way made pgx report a failure for
// a write the server may already have committed (the soak found a turn left
// pending that way, with nobody to run it), so once sent it completes.
func attemptTx(ctx context.Context, s *Store, fn func(tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	detachedCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), commitTimeout)
	defer cancel()
	// A no-op after the commit; on an error or a panic it ends the transaction.
	defer func() { _ = tx.Rollback(detachedCtx) }()
	if err := fn(tx); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return tx.Commit(detachedCtx)
}

// retryable reports whether a failed transaction may simply be run again.
func retryable(err error) bool {
	if errors.Is(err, errBranchMoved) {
		return true
	}
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == sqlStateDeadlock || pgErr.Code == sqlStateSerialization)
}

func backoff(ctx context.Context, attempt int) error {
	delay := retryBaseDelay<<attempt + time.Duration(rand.Int64N(int64(retryBaseDelay)))
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func runHooks(ctx context.Context, tx Tx, hooks []TxHook, result any) error {
	for _, hook := range hooks {
		if hook == nil {
			continue
		}
		if err := hook(ctx, tx, result); err != nil {
			return fmt.Errorf("tx hook: %w", err)
		}
	}
	return nil
}
