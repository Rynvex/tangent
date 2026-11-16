package main

import (
	"context"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// The statements one turn (BeginTurn + CompleteTurn) sends, per feature
// set, on the main line and on a depth-3 branch (RF3 §2). The caps are what
// was measured plus a small margin. When a feature ticket makes a turn send
// more statements on purpose, run this test with TANGENT_QUERY_REPORT=1,
// look at the per-statement counts it logs (is the new one expected, is
// anything read twice?), then raise the cap to the new maximum plus the
// same margin and record the new numbers in that ticket's devlog.
const (
	// turnQueryRounds is how many turns are measured on each line: a few
	// features act every n-th reply, so the cap holds the largest round.
	turnQueryRounds = 10
	// envQueryReport set to 1 logs every measured turn's statements.
	envQueryReport = "TANGENT_QUERY_REPORT"
)

// turnQuerySetting is one feature set under measurement with its caps (the
// most statements one turn may send on the main line and on a depth-3
// branch).
type turnQuerySetting struct {
	name               string
	features           string // TANGENT_FEATURES; "" is the core only
	migrate            []string
	mainCap, branchCap int
}

// The caps are the largest turn measured in RF3 (docs/devlog/RF3-go-cleanup.md)
// plus about 10%: core 30 / 33, standard 51 / 81, full 60 / 90 (main line /
// depth-3 branch). The branch maxima are the turns where rebalance reads its
// signals and raises a suggestion (from the branch's sixth reply on).
var turnQuerySettings = []turnQuerySetting{
	{name: "core", mainCap: 33, branchCap: 36},
	{name: "standard", features: presetStandard, migrate: []string{tangent.FeatureSearch}, mainCap: 56, branchCap: 89},
	{name: "full", features: presetFull, migrate: []string{tangent.FeatureSearch, tangent.FeatureMemory}, mainCap: 66, branchCap: 99},
}

var queryScope = tangent.Scope{Tenant: "queries", Actor: "queries"}

func TestTurnQueries_StayWithinTheirCaps(t *testing.T) {
	for _, setting := range turnQuerySettings {
		t.Run(setting.name, func(t *testing.T) {
			engine, counter := turnQueryEngine(t, setting)
			ctx := tangenttest.Context(t)
			mainLine, branch := turnQueryTree(t, ctx, engine)
			for _, line := range []struct {
				name, id string
				cap      int
			}{{"main", mainLine, setting.mainCap}, {"depth-3", branch, setting.branchCap}} {
				for round := range turnQueryRounds {
					beginCounts, completeCounts := measureTurn(t, ctx, engine, counter, line.id)
					begin, complete := total(beginCounts), total(completeCounts)
					t.Logf("%s %s round %d: BeginTurn %d + CompleteTurn %d = %d", setting.name, line.name, round+1, begin, complete, begin+complete)
					if os.Getenv(envQueryReport) == "1" {
						t.Logf("BeginTurn:\n%sCompleteTurn:\n%s", formatCounts(beginCounts), formatCounts(completeCounts))
					}
					if begin+complete > line.cap {
						t.Errorf("%s: a turn on the %s line sent %d statements, the cap is %d (see the comment above turnQueryRounds)", setting.name, line.name, begin+complete, line.cap)
					}
				}
			}
		})
	}
}

// turnQueryEngine builds an engine like the reference server's for the
// setting (its feature list as TANGENT_FEATURES reads it, the fake provider
// and embedder) over a counted pool. No dispatcher runs the jobs a turn
// starts: only the statements of the turn itself are counted.
func turnQueryEngine(t *testing.T, setting turnQuerySetting) (*tangent.Engine, *tangenttest.QueryCounter) {
	t.Helper()
	var features []tangent.Feature
	if setting.features != "" {
		cfg, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FEATURES": setting.features}.get)
		if err != nil {
			t.Fatal(err)
		}
		features = cfg.Features
	}
	pool := tangenttest.OpenFeatures(t, setting.migrate...)
	counted, counter := tangenttest.CountQueries(t, pool)
	engine, err := tangent.New(counted, tangent.WithFeatures(features...), tangent.WithLogger(slog.New(slog.DiscardHandler)))
	if err != nil {
		t.Fatal(err)
	}
	return engine, counter
}

// turnQueryTree makes a main line with two turns and a chain of branches
// down to depth 3, each with one turn, and returns the main line and the
// depth-3 branch.
func turnQueryTree(t *testing.T, ctx context.Context, engine *tangent.Engine) (string, string) {
	t.Helper()
	line, err := engine.CreateLine(ctx, queryScope, tangent.LineInput{Title: "query counts", Provider: providerFake, Model: "fake"})
	if err != nil {
		t.Fatal(err)
	}
	anchor := ""
	for range 2 {
		anchor = runTurn(t, ctx, engine, line.ID)
	}
	parent := line.ID
	for depth := 1; depth <= 3; depth++ {
		created, err := engine.CreateBranch(ctx, queryScope, parent, tangent.BranchInput{
			AnchorMessageID: anchor, Purpose: fmt.Sprintf("depth %d", depth), Kind: domain.BranchKindInvestigate, ConfirmDeeper: true,
		})
		if err != nil {
			t.Fatalf("branch at depth %d: %v", depth, err)
		}
		parent = created.Line.ID
		anchor = runTurn(t, ctx, engine, parent)
	}
	return line.ID, parent
}

// runTurn runs one turn on the line and returns the reply's id.
func runTurn(t *testing.T, ctx context.Context, engine *tangent.Engine, lineID string) string {
	t.Helper()
	turn, err := engine.BeginTurn(ctx, queryScope, lineID, tangent.TurnInput{Content: "How does the planner pick a join order?"})
	if err != nil {
		t.Fatal(err)
	}
	done, err := engine.CompleteTurn(ctx, turn.ID, tangent.TurnResult{Content: "It estimates the cost of each order and keeps the cheapest."})
	if err != nil {
		t.Fatal(err)
	}
	return done.Message.ID
}

// measureTurn runs one turn and returns the statements of BeginTurn and of
// CompleteTurn, by statement.
func measureTurn(t *testing.T, ctx context.Context, engine *tangent.Engine, counter *tangenttest.QueryCounter, lineID string) (map[string]int, map[string]int) {
	t.Helper()
	counter.Reset()
	turn, err := engine.BeginTurn(ctx, queryScope, lineID, tangent.TurnInput{Content: "And when the statistics are stale?"})
	if err != nil {
		t.Fatal(err)
	}
	begin := counter.Counts()
	counter.Reset()
	if _, err := engine.CompleteTurn(ctx, turn.ID, tangent.TurnResult{Content: "Then its estimates are off and it may pick a slow order."}); err != nil {
		t.Fatal(err)
	}
	return begin, counter.Counts()
}

// total adds up per-statement counts.
func total(counts map[string]int) int {
	n := 0
	for _, c := range counts {
		n += c
	}
	return n
}

// formatCounts lists statements by count, then name.
func formatCounts(counts map[string]int) string {
	keys := slices.Sorted(maps.Keys(counts))
	slices.SortStableFunc(keys, func(a, b string) int { return counts[b] - counts[a] })
	var out strings.Builder
	for _, key := range keys {
		fmt.Fprintf(&out, "  %3d  %s\n", counts[key], key)
	}
	return out.String()
}
