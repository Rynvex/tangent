package tangent_test

import (
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

const (
	// envPerfMemory set to 1 measures the memory feature (B10 part C) on
	// the budget tree with perfMemories memories in the tenant: every turn
	// embeds its message (the fake Embedder) and ranks the candidates.
	envPerfMemory = "TANGENT_PERF_MEMORY"
	perfMemories  = 1000
)

// perfMemoryWords make the seeded memories' texts differ.
var perfMemoryWords = []string{"nas", "zfs", "router", "backup", "vpn", "debian", "proxmox", "docker", "ups", "dns",
	"fans", "disks", "mirror", "raidz", "firmware", "photos", "immich", "power", "xeon", "rack", "look", "plan", "conversation", "fine"}

// TestPerf_MemoryRecallWithinBudget alternates the same turns on an
// engine without memory and one with it (same database, same tree), so the
// difference is the recall: one embedding and a ranked scan of the tenant's
// active memories of the Embedder's size.
func TestPerf_MemoryRecallWithinBudget(t *testing.T) {
	if os.Getenv(envPerfMemory) != "1" {
		t.Skip("set " + envPerfMemory + "=1")
	}
	pool := tangenttest.OpenFeatures(t, tangent.FeatureMemory)
	quiet := tangent.WithLogger(slog.New(slog.DiscardHandler))
	plain, err := tangent.New(pool, quiet, tangent.WithFeatures(tangent.AllFeatures()...))
	if err != nil {
		t.Fatal(err)
	}
	withMemory, err := tangent.New(pool, quiet, tangent.WithFeatures(append(tangent.AllFeatures(), tangent.Memory(tangent.ModeSuggest, tangent.MemoryConfig{Embedder: fake.NewEmbedder(0)}))...))
	if err != nil {
		t.Fatal(err)
	}
	withMemory.SetJobDispatcher(&recordingDispatcher{})
	e := &env{t: t, ctx: tangenttest.Context(t), pool: pool, engine: plain}
	tree := e.seedTree(1, 200)
	seedMemories(t, e, withMemory)
	timed := map[string]*timings{}
	for _, name := range []string{"BeginTurn", "BeginTurn+memory", "CompleteTurn", "CompleteTurn+memory", "PreviewTurn", "PreviewTurn+memory", "SearchMemories"} {
		timed[name] = &timings{}
	}
	for i := range perfIterations {
		for _, run := range []struct {
			engine *tangent.Engine
			suffix string
		}{{plain, ""}, {withMemory, "+memory"}} {
			perfTurn(t, run.engine, tree.MainID, timed["BeginTurn"+run.suffix], timed["CompleteTurn"+run.suffix], timed["PreviewTurn"+run.suffix], run.suffix != "")
		}
		timed["SearchMemories"].timed(t, func() error {
			_, err := withMemory.SearchMemories(e.ctx, perfScope, tangent.MemorySearch{Query: fmt.Sprintf("which %s for the %s?", perfMemoryWords[i%len(perfMemoryWords)], perfMemoryWords[(i+5)%len(perfMemoryWords)])})
			return err
		})
	}
	for _, name := range []string{"BeginTurn", "BeginTurn+memory"} {
		timed[name].report(t, name, 60*time.Millisecond)
	}
	for _, name := range []string{"CompleteTurn", "CompleteTurn+memory"} {
		timed[name].report(t, name, 30*time.Millisecond)
	}
	for _, name := range []string{"PreviewTurn", "PreviewTurn+memory", "SearchMemories"} {
		timed[name].report(t, name, 0)
	}
}

// seedMemories writes perfMemories memories of mixed words to the perf tenant.
func seedMemories(t *testing.T, e *env, engine *tangent.Engine) {
	t.Helper()
	kinds := []string{domain.MemoryFact, domain.MemoryDecision, domain.MemoryPreference, domain.MemoryLesson}
	n := len(perfMemoryWords)
	for i := range perfMemories {
		text := fmt.Sprintf("Memory %d: the %s uses %s with %s", i, perfMemoryWords[i%n], perfMemoryWords[(i/n)%n], perfMemoryWords[(i*7)%n])
		in := domain.MemoryInput{Kind: kinds[i%len(kinds)], Text: text, Importance: 1 + i%10}
		if _, err := engine.CreateMemory(e.ctx, perfScope, tangent.MemoryCreate{Memory: in}); err != nil {
			t.Fatal(err)
		}
	}
}

// perfTurn times one turn and one preview on the main line; with memory,
// the preview must have recalled something.
func perfTurn(t *testing.T, engine *tangent.Engine, lineID string, begin, complete, preview *timings, wantMemories bool) {
	ctx := tangenttest.Context(t)
	var turn tangent.Turn
	begin.timed(t, func() (err error) {
		turn, err = engine.BeginTurn(ctx, perfScope, lineID, tangent.TurnInput{Content: "how does this plan look now?"})
		return err
	})
	complete.timed(t, func() error {
		_, err := engine.CompleteTurn(ctx, turn.ID, tangent.TurnResult{Content: "it looks fine"})
		return err
	})
	preview.timed(t, func() error {
		p, err := engine.PreviewTurn(ctx, perfScope, lineID, "does the plan look fine?")
		if err == nil && wantMemories && len(p.Memories) == 0 {
			err = fmt.Errorf("no memory recalled")
		}
		return err
	})
}
