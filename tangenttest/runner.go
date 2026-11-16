package tangenttest

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// Reply is one programmed answer of a FakeRunner.
type Reply struct {
	// Content is the reply; empty means the concatenation of Chunks.
	Content string
	// Chunks are streamed as text deltas before the reply returns.
	Chunks []string
	// Err fails the run.
	Err error
	// Delay waits before answering; a context that ends first ends the run
	// with its error (use a long Delay for a run that only a cancel stops).
	Delay time.Duration
	// Retries reports that many automatic retries through OnRetry first.
	Retries int
	// Panic makes the runner panic with this value.
	Panic any
	Usage domain.Usage
}

// FakeRunner is a programmable tangent.Runner: queued replies are used in
// order, then Respond (when set), then Default.
type FakeRunner struct {
	mu       sync.Mutex
	queue    []Reply
	requests []tangent.RunRequest
	// Respond answers when the queue is empty; it may look at the request.
	Respond func(req tangent.RunRequest) Reply
	// Default answers when the queue is empty and Respond is nil.
	Default Reply
}

// NewFakeRunner returns a runner that answers with replies in order and then
// with "ok".
func NewFakeRunner(replies ...Reply) *FakeRunner {
	return &FakeRunner{queue: append([]Reply{}, replies...), Default: Reply{Content: "ok"}}
}

// Queue appends replies.
func (f *FakeRunner) Queue(replies ...Reply) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.queue = append(f.queue, replies...)
}

// Requests returns every request the runner received, in order.
func (f *FakeRunner) Requests() []tangent.RunRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]tangent.RunRequest{}, f.requests...)
}

// Run answers with the next programmed reply.
func (f *FakeRunner) Run(ctx context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	reply := f.next(req)
	if reply.Panic != nil {
		panic(reply.Panic)
	}
	for attempt := 1; attempt <= reply.Retries; attempt++ {
		if req.OnRetry != nil {
			req.OnRetry(tangent.Retry{Attempt: attempt, MaxAttempts: reply.Retries + 1, NextRetryAt: time.Now()})
		}
	}
	for _, chunk := range reply.Chunks {
		if req.OnDelta != nil {
			req.OnDelta(domain.Delta{Kind: domain.DeltaText, Text: chunk})
		}
	}
	if err := wait(ctx, reply.Delay); err != nil {
		return tangent.RunResult{}, err
	}
	if reply.Err != nil {
		return tangent.RunResult{}, reply.Err
	}
	content := reply.Content
	if content == "" {
		content = strings.Join(reply.Chunks, "")
	}
	return tangent.RunResult{Content: content, Usage: reply.Usage, StopReason: "end_turn"}, nil
}

func (f *FakeRunner) next(req tangent.RunRequest) Reply {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, req)
	if len(f.queue) > 0 {
		reply := f.queue[0]
		f.queue = f.queue[1:]
		return reply
	}
	if f.Respond != nil {
		return f.Respond(req)
	}
	return f.Default
}

// ErrFake is a ready-made runner error.
var ErrFake = errors.New("fake runner: upstream error")

func wait(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
