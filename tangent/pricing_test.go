package tangent_test

import (
	"context"
	"math"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-12 }

func TestPrice_CostChargesEachBucketAtItsRate(t *testing.T) {
	price := tangent.Price{Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 3.75}
	usage := domain.Usage{InputTokens: 1_000_000, OutputTokens: 100_000, CacheReadTokens: 600_000, CacheWriteTokens: 200_000}
	// 200k uncached × 3 + 600k × 0.3 + 200k × 3.75 + 100k × 15, per million.
	want := 0.6 + 0.18 + 0.75 + 1.5
	if got := price.Cost(usage); !near(got, want) {
		t.Fatalf("cost = %v, want %v", got, want)
	}
	plain := tangent.Price{Input: 2, Output: 8}
	if got := plain.Cost(usage); !near(got, 2+0.8) {
		t.Fatalf("without cache rates every input token is charged at the input rate: %v", got)
	}
	odd := domain.Usage{InputTokens: 10, CacheReadTokens: 50}
	if got := price.Cost(odd); got < 0 {
		t.Fatalf("cache buckets larger than the input never go negative: %v", got)
	}
}

func TestPricing_PreviewEstimatesThePromptCostOfKnownModels(t *testing.T) {
	e := newEnv(t, tangent.WithPricing(map[string]tangent.Price{"sonnet": {Input: 3, Output: 15}}))
	line := e.mainLine()
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, line.ID, "how much will this cost?")
	if err != nil {
		t.Fatal(err)
	}
	if preview.EstimatedCostUSD == nil || !near(*preview.EstimatedCostUSD, float64(preview.TotalTokens)*3/1e6) {
		t.Fatalf("estimate = %v for %d tokens", preview.EstimatedCostUSD, preview.TotalTokens)
	}
	other, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Model: "unknown"})
	if err != nil {
		t.Fatal(err)
	}
	unpriced, err := e.engine.PreviewTurn(e.ctx, scopeA, other.ID, "x")
	if err != nil || unpriced.EstimatedCostUSD != nil {
		t.Fatalf("an unpriced model has no estimate: %v %v", unpriced.EstimatedCostUSD, err)
	}
}

func TestPricing_RunTurnPricesUsageTheRunnerDidNotPrice(t *testing.T) {
	e := newEnv(t, tangent.WithPricing(map[string]tangent.Price{"sonnet": {Input: 3, Output: 15}, "haiku": {Input: 1, Output: 5}}))
	line := e.mainLine()
	e.runner.Queue(tangenttest.Reply{Content: "a", Usage: domain.Usage{InputTokens: 1_000_000, OutputTokens: 1_000_000}})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	done, err := e.engine.RunTurn(e.ctx, turn, e.runner)
	if err != nil {
		t.Fatal(err)
	}
	if usage := done.Message.Meta.Usage; usage == nil || !near(usage.CostUSD, 18) {
		t.Fatalf("message usage = %+v", usage)
	}
	if !near(done.Line.Usage.CostUSD, 18) {
		t.Fatalf("line usage = %+v", done.Line.Usage)
	}
	// The model the runner reports wins over the line's hint, and a cost the
	// runner reported is kept as is.
	ran := modelRunner{model: "haiku", usage: domain.Usage{InputTokens: 1_000_000}}
	turn, err = e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q2"})
	if err != nil {
		t.Fatal(err)
	}
	if done, err = e.engine.RunTurn(e.ctx, turn, ran); err != nil || !near(done.Message.Meta.Usage.CostUSD, 1) || done.Message.Meta.Model != "haiku" {
		t.Fatalf("priced by the reported model: %+v %v", done.Message.Meta, err)
	}
	ran = modelRunner{model: "haiku", usage: domain.Usage{InputTokens: 1_000_000, CostUSD: 0.5}}
	turn, _ = e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q3"})
	if done, err = e.engine.RunTurn(e.ctx, turn, ran); err != nil || !near(done.Message.Meta.Usage.CostUSD, 0.5) {
		t.Fatalf("the runner's own cost is kept: %+v %v", done.Message.Meta.Usage, err)
	}
}

func TestFeatureConfigured_ReportsTheFeaturesTheEngineWasBuiltWith(t *testing.T) {
	e := newEnvWith(t, []tangent.Feature{tangent.Notes(), tangent.Summary(tangent.ModeOff)})
	if !e.engine.FeatureConfigured(tangent.FeatureNotes) {
		t.Fatal("notes was enabled")
	}
	for _, name := range []string{tangent.FeatureSummary, tangent.FeatureChapters, "nope"} {
		if e.engine.FeatureConfigured(name) {
			t.Fatalf("%s is not configured", name)
		}
	}
}

// modelRunner answers "ok" and reports the model it ran and its usage.
type modelRunner struct {
	model string
	usage domain.Usage
}

func (r modelRunner) Run(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
	return tangent.RunResult{Content: "ok", Usage: r.usage, Model: r.model}, nil
}
