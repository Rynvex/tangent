package embedding

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// ErrQueueFull and ErrQueueClosed refuse work; httpapi answers either with
// 503 unavailable and fails the turn or job it could not hand over.
var (
	ErrQueueFull   = errors.New("the work queue is full")
	ErrQueueClosed = errors.New("the work queue is closed")
)

// snippet:queue
// QueueDispatcher is a host-owned work queue: DispatchTurn and DispatchJob
// only enqueue (they run inside the HTTP request, so they must not block),
// and a fixed set of workers runs the protocol's runner side.
type QueueDispatcher struct {
	engine *tangent.Engine
	model  tangent.Runner
	log    *slog.Logger

	mu     sync.Mutex
	closed bool
	work   chan func(context.Context)
	stop   context.CancelFunc
	ctx    context.Context
	wg     sync.WaitGroup
}

func NewQueueDispatcher(engine *tangent.Engine, model tangent.Runner, workers, depth int, log *slog.Logger) *QueueDispatcher {
	ctx, stop := context.WithCancel(context.Background())
	q := &QueueDispatcher{engine: engine, model: model, log: log, work: make(chan func(context.Context), depth), ctx: ctx, stop: stop}
	for range workers {
		q.wg.Add(1)
		go func() {
			defer q.wg.Done()
			for run := range q.work {
				run(q.ctx)
			}
		}()
	}
	return q
}

func (q *QueueDispatcher) DispatchTurn(_ context.Context, t tangent.Turn) error {
	return q.enqueue(func(ctx context.Context) { q.runTurn(ctx, t) })
}

func (q *QueueDispatcher) DispatchJob(_ context.Context, j tangent.Job) error {
	return q.enqueue(func(ctx context.Context) { q.runJob(ctx, j) })
}

func (q *QueueDispatcher) enqueue(run func(context.Context)) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrQueueClosed
	}
	select {
	case q.work <- run:
		return nil
	default:
		return ErrQueueFull
	}
}

func (q *QueueDispatcher) runTurn(ctx context.Context, t tangent.Turn) {
	done, err := RunManually(ctx, q.engine, q.model, t) // AppendDelta + CompleteTurn
	switch {
	case errors.Is(err, domain.ErrTurnNotPending):
		return // cancelled (or failed as stale) meanwhile: nothing to write
	case err != nil:
		q.log.Error("turn not completed", "turn", t.ID, "error", err)
		return
	}
	// A completed turn may start jobs (an automatic summary); they are ours to run.
	for _, job := range done.Jobs {
		if err := q.DispatchJob(ctx, job); err != nil {
			_ = q.engine.FinishJob(context.WithoutCancel(ctx), job.ID, "", err)
		}
	}
}

func (q *QueueDispatcher) runJob(ctx context.Context, j tangent.Job) {
	// A job is one call without tools or streaming.
	result, runErr := q.model.Run(ctx, j.Request())
	// FinishJob hands the raw output to the feature that owns the job kind; a job
	// that was superseded or timed out meanwhile writes nothing (job_not_pending).
	if err := q.engine.FinishJob(context.WithoutCancel(ctx), j.ID, result.Content, runErr); err != nil && domain.CodeOf(err) == "" {
		q.log.Error("job result not recorded", "job", j.ID, "error", err)
	}
}

// Close stops taking work, cancels the runs and waits until every queued
// turn and job has written its outcome back (as a failure).
func (q *QueueDispatcher) Close() {
	q.mu.Lock()
	if !q.closed {
		q.closed = true
		close(q.work)
	}
	q.mu.Unlock()
	q.stop()
	q.wg.Wait()
}

// endsnippet
