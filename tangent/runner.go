package tangent

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Rynvex/tangent/domain"
)

// Runner runs one model call. Implementations live in runner/ (B4); the
// library never decides how a call runs.
type Runner interface {
	Run(ctx context.Context, req RunRequest) (RunResult, error)
}

// RunRequest is one call: a system string and chat messages.
type RunRequest struct {
	Provider string
	Model    string
	// System is the whole system prompt; SystemBlocks is the same text in
	// parts (joined with a blank line they equal System), so a runner can put
	// a prompt-cache breakpoint after the stable part. Either may be empty.
	System       string
	SystemBlocks []SystemBlock
	Messages     []domain.ChatMessage
	MaxTokens    int
	// OnDelta receives streamed pieces; may be nil.
	OnDelta func(domain.Delta)
	// OnRetry is told before the runner retries a 429 / 5xx; may be nil.
	OnRetry func(Retry)
	// ReasoningEffort asks the model to think more or less (for example
	// low, medium, high); empty leaves it to the runner. A runner that has
	// no such setting, or does not know the value, ignores it. The library
	// never sets it: a host's Runner (or a wrapper around one) fills it, for
	// example from HostMeta.
	ReasoningEffort string
	// HostMeta is the host_meta of the operator message that started the
	// turn (Turn.Request), passed through unread so a host's Runner can act
	// on its own per-turn settings; nil when that is empty ({}), for jobs
	// and for ChatRequest.
	HostMeta json.RawMessage
}

// SystemBlock is one part of the system prompt. Stable parts (rules, pack,
// notes, host sections) come first and change rarely; the volatile part
// (summary, card notices, condensed history) changes from turn to turn.
type SystemBlock struct {
	Text   string
	Stable bool
}

// ChatRequest renders a prompt for a chat runner the way RunTurn and the
// runner dispatcher do: System is the whole system prompt, SystemBlocks the
// same text as its stable part (rules, pack, notes, host sections not
// marked Trailing) and its volatile part, so runner/anthropic can put its
// cache breakpoint between.
// A custom Dispatcher or worker uses it (or Turn.Request / Job.Request)
// instead of rebuilding the request.
func ChatRequest(p domain.Prompt, provider, model string) RunRequest {
	stable, volatile, messages := p.ChatBlocks()
	blocks := []SystemBlock{}
	parts := []string{}
	if stable != "" {
		blocks = append(blocks, SystemBlock{Text: stable, Stable: true})
		parts = append(parts, stable)
	}
	if volatile != "" {
		blocks = append(blocks, SystemBlock{Text: volatile})
		parts = append(parts, volatile)
	}
	return RunRequest{Provider: provider, Model: model, System: strings.Join(parts, "\n\n"), SystemBlocks: blocks, Messages: messages}
}

// Request is the turn's runner request (ChatRequest of its prompt, provider
// and model, with the operator message's host_meta as HostMeta unless it is
// empty), without callbacks.
func (t Turn) Request() RunRequest {
	req := ChatRequest(t.Prompt, t.Provider, t.Model)
	if !emptyHostMeta(t.UserMessage.HostMeta) {
		req.HostMeta = append(json.RawMessage(nil), t.UserMessage.HostMeta...)
	}
	return req
}

// emptyHostMeta reports host_meta that says nothing: absent, null or {}.
func emptyHostMeta(raw json.RawMessage) bool {
	switch strings.Join(strings.Fields(string(raw)), "") {
	case "", "null", "{}":
		return true
	}
	return false
}

// Request is the job's runner request: one call, no streaming.
func (j Job) Request() RunRequest { return ChatRequest(j.Prompt, j.Provider, j.Model) }

// Retry describes an automatic retry the runner is about to make.
type Retry struct {
	Attempt     int
	MaxAttempts int
	NextRetryAt time.Time
}

// RunResult is a finished call.
type RunResult struct {
	Content    string
	Usage      domain.Usage
	StopReason string
	// Model is the model that actually ran (the runner's default when the
	// request named none); empty when the runner does not say.
	Model string
}

// RunnerError is how a Runner says what the operator may see about a
// failure: Public is stored on the turn and published; Err is only logged.
// Any other runner error is stored as a fixed text.
type RunnerError struct {
	Public string
	Err    error
}

func (e *RunnerError) Error() string {
	if e.Err == nil {
		return e.Public
	}
	return e.Public + ": " + e.Err.Error()
}

func (e *RunnerError) Unwrap() error { return e.Err }

// Fixed texts stored for a failed run; the detail goes to the log only.
const (
	runFailedText    = "the model run failed"
	runTimedOutText  = "the model run timed out"
	runCancelledText = "the model run was cancelled"
	runnerPanicText  = "the runner crashed"
)

// errRunnerPanic marks a run whose runner panicked.
var errRunnerPanic = errors.New(runnerPanicText)

// publicRunError is the text stored for a failed run.
func publicRunError(err error) string {
	var public *RunnerError
	switch {
	case errors.As(err, &public) && public.Public != "":
		return public.Public
	case errors.Is(err, errRunnerPanic):
		return runnerPanicText
	case errors.Is(err, context.DeadlineExceeded):
		return runTimedOutText
	case errors.Is(err, context.Canceled):
		return runCancelledText
	}
	return runFailedText
}

// errTurnRunning refuses a second run of a turn this process already runs.
var errTurnRunning = domain.NewError(domain.CodeTurnPending, "this turn is already running", nil)

// RunTurn is the synchronous convenience over the turn protocol: it renders
// the prompt with Prompt.Chat, runs it (streaming deltas into the buffer and
// publishing retries), and completes the turn with the result. A turn that
// is cancelled before or while it runs returns ErrTurnNotPending (its usage,
// if the runner still reported one, is recorded). A runner that fails or
// panics fails the turn with a fixed text; the detail is logged. A turn this
// process already runs is refused.
func (e *Engine) RunTurn(ctx context.Context, t Turn, r Runner) (CompletedTurn, error) {
	if r == nil {
		return CompletedTurn{}, fmt.Errorf("tangent: RunTurn needs a runner")
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	run, ok := e.inflight.add(t.ID, cancel)
	if !ok {
		return CompletedTurn{}, errTurnRunning
	}
	defer e.inflight.remove(t.ID, run)
	// A cancel that landed before the run was registered is seen here.
	if _, err := e.store.GetTurn(runCtx, t.ID); err != nil {
		e.forgetTurnIfEnded(t.ID, err)
		return CompletedTurn{}, err
	}
	started := e.now()
	result, runErr := guardedRun(runCtx, r, e.turnRequest(ctx, runCtx, t, run, cancel))
	model := cmp.Or(result.Model, t.Model)
	usage := e.priced(model, result.Usage)
	outcome := TurnResult{Content: result.Content, Usage: &usage, DurationMs: e.now().Sub(started).Milliseconds(), Model: result.Model}
	if runErr != nil {
		e.log.Warn("tangent: turn run failed", "turn", t.ID, "error", runErr)
		outcome = TurnResult{Error: publicRunError(runErr), DurationMs: outcome.DurationMs, Provider: t.Provider, Model: model}
	}
	writeCtx, done := detached(ctx)
	defer done()
	completed, err := e.CompleteTurn(writeCtx, t.ID, outcome)
	switch {
	case errors.Is(err, domain.ErrTurnNotPending):
		if runErr == nil {
			e.recordLateUsage(writeCtx, t.ID, usage)
		}
	case err != nil:
		// A feature hook (or the host's) refused the reply: fail the turn without hooks.
		e.log.Error("tangent: a turn result was refused", "turn", t.ID, "error", err)
		return e.failTurn(writeCtx, t.ID, recordFailedText), err
	}
	return completed, err
}

// pendingRecheck is how often a streaming run asks the store whether its
// turn is still pending (a cancel from another process ends it).
const pendingRecheck = 2 * time.Second

// turnRequest is the runner request of a turn: deltas go to the run's own
// text and to the buffer. A delta refused because the turn ended, or a
// periodic check that finds it ended, stops the run.
func (e *Engine) turnRequest(ctx, runCtx context.Context, t Turn, run *inflightRun, cancel context.CancelFunc) RunRequest {
	req := t.Request()
	var mu sync.Mutex
	lastCheck := e.now()
	ended := func() bool {
		mu.Lock()
		defer mu.Unlock()
		if e.now().Sub(lastCheck) < pendingRecheck {
			return false
		}
		lastCheck = e.now()
		_, err := e.store.GetTurn(runCtx, t.ID)
		e.forgetTurnIfEnded(t.ID, err)
		return errors.Is(err, domain.ErrTurnNotPending)
	}
	req.OnDelta = func(d domain.Delta) {
		if d.Kind == domain.DeltaText {
			run.appendText(d.Text)
		}
		err := e.AppendDelta(runCtx, t.ID, d)
		if errors.Is(err, domain.ErrTurnNotPending) || ended() {
			cancel()
		} else if err != nil {
			e.log.Debug("tangent: delta dropped", "turn", t.ID, "error", err)
		}
	}
	req.OnRetry = func(info Retry) { e.publishRetry(ctx, t, info) }
	return req
}

// recordLateUsage keeps the usage of a run whose turn ended meanwhile.
func (e *Engine) recordLateUsage(ctx context.Context, turnID string, usage domain.Usage) {
	if usage.TotalTokens() == 0 && usage.CostUSD == 0 {
		return
	}
	if _, err := e.store.RecordTurnUsage(ctx, turnID, usage); err != nil {
		e.log.Warn("tangent: usage of an ended turn not recorded", "turn", turnID, "error", err)
	}
}

// guardedRun calls the runner and turns a panic into errRunnerPanic (the
// panic value is logged by the caller through the error, never stored).
func guardedRun(ctx context.Context, r Runner, req RunRequest) (result RunResult, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result, err = RunResult{}, fmt.Errorf("%w: %v", errRunnerPanic, recovered)
		}
	}()
	return r.Run(ctx, req)
}

func (e *Engine) publishRetry(ctx context.Context, t Turn, info Retry) {
	e.publish(ctx, Event{
		Type: EventTurnRetrying, Tenant: t.Scope.Tenant, RootLineID: t.RootLineID, LineID: t.LineID,
		Data: TurnRetrying{TurnID: t.ID, Attempt: info.Attempt, MaxAttempts: info.MaxAttempts, NextRetryAt: info.NextRetryAt},
	})
}
