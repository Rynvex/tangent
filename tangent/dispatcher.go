package tangent

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Dispatcher runs started turns and jobs. httpapi and the reference server
// hand work to it; a host can plug in its own queue (a host may write a
// swarm_command, in the same transaction via InTx).
type Dispatcher interface {
	DispatchTurn(ctx context.Context, t Turn) error
	DispatchJob(ctx context.Context, j Job) error
}

// Default timeouts of the runner dispatcher.
const (
	DefaultTurnTimeout = 10 * time.Minute
	DefaultJobTimeout  = 3 * time.Minute
)

// DispatcherOption configures NewRunnerDispatcher.
type DispatcherOption func(*RunnerDispatcher)

// WithTurnTimeout bounds one turn run.
func WithTurnTimeout(d time.Duration) DispatcherOption {
	return func(r *RunnerDispatcher) {
		if d > 0 {
			r.turnTimeout = d
		}
	}
}

// WithJobTimeout bounds one job run.
func WithJobTimeout(d time.Duration) DispatcherOption {
	return func(r *RunnerDispatcher) {
		if d > 0 {
			r.jobTimeout = d
		}
	}
}

// WithMaxConcurrent bounds how many runs execute at once; the others wait
// for a slot (0 = no bound).
func WithMaxConcurrent(n int) DispatcherOption {
	return func(r *RunnerDispatcher) {
		if n > 0 {
			r.slots = make(chan struct{}, n)
		}
	}
}

// Default bounds of the runner dispatcher's queue.
const (
	DefaultMaxQueue       = 64
	DefaultMaxTenantTurns = 16
)

// WithMaxQueue bounds the work a dispatcher holds at once, running or
// waiting for a slot (default 64); more is refused with ErrDispatcherBusy.
func WithMaxQueue(n int) DispatcherOption {
	return func(r *RunnerDispatcher) {
		if n > 0 {
			r.maxQueue = n
		}
	}
}

// WithMaxTenantTurns bounds the turns one tenant has in the dispatcher at
// once (default 16); more are refused with ErrDispatcherBusy.
func WithMaxTenantTurns(n int) DispatcherOption {
	return func(r *RunnerDispatcher) {
		if n > 0 {
			r.maxTenant = n
		}
	}
}

// DefaultMaxOnce bounds the synchronous runs (RunOnce) a dispatcher holds at
// once, so they never fill the queue turns and jobs need.
const DefaultMaxOnce = 4

// WithMaxOnce bounds the RunOnce calls held at once, running or waiting for
// a slot (default 4); more are refused with ErrDispatcherBusy.
func WithMaxOnce(n int) DispatcherOption {
	return func(r *RunnerDispatcher) {
		if n > 0 {
			r.maxOnce = n
		}
	}
}

// ErrDispatcherBusy refuses work beyond WithMaxQueue, WithMaxTenantTurns or WithMaxOnce.
var ErrDispatcherBusy = errors.New("tangent: the dispatcher is busy")

// ErrDispatcherClosed refuses work after Shutdown or Close.
var ErrDispatcherClosed = errors.New("tangent: the dispatcher is shut down")

// RunnerDispatcher runs each turn and job on its own goroutine with a
// Runner, under a timeout and an optional concurrency bound, and always
// writes the outcome back: a runner error, panic or timeout fails the turn
// or job. A run outlives the context it was dispatched with; only Shutdown
// or Close stops it. Jobs a completed turn started (CompletedTurn.Jobs) are
// dispatched too.
type RunnerDispatcher struct {
	engine      *Engine
	runner      Runner
	turnTimeout time.Duration
	jobTimeout  time.Duration
	slots       chan struct{}

	maxQueue  int
	maxTenant int
	// maxOnce bounds RunOnce; once is how many it holds.
	maxOnce int
	once    int

	mu      sync.Mutex
	closed  bool
	held    int
	tenants map[string]int
	wg      sync.WaitGroup
	base    context.Context
	stop    context.CancelFunc
}

// NewRunnerDispatcher runs work in this process with r.
func NewRunnerDispatcher(e *Engine, r Runner, opts ...DispatcherOption) *RunnerDispatcher {
	base, stop := context.WithCancel(context.Background())
	d := &RunnerDispatcher{
		engine: e, runner: r, turnTimeout: DefaultTurnTimeout, jobTimeout: DefaultJobTimeout, base: base, stop: stop,
		maxQueue: DefaultMaxQueue, maxTenant: DefaultMaxTenantTurns, maxOnce: DefaultMaxOnce, tenants: map[string]int{},
	}
	for _, opt := range opts {
		if opt != nil {
			opt(d)
		}
	}
	return d
}

// errNoRunner refuses work when the dispatcher has nothing to run it with.
var errNoRunner = errors.New("tangent: the dispatcher has no runner")

// start registers one run unless the dispatcher is closed or full; the
// WaitGroup is only added to under the same lock Shutdown takes, so Add
// never races Wait. tenant is set for a turn (its tenant's count).
func (d *RunnerDispatcher) start(tenant string, run func()) error {
	if d.engine == nil || d.runner == nil {
		return errNoRunner
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case d.closed:
		return ErrDispatcherClosed
	case d.held >= d.maxQueue, tenant != "" && d.tenants[tenant] >= d.maxTenant:
		return ErrDispatcherBusy
	}
	d.held++
	if tenant != "" {
		d.tenants[tenant]++
	}
	d.wg.Go(func() {
		defer d.done(tenant)
		run()
	})
	return nil
}

// done releases what start counted.
func (d *RunnerDispatcher) done(tenant string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.held--
	if tenant == "" {
		return
	}
	if d.tenants[tenant]--; d.tenants[tenant] <= 0 {
		delete(d.tenants, tenant)
	}
}

// waitContext is the context of one dispatched piece of work: the
// dispatching context's values, cancelled only by Shutdown / Close, never
// by the dispatching request. The run's timeout is added once a slot is
// acquired, so time spent waiting for a slot (WithMaxConcurrent) does not
// count against it.
func (d *RunnerDispatcher) waitContext(ctx context.Context) (context.Context, context.CancelFunc) {
	waitCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	stop := context.AfterFunc(d.base, cancel)
	return waitCtx, func() {
		stop()
		cancel()
	}
}

// stoppedText is the failure stored for work that ended on its context: a
// timeout or a shutdown.
func stoppedText(ctx context.Context) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return runTimedOutText
	}
	return runCancelledText
}

// acquire waits for a run slot; false when the run was stopped first.
func (d *RunnerDispatcher) acquire(ctx context.Context) bool {
	if d.slots == nil {
		return true
	}
	select {
	case d.slots <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (d *RunnerDispatcher) release() {
	if d.slots != nil {
		<-d.slots
	}
}

// DispatchTurn starts running the turn and returns at once.
func (d *RunnerDispatcher) DispatchTurn(ctx context.Context, t Turn) error {
	return d.start(cmp.Or(t.Scope.Tenant, "-"), func() {
		waitCtx, stop := d.waitContext(ctx)
		defer stop()
		defer d.recoverTurn(waitCtx, t)
		if !d.acquire(waitCtx) {
			d.failTurn(waitCtx, t, stoppedText(waitCtx))
			return
		}
		defer d.release()
		runCtx, cancel := context.WithTimeout(waitCtx, d.turnTimeout)
		defer cancel()
		done, err := d.engine.RunTurn(runCtx, t, d.runner)
		if err != nil && !isNotPending(err) {
			d.engine.log.Error("tangent: turn run failed to complete", "turn", t.ID, "error", err)
		}
		d.dispatchJobs(waitCtx, done.Jobs)
	})
}

// recoverTurn fails a turn whose run panicked outside the runner.
func (d *RunnerDispatcher) recoverTurn(ctx context.Context, t Turn) {
	if recovered := recover(); recovered != nil {
		d.engine.log.Error("tangent: turn run panicked", "turn", t.ID, "panic", recovered)
		d.failTurn(ctx, t, runnerPanicText)
	}
}

// failTurn writes a failure back for a turn that did not run to the end
// (without feature hooks) and dispatches the jobs that started.
func (d *RunnerDispatcher) failTurn(ctx context.Context, t Turn, text string) {
	d.dispatchJobs(ctx, d.engine.failTurn(ctx, t.ID, text).Jobs)
}

// dispatchJobs dispatches the jobs a turn started.
func (d *RunnerDispatcher) dispatchJobs(ctx context.Context, jobs []Job) {
	for _, job := range jobs {
		if err := d.DispatchJob(ctx, job); err != nil {
			d.engine.log.Warn("tangent: job of a turn not dispatched", "job", job.ID, "error", err)
			d.engine.failRefusedJob(ctx, job, err)
		}
	}
}

// DispatchJob starts running the job and returns at once.
func (d *RunnerDispatcher) DispatchJob(ctx context.Context, j Job) error {
	return d.start("", func() {
		waitCtx, stop := d.waitContext(ctx)
		defer stop()
		run, ok := d.engine.inflight.add(j.ID, stop)
		if !ok {
			d.engine.log.Warn("tangent: job already running", "job", j.ID)
			return
		}
		defer d.engine.inflight.remove(j.ID, run)
		raw, runErr := "", error(context.Canceled)
		if d.acquire(waitCtx) {
			runCtx, cancel := context.WithTimeout(waitCtx, d.jobTimeout)
			raw, runErr = d.runJob(runCtx, j)
			cancel()
			d.release()
		}
		d.finishJob(waitCtx, j, raw, runErr)
	})
}

// runJob runs a job's prompt once, without streaming; a panic is an error.
func (d *RunnerDispatcher) runJob(ctx context.Context, j Job) (string, error) {
	result, err := guardedRun(ctx, d.runner, j.Request())
	if err != nil {
		return "", fmt.Errorf("job %s: %w", j.Kind, err)
	}
	return result.Content, nil
}

// finishJob writes a job's result back; a panic while recording is logged.
func (d *RunnerDispatcher) finishJob(ctx context.Context, j Job, raw string, runErr error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			d.engine.log.Error("tangent: recording a job result panicked", "job", j.ID, "panic", recovered)
		}
	}()
	writeCtx, done := detached(ctx)
	defer done()
	if err := d.engine.FinishJob(writeCtx, j.ID, raw, runErr); err != nil && !isNotPending(err) {
		d.engine.log.Error("tangent: job result not recorded", "job", j.ID, "kind", j.Kind, "error", err)
	}
}

// RunOnce runs one request now and returns its result, nothing stored
// (B22's import analysis): it counts against WithMaxQueue and WithMaxOnce
// (ErrDispatcherBusy beyond either) and waits for a WithMaxConcurrent slot like any run; Shutdown
// waits for it and Close cancels it. A runner panic is an error.
func (d *RunnerDispatcher) RunOnce(ctx context.Context, req RunRequest) (RunResult, error) {
	if d.runner == nil {
		return RunResult{}, errNoRunner
	}
	d.mu.Lock()
	switch {
	case d.closed:
		d.mu.Unlock()
		return RunResult{}, ErrDispatcherClosed
	case d.held >= d.maxQueue, d.once >= d.maxOnce:
		d.mu.Unlock()
		return RunResult{}, ErrDispatcherBusy
	}
	d.held++
	d.once++
	d.wg.Add(1)
	d.mu.Unlock()
	defer d.wg.Done()
	defer d.doneOnce()
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(d.base, cancel)
	defer stop()
	if !d.acquire(runCtx) {
		return RunResult{}, runCtx.Err()
	}
	defer d.release()
	return guardedRun(runCtx, d.runner, req)
}

// doneOnce releases what RunOnce counted.
func (d *RunnerDispatcher) doneOnce() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.held--
	d.once--
}

// Shutdown stops taking work and waits for the runs to finish. When ctx
// ends first, the runs are cancelled (they write their failure back) and
// Shutdown waits for those write-backs, returning ctx's error.
func (d *RunnerDispatcher) Shutdown(ctx context.Context) error {
	d.mu.Lock()
	d.closed = true
	d.mu.Unlock()
	finished := make(chan struct{})
	go func() {
		d.wg.Wait()
		close(finished)
	}()
	select {
	case <-finished:
		d.stop()
		return nil
	case <-ctx.Done():
		d.stop()
		<-finished
		return ctx.Err()
	}
}

// Close stops taking work, cancels every run and waits for the write-backs.
func (d *RunnerDispatcher) Close() error {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := d.Shutdown(ctx); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

// InFlight is how many turns and jobs the dispatcher holds: running or
// waiting for a slot.
func (d *RunnerDispatcher) InFlight() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.held
}

// Wait blocks until every dispatched run has written its outcome back
// (tests). Use Shutdown to stop.
func (d *RunnerDispatcher) Wait() { d.wg.Wait() }
