package main

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"
)

// invariants collects what the run observed that must never happen.
type invariants struct {
	mu         sync.Mutex
	terminal   map[string]string // branch line id -> terminal status first seen
	deltaSeq   map[string]int64  // turn id -> last delta seq seen on /events
	violations []string
}

func newInvariants() *invariants {
	return &invariants{terminal: map[string]string{}, deltaSeq: map[string]int64{}}
}

func (v *invariants) violate(format string, args ...any) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(v.violations) < maxViolations {
		v.violations = append(v.violations, time.Now().Format(time.RFC3339)+" "+fmt.Sprintf(format, args...))
	}
}

// maxViolations bounds the report.
const maxViolations = 200

// terminalStatus reports whether a branch status is final.
func terminalStatus(status string) bool {
	return status == "merged" || status == "discarded" || status == "promoted"
}

// observeBranches checks an outline read: a branch that was seen ended
// never shows open again, nor another ending.
func (v *invariants) observeBranches(branches []branchView) {
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, b := range branches {
		seen, ended := v.terminal[b.LineID]
		switch {
		case ended && seen != b.Status:
			v.addLocked("branch %s went from %s to %s", b.LineID, seen, b.Status)
		case !ended && terminalStatus(b.Status):
			v.terminal[b.LineID] = b.Status
		}
	}
}

func (v *invariants) addLocked(format string, args ...any) {
	if len(v.violations) < maxViolations {
		v.violations = append(v.violations, time.Now().Format(time.RFC3339)+" "+fmt.Sprintf(format, args...))
	}
}

// observeMessages checks one page of a line's messages: seq strictly rises
// and at most one reply is pending.
func (v *invariants) observeMessages(lineID string, messages []message) {
	if err := checkMessages(messages); err != nil {
		v.violate("line %s: %v", lineID, err)
	}
}

func checkMessages(messages []message) error {
	pending := 0
	for i, m := range messages {
		if i > 0 && m.Seq <= messages[i-1].Seq {
			return fmt.Errorf("seq %d follows %d", m.Seq, messages[i-1].Seq)
		}
		if m.Status == "pending" {
			pending++
		}
	}
	if pending > 1 {
		return fmt.Errorf("%d pending replies", pending)
	}
	return nil
}

// observeDelta checks the deltas of one turn arrive with rising seqs.
func (v *invariants) observeDelta(turnID string, seq int64) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if last, ok := v.deltaSeq[turnID]; ok && seq <= last {
		v.addLocked("turn %s: delta seq %d after %d", turnID, seq, last)
	}
	v.deltaSeq[turnID] = seq
	if len(v.deltaSeq) > deltaTurnsKept {
		clear(v.deltaSeq) // old turns are done; keep the map small
	}
}

// deltaTurnsKept bounds the per-turn delta bookkeeping.
const deltaTurnsKept = 50000

func (v *invariants) list() []string {
	v.mu.Lock()
	defer v.mu.Unlock()
	return slices.Clone(v.violations)
}

// counters tallies requests, refusals, outcomes and every operation's
// results for the report.
type counters struct {
	mu        sync.Mutex
	requests  map[string]int
	refusals  map[string]int
	outcomes  map[string]int
	ops       map[string]map[string]int // operation -> result -> count
	latencies map[string][]time.Duration
	failures  []string
}

func newCounters() *counters {
	return &counters{requests: map[string]int{}, refusals: map[string]int{}, outcomes: map[string]int{},
		ops: map[string]map[string]int{}, latencies: map[string][]time.Duration{}}
}

func (c *counters) latency(route string, d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests[route]++
	if len(c.latencies[route]) < latencySamples {
		c.latencies[route] = append(c.latencies[route], d)
	}
}

// latencySamples bounds the samples kept per route.
const latencySamples = 20000

func (c *counters) transport(route string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refusals["transport "+route]++
}

// refusal records a non-2xx answer: expected refusals by code, anything
// that looks like a server fault (5xx other than 503) as a failure.
func (c *counters) refusal(route string, err *apiError) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.refusals[fmt.Sprintf("%d %s", err.Status, err.Code)]++
	if err.Status >= 500 && err.Status != 503 && len(c.failures) < maxViolations {
		c.failures = append(c.failures, route+": "+err.Error())
	}
}

func (c *counters) outcome(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.outcomes[name]++
}

// op records one result of an operation ("ok", "refused <code>",
// "skipped: <why>", "unexpected", …).
func (c *counters) op(name, result string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ops[name] == nil {
		c.ops[name] = map[string]int{}
	}
	c.ops[name][result]++
}

// unexpected records a refusal the driver did not expect.
func (c *counters) unexpected(what string, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.outcomes["unexpected"]++
	if len(c.failures) < maxViolations {
		c.failures = append(c.failures, what+": "+err.Error())
	}
}

// fail records a response the driver could not accept (a wrong shape or a
// broken promise of the API) as a failure of the operation.
func (c *counters) fail(what, format string, args ...any) {
	c.op(what, "failed")
	c.unexpected(what, fmt.Errorf(format, args...))
}

// expectedCodes are refusals a busy, concurrent run produces by design.
var expectedCodes = map[string]bool{
	"turn_pending": true, "branch_busy": true, "parent_busy": true, "parent_moved": true, "source_busy": true,
	"session_busy": true, "branch_closed": true, "branch_drafting": true, "aside_answered": true, "parent_closed": true,
	"open_branches_on_old_tail": true, "depth_soft_limit": true, "depth_hard_limit": true, "branch_limit": true,
	"tree_limit": true, "draft_not_pending": true, "not_enough_messages": true, "move_must_start_with_user": true,
	"move_protected_message": true, "move_no_anchor": true, "nothing_to_retry": true, "unavailable": true,
	"no_messages": true, "promote_not_top_level": true, "anchor_not_found": true, "archived": true, "turn_not_pending": true,
	"note_limit": true, "note_superseded": true, "branch_not_found": true, "invalid_parent_tip": true,
}

// classify sorts an error: nil and expected refusals are fine (true);
// anything else is recorded as unexpected. allowed are refusals this
// operation expects on top of expectedCodes. Every call is tallied under
// the operation's name.
func (c *counters) classify(what string, err error, allowed ...string) bool {
	if err == nil {
		c.op(what, "ok")
		return true
	}
	var refused *apiError
	if errors.As(err, &refused) && (expectedCodes[refused.Code] || slices.Contains(allowed, refused.Code)) {
		c.op(what, "refused "+refused.Code)
		c.outcome("refused " + refused.Code)
		return true
	}
	if errors.Is(err, errStopped) || errors.Is(err, context.Canceled) {
		c.op(what, "stopped")
		return true
	}
	c.op(what, "unexpected")
	c.unexpected(what, err)
	return false
}
