// Command soak drives the reference server (fake runner) for a long run:
// several workers hold conversations at once (turns with random waits,
// failures, cancels and retries, branches and every way they end,
// searches, and every feature the server has on: the suggestion inbox,
// leaves, seeds, spinoffs, rebalance, goals, relations, open loops,
// groups and combine, pins, the fisheye, argument tags, folds, diverge /
// converge / decide, memories) while one client follows /events. At the
// end it waits for the server to go quiet and checks the database: no
// pending turn or job of any kind, no draft left drafting, no line left
// thinking, at most one pending reply per line, no suggestion pointing at
// what is gone, folds of a line apart, no cycle of superseded memories,
// decided comparisons' siblings closed; it compares the server's
// goroutines, memory and connections with the start, and (with
// -require-ops) that every operation of the features on succeeded at least
// once.
//
// scripts/soak.sh builds and starts the server and runs this.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type options struct {
	base, tokenFile, databaseURL, report string
	duration, sample, settle             time.Duration
	workers                              int
	seed                                 uint64
	requireOps                           bool
}

func main() {
	var o options
	flag.StringVar(&o.base, "base", "http://127.0.0.1:8122", "server URL")
	flag.StringVar(&o.tokenFile, "token-file", "", "file holding the writer token")
	flag.StringVar(&o.databaseURL, "database", "", "the server's database (for the final checks)")
	flag.StringVar(&o.report, "report", "soak-report.json", "where the JSON report goes")
	flag.DurationVar(&o.duration, "duration", time.Hour, "how long the workers run")
	flag.DurationVar(&o.sample, "sample", time.Minute, "how often server stats are sampled")
	flag.DurationVar(&o.settle, "settle", 2*time.Minute, "how long to wait for the server to go quiet at the end")
	flag.IntVar(&o.workers, "workers", 8, "concurrent conversations")
	flag.Uint64Var(&o.seed, "seed", 1, "random seed")
	flag.BoolVar(&o.requireOps, "require-ops", false, "fail unless every operation of the features on succeeded at least once")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	report, err := run(ctx, o)
	if err != nil {
		fmt.Fprintln(os.Stderr, "soak:", err)
		os.Exit(2)
	}
	if !report.Passed {
		os.Exit(1)
	}
}

// run is the whole soak: start sample, workers and the event follower for
// the duration, settle, final checks, report.
func run(ctx context.Context, o options) (*report, error) {
	token, err := os.ReadFile(o.tokenFile)
	if err != nil {
		return nil, fmt.Errorf("read the token file: %w", err)
	}
	pool, err := pgxpool.New(ctx, o.databaseURL)
	if err != nil {
		return nil, fmt.Errorf("database: %w", err)
	}
	defer pool.Close()
	st, inv := newCounters(), newInvariants()
	c := &client{base: strings.TrimRight(o.base, "/"), token: strings.TrimSpace(string(token)), http: &http.Client{}, stats: st}
	feats, err := readFeatures(ctx, c)
	if err != nil {
		return nil, fmt.Errorf("read /capabilities: %w", err)
	}
	var required []string
	if o.requireOps {
		required = requiredOperations(feats)
	}
	r := &report{Started: time.Now(), Options: fmt.Sprintf("%+v", o), Features: feats}
	r.sample(ctx, c, pool, "start")
	runCtx, cancel := context.WithTimeout(ctx, o.duration)
	defer cancel()
	var wg sync.WaitGroup
	events := &eventCounts{byType: map[string]int{}}
	wg.Go(func() { follow(runCtx, c, inv, events) })
	wg.Go(func() { r.sampleEvery(runCtx, c, pool, o.sample) })
	for i := range o.workers {
		w := &worker{id: i, c: c, rng: rand.New(rand.NewPCG(o.seed, uint64(i))), inv: inv, st: st, feats: feats}
		wg.Go(func() { w.run(runCtx) })
	}
	wg.Wait()
	settled := settle(context.WithoutCancel(ctx), pool, o.settle)
	r.sample(context.WithoutCancel(ctx), c, pool, "end")
	r.finish(context.WithoutCancel(ctx), pool, st, inv, events, settled, required)
	return r, r.write(o.report)
}

// settle waits until no turn or job is pending (or the budget runs out).
func settle(ctx context.Context, pool *pgxpool.Pool, budget time.Duration) time.Duration {
	started := time.Now()
	for time.Since(started) < budget {
		var pending int
		err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM tangent_message WHERE status = 'pending')
			+ (SELECT count(*) FROM tangent_job WHERE status = 'pending')
			+ (SELECT count(*) FROM tangent_fold WHERE status = 'drafting')
			+ (SELECT count(*) FROM tangent_comparison WHERE status = 'drafting')`).Scan(&pending)
		if err == nil && pending == 0 {
			break
		}
		sleep(ctx, time.Second)
	}
	return time.Since(started)
}

// eventCounts tallies what /events delivered.
type eventCounts struct {
	mu         sync.Mutex
	byType     map[string]int
	reconnects int
}

func (e *eventCounts) add(eventType string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.byType[eventType]++
}

// follow reads /events until ctx ends, reconnecting when the stream drops,
// and checks the deltas of every turn rise.
func follow(ctx context.Context, c *client, inv *invariants, counts *eventCounts) {
	for ctx.Err() == nil {
		if err := followOnce(ctx, c, inv, counts); err != nil && ctx.Err() == nil {
			counts.mu.Lock()
			counts.reconnects++
			counts.mu.Unlock()
			sleep(ctx, time.Second)
		}
	}
}

func followOnce(ctx context.Context, c *client, inv *invariants, counts *eventCounts) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/events", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("events: %d", resp.StatusCode)
	}
	return readEvents(resp.Body, func(eventType string, data []byte) {
		counts.add(eventType)
		if eventType != "message.delta" {
			return
		}
		var ev struct {
			Data struct {
				TurnID string `json:"turnId"`
				Seq    int64  `json:"seq"`
			} `json:"data"`
		}
		if json.Unmarshal(data, &ev) == nil {
			inv.observeDelta(ev.Data.TurnID, ev.Data.Seq)
		}
	})
}
