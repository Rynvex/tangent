package seed_test

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
	"github.com/Rynvex/tangent/tangenttest/seed"
)

func TestWrite_TheBudgetTreeKeepsTheInvariants(t *testing.T) {
	pool := tangenttest.Open(t)
	ctx := tangenttest.Context(t)
	started := time.Now()
	tree, err := seed.Write(ctx, pool, seed.Config{Tenant: "perf", Seed: 7})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("seeded 2,000 + %d branches in %v", len(tree.Branches), time.Since(started))
	if len(tree.MainMessages) != 2000 || len(tree.Branches) != 200 || tree.MaxDepth() != 6 || len(tree.Open()) < 30 {
		t.Fatalf("shape: %d messages, %d branches, depth %d, %d open", len(tree.MainMessages), len(tree.Branches), tree.MaxDepth(), len(tree.Open()))
	}
	open := map[string]int{}
	status := map[string]string{tree.MainID: "open"}
	for _, b := range tree.Branches {
		status[b.LineID] = b.Status
		if b.Status == "open" {
			open[b.ParentLineID]++
			if status[b.ParentLineID] != "open" {
				t.Fatalf("an open branch under a %s one", status[b.ParentLineID])
			}
		}
	}
	for parent, n := range open {
		if n > 4 {
			t.Fatalf("%d open branches under %s", n, parent)
		}
	}
	engineWorksOn(t, pool, tree)
}

// engineWorksOn runs an outline, a turn on the main line and on the
// deepest open branch, and a refused branch (the tree is full) on the seed.
func engineWorksOn(t *testing.T, pool *pgxpool.Pool, tree seed.Tree) {
	t.Helper()
	ctx := tangenttest.Context(t)
	engine, err := tangent.New(pool, tangent.WithFeatures(tangent.AllFeatures()...))
	if err != nil {
		t.Fatal(err)
	}
	scope := tangent.Scope{Tenant: "perf"}
	outline, err := engine.ListBranches(ctx, scope, tree.MainID, true)
	if err != nil || len(outline) != 200 {
		t.Fatalf("outline %d, %v", len(outline), err)
	}
	deepest := tree.Open()[0]
	for _, b := range tree.Open() {
		if b.Depth > deepest.Depth {
			deepest = b
		}
	}
	for _, line := range []string{tree.MainID, deepest.LineID} {
		turn, err := engine.BeginTurn(ctx, scope, line, tangent.TurnInput{Content: "how does this look?"})
		if err != nil {
			t.Fatalf("a turn on %s: %v", line, err)
		}
		if _, err := engine.CompleteTurn(ctx, turn.ID, tangent.TurnResult{Content: "fine"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := engine.CreateBranch(ctx, scope, tree.MainID, tangent.BranchInput{AnchorMessageID: tree.MainMessages[1], Purpose: "one more", Kind: domain.BranchKindInvestigate}); domain.CodeOf(err) != domain.CodeTreeLimit {
		t.Fatalf("the tree is full: %v", err)
	}
}

func TestWrite_TheSameSeedGivesTheSameTree(t *testing.T) {
	ctx := tangenttest.Context(t)
	small := seed.Config{Seed: 3, MainMessages: 20, Branches: 12, MaxDepth: 3}
	a, err := seed.Write(ctx, tangenttest.Open(t), small)
	if err != nil {
		t.Fatal(err)
	}
	b, err := seed.Write(ctx, tangenttest.Open(t), small)
	if err != nil {
		t.Fatal(err)
	}
	if a.MainID != b.MainID || len(a.Branches) != len(b.Branches) || a.Branches[11].AnchorMessageID != b.Branches[11].AnchorMessageID || a.MaxDepth() != 3 {
		t.Fatalf("trees differ: %+v vs %+v", a.Branches[11], b.Branches[11])
	}
	other, err := seed.Write(ctx, tangenttest.Open(t), seed.Config{Seed: 4, MainMessages: 20, Branches: 12, MaxDepth: 3})
	if err != nil || other.MainID == a.MainID {
		t.Fatalf("another seed, another tree: %v", err)
	}
	if _, err := seed.Write(ctx, tangenttest.Open(t), seed.Config{MainMessages: 1}); err == nil {
		t.Fatal("a main line of one message is refused")
	}
}
