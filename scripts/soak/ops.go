package main

import (
	"context"
	"math/rand/v2"
	"slices"
)

// features are the server's features as /capabilities reports them for
// the driver's token: name -> mode ("on" for a feature without modes).
type features map[string]string

func (f features) on(name string) bool { _, ok := f[name]; return ok }

// readFeatures asks /capabilities which features are on.
func readFeatures(ctx context.Context, c *client) (features, error) {
	var caps struct {
		Features []struct {
			Name    string `json:"name"`
			Enabled bool   `json:"enabled"`
			Mode    string `json:"mode"`
		} `json:"features"`
	}
	if err := c.call(ctx, "GET", "/capabilities", nil, &caps); err != nil {
		return nil, err
	}
	out := features{}
	for _, f := range caps.Features {
		if f.Enabled {
			out[f.Name] = cmpOr(f.Mode, "on")
		}
	}
	return out, nil
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// operation is one weighted action of a worker; needs are the features it
// requires (all of them on).
type operation struct {
	name   string
	weight int
	needs  []string
	run    func(w *worker, ctx context.Context, t *tree, line string)
}

// allOperations is everything a worker does, with its weight. The core
// operations (B5) come first; P1–P3 ones run when their features are on.
var allOperations = []operation{
	{name: "turn", weight: 30, run: func(w *worker, ctx context.Context, _ *tree, line string) { w.turn(ctx, line) }},
	{name: "open branch", weight: 10, run: (*worker).openBranch},
	{name: "merge", weight: 6, run: func(w *worker, ctx context.Context, t *tree, _ string) { w.endBranch(ctx, t, "merge") }},
	{name: "discard", weight: 3, run: func(w *worker, ctx context.Context, t *tree, _ string) { w.endBranch(ctx, t, "discard") }},
	{name: "promote", weight: 2, run: func(w *worker, ctx context.Context, t *tree, _ string) { w.endBranch(ctx, t, "promote") }},
	{name: "move", weight: 2, run: (*worker).move},
	{name: "double send", weight: 3, run: func(w *worker, ctx context.Context, _ *tree, line string) { w.doubleSend(ctx, line) }},
	{name: "search", weight: 4, needs: []string{"search"}, run: func(w *worker, ctx context.Context, _ *tree, _ string) { w.search(ctx) }},
	{name: "side call", weight: 12, run: (*worker).sideCall},
	// P1
	{name: "inbox", weight: 6, needs: []string{"suggestions"}, run: (*worker).inbox},
	{name: "leaf", weight: 3, needs: []string{"leaf"}, run: (*worker).leaf},
	{name: "seeds", weight: 3, needs: []string{"parking"}, run: (*worker).seeds},
	{name: "spinoff", weight: 2, needs: []string{"spinoff"}, run: (*worker).spinoff},
	{name: "deep dive", weight: 2, needs: []string{"rebalance"}, run: (*worker).deepDive},
	// P2
	{name: "goal", weight: 2, needs: []string{"goal"}, run: (*worker).goal},
	{name: "relations", weight: 2, needs: []string{"relations"}, run: (*worker).relations},
	{name: "open loops", weight: 1, needs: []string{"open_loops"}, run: (*worker).openLoops},
	{name: "groups", weight: 2, needs: []string{"group"}, run: (*worker).groups},
	{name: "combine", weight: 2, needs: []string{"group"}, run: (*worker).combine},
	{name: "pins", weight: 1, run: (*worker).pins},
	// P3
	{name: "tags", weight: 3, needs: []string{"ibis"}, run: (*worker).tags},
	{name: "folds", weight: 3, needs: []string{"fold"}, run: (*worker).folds},
	{name: "diverge", weight: 2, needs: []string{"diverge"}, run: (*worker).divergeConvergeDecide},
	{name: "memories", weight: 3, needs: []string{"memory"}, run: (*worker).memories},
}

// operationsFor keeps the operations whose features are on.
func operationsFor(f features) []operation {
	var out []operation
	for _, op := range allOperations {
		if !slices.ContainsFunc(op.needs, func(n string) bool { return !f.on(n) }) {
			out = append(out, op)
		}
	}
	return out
}

// pickOperation draws one operation by weight.
func pickOperation(ops []operation, rng *rand.Rand) operation {
	total := 0
	for _, op := range ops {
		total += op.weight
	}
	roll := rng.IntN(total)
	for _, op := range ops {
		if roll < op.weight {
			return op
		}
		roll -= op.weight
	}
	return ops[len(ops)-1]
}
