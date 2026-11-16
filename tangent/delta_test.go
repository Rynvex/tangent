package tangent

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
)

type fakeClock struct{ at time.Time }

func (c *fakeClock) now() time.Time { return c.at }

func newTestRegistry() (*deltaRegistry, *fakeClock) {
	clock := &fakeClock{at: time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)}
	return newDeltaRegistry(clock.now), clock
}

func text(s string) domain.Delta {
	return domain.Delta{TurnID: "turn", Kind: domain.DeltaText, Text: s}
}

func TestDeltaRegistry_SequenceNumbersOnlyGrowAndTailAfterACursor(t *testing.T) {
	r, clock := newTestRegistry()
	first := r.append("t1", "line-a", text("he"))
	second := r.append("t1", "line-a", text("llo"))
	other := r.append("t1", "line-b", domain.Delta{TurnID: "turn-b", Kind: domain.DeltaText, Text: "x"})
	if first.Seq <= clock.at.UnixMicro() || second.Seq != first.Seq+1 || other.Seq != second.Seq+1 {
		t.Fatalf("seqs = %d %d %d", first.Seq, second.Seq, other.Seq)
	}
	tail := r.since("t1", "line-a", first.Seq)
	if len(tail.Deltas) != 1 || tail.Deltas[0].Text != "llo" || tail.Seq != second.Seq || tail.Truncated {
		t.Fatalf("tail = %+v", tail)
	}
	if got := r.since("t2", "line-a", 0); len(got.Deltas) != 0 || got.Truncated {
		t.Fatalf("another tenant must see nothing, got %+v", got)
	}
	if got := r.text("t1", "line-a", "turn", 0); got != "hello" {
		t.Fatalf("text = %q", got)
	}
	// A restarted process continues above the numbers handed out before.
	clock.at = clock.at.Add(time.Second)
	if restarted := newDeltaRegistry(clock.now).append("t1", "line-a", text("x")); restarted.Seq <= other.Seq {
		t.Fatalf("seq after a restart %d <= %d", restarted.Seq, other.Seq)
	}
}

func TestDeltaRegistry_ReportsWhatTrimmingAndEvictionLost(t *testing.T) {
	r, _ := newTestRegistry()
	chunk := strings.Repeat("x", 1000)
	first := r.append("t1", "line", text(chunk))
	for range 99 {
		r.append("t1", "line", text(chunk))
	}
	tail := r.since("t1", "line", 0)
	total := 0
	for _, d := range tail.Deltas {
		total += deltaSize(d)
	}
	if total > deltaBufferLimit || !tail.Truncated || tail.Deltas[0].Seq == first.Seq {
		t.Fatalf("kept %d bytes in %d deltas, truncated %v", total, len(tail.Deltas), tail.Truncated)
	}
	if fresh := r.since("t1", "line", tail.Deltas[0].Seq); fresh.Truncated {
		t.Fatal("a cursor inside the kept tail is not truncated")
	}
	huge := r.append("t1", "line", text(strings.Repeat("y", deltaBufferLimit+1)))
	if after := r.since("t1", "line", huge.Seq-1); !after.Truncated || len(after.Deltas) != 0 {
		t.Fatalf("a dropped delta must be reported: %+v", after)
	}
	r.forget("t1", []string{"line"})
	if gone := r.since("t1", "line", huge.Seq); !gone.Truncated || gone.Seq != 0 {
		t.Fatalf("a cursor without a buffer is truncated: %+v", gone)
	}
}

func TestDeltaRegistry_EvictsExpiredAndLeastRecentlyUpdatedLinesPerTenant(t *testing.T) {
	r, clock := newTestRegistry()
	for i := range deltaLinesPerTenant {
		clock.at = clock.at.Add(time.Second)
		r.append("t1", fmt.Sprintf("line-%d", i), text("x"))
	}
	clock.at = clock.at.Add(time.Second)
	r.append("t1", "newcomer", text("x"))
	if got := r.since("t1", "line-0", 0); len(got.Deltas) != 0 {
		t.Fatalf("the least recently updated line must be evicted, got %+v", got)
	}
	if got := r.since("t1", "line-1", 0); len(got.Deltas) != 1 {
		t.Fatalf("line-1 must stay, got %+v", got)
	}
	clock.at = clock.at.Add(deltaRetention + time.Minute)
	r.append("t1", "fresh", text("x"))
	if got := r.since("t1", "newcomer", 0); len(got.Deltas) != 0 {
		t.Fatalf("expired buffers must go, got %+v", got)
	}
}

func TestDeltaRegistry_SweepDropsExpiredBuffersAndEmptyTenants(t *testing.T) {
	r, clock := newTestRegistry()
	r.append("t1", "a", text("x"))
	r.append("t2", "b", text("x"))
	if n := r.sweep(); n != 0 {
		t.Fatalf("fresh buffers swept: %d", n)
	}
	clock.at = clock.at.Add(deltaRetention + time.Second)
	r.append("t3", "c", text("x"))
	if n := r.sweep(); n != 2 || len(r.tenants) != 1 {
		t.Fatalf("swept %d, tenants %d", n, len(r.tenants))
	}
}

func TestTurnCache_IsAnLRUAndForgetsDeletedLines(t *testing.T) {
	c := newTurnCache()
	c.put(turnRef{turnID: "a", tenant: "t", lineID: "l1"})
	c.put(turnRef{turnID: "b", tenant: "t", lineID: "l2"})
	c.put(turnRef{turnID: "a", tenant: "t", lineID: "l1"})
	if ref, ok := c.get("a"); !ok || ref.lineID != "l1" || c.size() != 2 {
		t.Fatalf("get = %+v %v size %d", ref, ok, c.size())
	}
	c.dropLines([]string{"l2", "unknown"})
	if _, ok := c.get("b"); ok || len(c.byLine) != 1 {
		t.Fatalf("a deleted line's turn must be gone (index %v)", c.byLine)
	}
	c.drop("a")
	c.drop("missing")
	for i := range turnCacheMax + 10 {
		c.put(turnRef{turnID: fmt.Sprint(i)})
		if i == 0 {
			c.get("0") // touched: survives longer than 1..9
		}
	}
	if c.size() != turnCacheMax {
		t.Fatalf("cache holds %d", c.size())
	}
	if _, ok := c.get(fmt.Sprint(turnCacheMax + 9)); !ok {
		t.Fatal("the newest entry must stay")
	}
}

func TestInflightRuns_RefuseDuplicatesAndCapTheText(t *testing.T) {
	r := newInflightRuns()
	cancelled := false
	run, ok := r.add("turn", func() { cancelled = true })
	if !ok {
		t.Fatal("first add refused")
	}
	if _, ok := r.add("turn", func() {}); ok {
		t.Fatal("a second run of the same turn must be refused")
	}
	run.appendText(strings.Repeat("é", partialTextMax))
	run.appendText("more")
	if got := run.partial(); len(got) > partialTextMax || !strings.HasPrefix(got, "é") || strings.ContainsRune(got, '�') {
		t.Fatalf("partial is %d bytes", len(got))
	}
	r.cancel("turn", "other")
	stale := &inflightRun{cancel: context.CancelFunc(func() {})}
	r.remove("turn", stale)
	if _, ok := r.get("turn"); !ok || !cancelled {
		t.Fatal("remove must only drop the run it was given")
	}
	r.remove("turn", run)
	if _, ok := r.get("turn"); ok {
		t.Fatal("run still registered")
	}
}

// Phase-2 review H1: a buffer re-created after an eviction still reports a
// cursor from the evicted one as truncated.
func TestDeltaRegistry_ARecreatedBufferReportsOlderCursorsAsTruncated(t *testing.T) {
	r, _ := newTestRegistry()
	seen := r.append("t1", "line", text("seen"))
	last := r.append("t1", "line", text("missed"))
	r.forget("t1", []string{"line"})
	fresh := r.append("t1", "line", text("after"))
	tail := r.since("t1", "line", seen.Seq)
	if !tail.Truncated || len(tail.Deltas) != 1 || tail.Deltas[0].Seq != fresh.Seq {
		t.Fatalf("tail = %+v", tail)
	}
	if complete := r.since("t1", "line", last.Seq); complete.Truncated {
		t.Fatal("a client that saw the whole evicted buffer lost nothing")
	}
	if fromStart := r.since("t1", "line", 0); fromStart.Truncated {
		t.Fatal("a client starting from zero is not truncated")
	}
	if current := r.since("t1", "line", fresh.Seq); current.Truncated {
		t.Fatal("a cursor inside the new buffer is not truncated")
	}
}
