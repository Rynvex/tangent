package store_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
)

// supersedeWith replaces ids by a new memory of text.
func (f *fixture) supersedeWith(ids []string, text string) func() error {
	return func() error {
		_, err := f.store.SupersedeMemories(f.ctx, tenant, ids, store.MemoryWriteInput{
			Memory: domain.MemoryInput{Kind: domain.MemoryFact, Text: text}, Embedding: []float32{0, 1, 0}, Actor: "lee",
		})
		return err
	}
}

// oneWins checks that exactly one write succeeded and the other was refused
// with memory_superseded (no deadlock, no other error).
func oneWins(t *testing.T, round int, errs []error) {
	t.Helper()
	ok, superseded := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			ok++
		case domain.CodeOf(err) == domain.CodeMemorySuperseded:
			superseded++
		default:
			t.Fatalf("round %d: unexpected error %v", round, err)
		}
	}
	if ok != 1 || superseded != len(errs)-1 {
		t.Fatalf("round %d: %d won, %d refused: %v", round, ok, superseded, errs)
	}
}

// TestMemoriesConcurrency_OneSupersedeWins: two supersedes of the same
// memory, or of overlapping sets given in opposite orders, race; exactly one
// wins and the other is memory_superseded (the rows are locked in id
// order, so the same pair in opposite orders cannot deadlock), every time, without a deadlock.
// Every old memory ends superseded by the winner, and only one new memory
// stays active.
func TestMemoriesConcurrency_OneSupersedeWins(t *testing.T) {
	f := memoryFixture(t)
	for round := range 5 {
		a := f.memory(fmt.Sprintf("Same %d", round), []float32{1, 0, 0})
		oneWins(t, round, race(f.supersedeWith([]string{a.ID}, "first"), f.supersedeWith([]string{a.ID}, "second")))

		x := f.memory(fmt.Sprintf("X %d", round), []float32{1, 0, 0})
		y := f.memory(fmt.Sprintf("Y %d", round), []float32{1, 0.1, 0})
		z := f.memory(fmt.Sprintf("Z %d", round), []float32{1, 0.2, 0})
		oneWins(t, round, race(f.supersedeWith([]string{x.ID, y.ID}, "xy"), f.supersedeWith([]string{z.ID, y.ID}, "zy")))
		winners := map[string]bool{}
		for _, m := range []domain.Memory{x, y, z} {
			got, err := f.store.GetMemory(f.ctx, tenant, m.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status == domain.MemorySuperseded {
				winners[got.SupersededBy] = true
			}
		}
		if len(winners) != 1 {
			t.Fatalf("round %d: the superseded memories point at %d new ones", round, len(winners))
		}

		p := f.memory(fmt.Sprintf("P %d", round), []float32{1, 0, 0})
		q := f.memory(fmt.Sprintf("Q %d", round), []float32{1, 0.1, 0})
		started := time.Now()
		oneWins(t, round, race(f.supersedeWith([]string{p.ID, q.ID}, "pq"), f.supersedeWith([]string{q.ID, p.ID}, "qp")))
		// A deadlock would be retried (store/tx.go) after the server waited
		// deadlock_timeout to detect it, so a race this slow means one.
		if took := time.Since(started); took >= deadlockTimeout(f) {
			t.Fatalf("round %d: the opposite orders took %v: a deadlock was detected and retried", round, took)
		}
	}
	if n := f.count(`SELECT count(*) FROM tangent_memory WHERE status = 'active'`); n != 5*(1+2+1) {
		t.Fatalf("active = %d: per round one new memory per race and the untouched one of x/z", n)
	}
}

// deadlockTimeout is the server's deadlock_timeout (how long a lock wait
// lasts before the deadlock check runs).
func deadlockTimeout(f *fixture) time.Duration {
	f.t.Helper()
	var ms float64
	if err := f.pool.QueryRow(f.ctx, `SELECT setting::float8 FROM pg_settings WHERE name = 'deadlock_timeout'`).Scan(&ms); err != nil {
		f.t.Fatal(err)
	}
	return time.Duration(ms * float64(time.Millisecond))
}
