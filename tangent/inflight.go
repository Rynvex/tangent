package tangent

import (
	"context"
	"strings"
	"sync"
	"unicode/utf8"
)

// partialTextMax caps the text a run keeps for a cancel. Messages have no
// length limit of their own; this bounds what one cancelled reply stores.
const partialTextMax = 1 << 20

// inflightRun is one turn or job this process runs: how to stop it and, for
// a turn, the text streamed so far (complete, unlike the bounded delta ring).
type inflightRun struct {
	cancel context.CancelFunc
	mu     sync.Mutex
	text   strings.Builder
}

// appendText keeps streamed text up to partialTextMax bytes, never cutting
// a character in two.
func (r *inflightRun) appendText(piece string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	room := partialTextMax - r.text.Len()
	if room <= 0 {
		return
	}
	if len(piece) > room {
		piece = piece[:room]
		for len(piece) > 0 && !utf8.ValidString(piece) {
			piece = piece[:len(piece)-1]
		}
	}
	r.text.WriteString(piece)
}

func (r *inflightRun) partial() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.text.String()
}

// inflightRuns are the runs of this process by turn or job id, so a cancel
// or a delete can stop them.
type inflightRuns struct {
	mu   sync.Mutex
	runs map[string]*inflightRun
}

func newInflightRuns() *inflightRuns {
	return &inflightRuns{runs: map[string]*inflightRun{}}
}

// add registers a run; ok is false when the id already runs here.
func (r *inflightRuns) add(id string, cancel context.CancelFunc) (*inflightRun, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, running := r.runs[id]; running {
		return nil, false
	}
	run := &inflightRun{cancel: cancel}
	r.runs[id] = run
	return run, true
}

// remove unregisters the run, if it is still the one registered under id.
func (r *inflightRuns) remove(id string, run *inflightRun) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.runs[id] == run {
		delete(r.runs, id)
	}
}

func (r *inflightRuns) get(id string) (*inflightRun, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, ok := r.runs[id]
	return run, ok
}

// cancel stops the runs of the ids that run in this process.
func (r *inflightRuns) cancel(ids ...string) {
	for _, id := range ids {
		if run, ok := r.get(id); ok {
			run.cancel()
		}
	}
}
