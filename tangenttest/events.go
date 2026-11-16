package tangenttest

import (
	"context"
	"sync"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// Recorder is a tangent.Publisher that keeps every event, for assertions.
type Recorder struct {
	mu     sync.Mutex
	events []tangent.Event
	signal chan struct{}
}

// NewRecorder returns an empty recorder.
func NewRecorder() *Recorder {
	return &Recorder{signal: make(chan struct{})}
}

// Publish records the event.
func (r *Recorder) Publish(_ context.Context, ev tangent.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
	close(r.signal)
	r.signal = make(chan struct{})
}

// Events returns the recorded events in order.
func (r *Recorder) Events() []tangent.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]tangent.Event{}, r.events...)
}

// Types returns the recorded event types in order.
func (r *Recorder) Types() []string {
	events := r.Events()
	out := make([]string, 0, len(events))
	for _, ev := range events {
		out = append(out, ev.Type)
	}
	return out
}

// OfType returns the recorded events of one type in order.
func (r *Recorder) OfType(eventType string) []tangent.Event {
	out := []tangent.Event{}
	for _, ev := range r.Events() {
		if ev.Type == eventType {
			out = append(out, ev)
		}
	}
	return out
}

// Reset forgets every recorded event.
func (r *Recorder) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = nil
}

// WaitFor waits until at least n events of the type were recorded and
// reports whether that happened within timeout.
func (r *Recorder) WaitFor(eventType string, n int, timeout time.Duration) bool {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		r.mu.Lock()
		count := 0
		for _, ev := range r.events {
			if ev.Type == eventType {
				count++
			}
		}
		signal := r.signal
		r.mu.Unlock()
		if count >= n {
			return true
		}
		select {
		case <-signal:
		case <-deadline.C:
			return false
		}
	}
}
