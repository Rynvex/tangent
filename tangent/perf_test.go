package tangent_test

import (
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest/seed"
)

// The performance budget (BACKEND_PLAN §2) is measured on seeded trees
// (tangenttest/seed): a main line of 2,000 messages and 200 branches down to
// depth 6, in English, Chinese and both mixed.
const (
	perfIterations = 100
	perfEndings    = 30
	perfPromotions = 20
	// envPerfAssert set to 1 fails the test when a p95 is over budget; by
	// default the numbers are only logged (machines differ).
	envPerfAssert = "TANGENT_PERF_ASSERT"
	// envPerfScale set to 1 also measures search over ten trees (34k
	// messages in one tenant), ten times the budget's data.
	envPerfScale = "TANGENT_PERF_SCALE"
	// envPerfP1 set to 1 measures with the P1 features (leaf, parking,
	// spinoff, rebalance and the probe) besides AllFeatures, and also a
	// branch's turns (where rebalance measures its signals).
	envPerfP1 = "TANGENT_PERF_P1"
	// envPerfP2 set to 1 measures with the P2 features of B9 part A as well
	// (goal, relations and group in suggest mode, open loops), with a goal on the
	// budget tree: every prompt carries the goal block and every fourth
	// main-line reply starts a drift check.
	envPerfP2 = "TANGENT_PERF_P2"
	// envPerfP3 set to 1 measures with the P3 features of B10 part A as
	// well (ibis and fold in suggest mode) on top of TANGENT_PERF_P2's, with
	// a fold over the budget tree's oldest messages: every prompt applies it,
	// every turn starts a tagging job and every tenth reply looks for a
	// chapter to fold.
	envPerfP3 = "TANGENT_PERF_P3"
)

var perfScope = tangent.Scope{Tenant: "perf", Actor: "perf"}

type timings []time.Duration

func (ts timings) percentile(p float64) time.Duration {
	sorted := slices.Clone(ts)
	slices.Sort(sorted)
	return sorted[min(len(sorted)-1, int(float64(len(sorted))*p))]
}

func (ts timings) report(t *testing.T, name string, budget time.Duration) {
	t.Helper()
	p50, p90, p95 := ts.percentile(0.50), ts.percentile(0.90), ts.percentile(0.95)
	round := func(d time.Duration) time.Duration { return d.Round(10 * time.Microsecond) }
	t.Logf("%-22s n=%d p50=%v p90=%v p95=%v budget(p95)=%v", name, len(ts), round(p50), round(p90), round(p95), budget)
	if os.Getenv(envPerfAssert) == "1" && budget > 0 && p95 > budget {
		t.Errorf("%s p95 %v is over the budget %v", name, p95, budget)
	}
}

// timed runs fn and adds its duration.
func (ts *timings) timed(t *testing.T, fn func() error) {
	t.Helper()
	started := time.Now()
	err := fn()
	*ts = append(*ts, time.Since(started))
	if err != nil {
		t.Fatal(err)
	}
}

// perfEnv is the engine the budgets are measured on.
func perfEnv(t *testing.T) *env {
	if os.Getenv(envPerfP3) == "1" {
		return newEnvWith(t, append(p2Features(tangent.ModeSuggest), tangent.Group(tangent.ModeSuggest), tangent.Ibis(tangent.ModeSuggest), tangent.Fold(tangent.ModeSuggest)))
	}
	if os.Getenv(envPerfP2) == "1" {
		return newEnvWith(t, append(p2Features(tangent.ModeSuggest), tangent.Group(tangent.ModeSuggest)))
	}
	if os.Getenv(envPerfP1) == "1" {
		return newEnvWith(t, p1bFeatures())
	}
	return newEnv(t)
}

// seedTree writes one budget tree for the perf scope.
func (e *env) seedTree(seedValue uint64, branches int) seed.Tree {
	e.t.Helper()
	tree, err := seed.Write(e.ctx, e.pool, seed.Config{Tenant: perfScope.Tenant, Seed: seedValue, Branches: branches})
	if err != nil {
		e.t.Fatal(err)
	}
	return tree
}

func TestPerf_TurnProtocolAndOutlineWithinBudget(t *testing.T) {
	e := perfEnv(t)
	tree := e.seedTree(1, 200)
	if os.Getenv(envPerfP2) == "1" || os.Getenv(envPerfP3) == "1" {
		if _, err := e.engine.PutGoal(e.ctx, perfScope, tree.MainID, "Decide how the conversation's plan should look"); err != nil {
			t.Fatal(err)
		}
	}
	if os.Getenv(envPerfP3) == "1" {
		e.perfFold(tree)
	}
	var begin, complete, list, preview timings
	for range perfIterations {
		var turn tangent.Turn
		begin.timed(t, func() (err error) {
			turn, err = e.engine.BeginTurn(e.ctx, perfScope, tree.MainID, tangent.TurnInput{Content: "how does this look now?"})
			return err
		})
		if len(turn.Prompt.History) == 0 && turn.Prompt.Earlier == "" {
			t.Fatal("the prompt must carry history")
		}
		complete.timed(t, func() error {
			_, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "it looks fine"})
			return err
		})
		list.timed(t, func() error {
			views, err := e.engine.ListBranches(e.ctx, perfScope, tree.MainID, true)
			if err == nil && len(views) != 200 {
				err = fmt.Errorf("outline of %d", len(views))
			}
			return err
		})
		preview.timed(t, func() error {
			_, err := e.engine.PreviewTurn(e.ctx, perfScope, tree.MainID, "next")
			return err
		})
	}
	begin.report(t, "BeginTurn", 60*time.Millisecond)
	complete.report(t, "CompleteTurn", 30*time.Millisecond)
	list.report(t, "ListBranches", 30*time.Millisecond)
	preview.report(t, "PreviewTurn", 0)
}

func TestPerf_MergeAndMoveWithinBudget(t *testing.T) {
	e := perfEnv(t)
	tree := e.seedTree(2, 200)
	open := tree.Open()
	if len(open) < perfEndings {
		t.Fatalf("only %d open branches", len(open))
	}
	// Deepest first: merging a branch before its open children would close
	// their parent.
	slices.SortStableFunc(open, func(a, b seed.Branch) int { return b.Depth - a.Depth })
	var merge timings
	for _, b := range open[:perfEndings] {
		detail, err := e.engine.GetBranch(e.ctx, perfScope, b.LineID)
		if err != nil {
			t.Fatal(err)
		}
		merge.timed(t, func() error {
			_, err := e.engine.MergeBranch(e.ctx, perfScope, b.LineID, tangent.MergeInput{
				Card: domain.BranchCard{Question: "What did it settle?", Conclusion: "It settled the question."}, ParentTipMessageID: detail.ParentTipMessageID,
			})
			return err
		})
	}
	merge.report(t, "MergeBranch", 80*time.Millisecond)

	moving := e.seedTree(3, 200-perfEndings) // every move adds a branch; the last one makes 200
	var move timings
	for range perfEndings {
		turn, err := e.engine.BeginTurn(e.ctx, perfScope, moving.MainID, tangent.TurnInput{Content: "one more exchange to move"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "moved soon"}); err != nil {
			t.Fatal(err)
		}
		var moved tangent.MovedBranch
		move.timed(t, func() (err error) {
			moved, err = e.engine.MoveToBranch(e.ctx, perfScope, moving.MainID, tangent.MoveInput{Count: 2, Purpose: "moved aside"})
			return err
		})
		// Keep the main line under its cap of open branches.
		if _, err := e.engine.DiscardBranch(e.ctx, perfScope, moved.Branch.LineID); err != nil {
			t.Fatal(err)
		}
	}
	move.report(t, "MoveToBranch", 80*time.Millisecond)
}

// tailOf is how many main-line chat messages a promotion of b puts away.
func tailOf(tree seed.Tree, b seed.Branch) int {
	return len(tree.MainMessages) - 1 - slices.Index(tree.MainMessages, b.AnchorMessageID)
}

// promotable is the open top-level branch hanging latest on the main line
// (nothing open hangs on the tail a promotion moves away), when the old
// tail's subtrees can go one level deeper; ok is false otherwise.
func promotable(tree seed.Tree, hardDepth int) (seed.Branch, bool) {
	at := map[string]int{}
	for i, id := range tree.MainMessages {
		at[id] = i
	}
	best := seed.Branch{}
	for _, b := range tree.Open() {
		if b.Depth == 1 && (best.LineID == "" || at[b.AnchorMessageID] > at[best.AnchorMessageID]) {
			best = b
		}
	}
	if best.LineID == "" {
		return best, false
	}
	topOf := map[string]string{}
	deepest := map[string]int{}
	for _, b := range tree.Branches { // creation order: parents before children
		top := b.LineID
		if b.Depth > 1 {
			top = topOf[b.ParentLineID]
		}
		topOf[b.LineID] = top
		deepest[top] = max(deepest[top], b.Depth)
	}
	for _, b := range tree.Branches {
		if b.Depth == 1 && b.LineID != best.LineID && at[b.AnchorMessageID] > at[best.AnchorMessageID] && deepest[b.LineID] >= hardDepth {
			return best, false
		}
	}
	return best, true
}

func TestPerf_PromoteWithinBudget(t *testing.T) {
	e := newEnv(t)
	var promote timings
	var tails []int
	for i := 0; len(promote) < perfPromotions; i++ {
		if i > 10*perfPromotions {
			t.Fatalf("only %d promotable trees in %d seeds", len(promote), i)
		}
		tree := e.seedTree(uint64(100+i), 199) // the promotion adds the previous main line: 200
		branch, ok := promotable(tree, e.engine.Limits().Branch.HardMaxDepth)
		if !ok {
			continue
		}
		tails = append(tails, tailOf(tree, branch))
		promote.timed(t, func() error {
			_, err := e.engine.PromoteBranch(e.ctx, perfScope, branch.LineID)
			return err
		})
	}
	slices.Sort(tails)
	t.Logf("old tails moved (chat messages): min %d, median %d, max %d", tails[0], tails[len(tails)/2], tails[len(tails)-1])
	promote.report(t, "PromoteBranch", 80*time.Millisecond)
}

func TestPerf_SearchWithinBudget(t *testing.T) {
	e := newSearchEnv(t)
	// Common and rare, two characters (no trigram) and longer, in three languages.
	queries := []string{"分岔", "龍貓", "分岔對話", "benchmark", "效能 latency", "deploy", "nowhere to be found"}
	e.seedTree(1, 200)
	e.searchTimings(t, "Search (1 tree)", queries)
	if os.Getenv(envPerfScale) != "1" {
		return
	}
	for i := range 9 {
		e.seedTree(uint64(200+i), 200)
	}
	e.searchTimings(t, "Search (10 trees, info)", queries)
}

// searchTimings searches each query perfIterations/len(queries)*2 times.
func (e *env) searchTimings(t *testing.T, name string, queries []string) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx, "ANALYZE"); err != nil {
		t.Fatal(err)
	}
	var all timings
	for _, q := range queries {
		var one timings
		hits := 0
		for range perfIterations / len(queries) * 2 {
			one.timed(t, func() error {
				found, err := e.engine.Search(e.ctx, perfScope, tangent.SearchInput{Query: q, Limit: 20})
				hits = len(found)
				return err
			})
		}
		one.report(t, fmt.Sprintf("  %q (%d hits)", q, hits), 0)
		all = append(all, one...)
	}
	budget := 80 * time.Millisecond
	if strings.HasSuffix(name, "info)") {
		budget = 0 // ten times the budget's data: recorded, not held to it
	}
	all.report(t, name, budget)
}

// TestPerf_BranchTurnWithRebalance measures CompleteTurn on an open
// top-level branch of the budget tree, where rebalance reads its signals
// after every reply (TANGENT_PERF_P1=1 only).
func TestPerf_BranchTurnWithRebalance(t *testing.T) {
	if os.Getenv(envPerfP1) != "1" && os.Getenv(envPerfP2) != "1" {
		t.Skip("set TANGENT_PERF_P1=1 or TANGENT_PERF_P2=1")
	}
	e := perfEnv(t)
	tree := e.seedTree(1, 200)
	branchID := ""
	for _, b := range tree.Branches {
		if b.Status == domain.BranchStatusOpen && b.ParentLineID == tree.MainID && b.Kind != domain.BranchKindAside {
			branchID = b.LineID
			break
		}
	}
	if branchID == "" {
		t.Fatal("no open top-level branch")
	}
	var complete timings
	for range perfIterations {
		turn, err := e.engine.BeginTurn(e.ctx, perfScope, branchID, tangent.TurnInput{Content: "and here?"})
		if err != nil {
			t.Fatal(err)
		}
		complete.timed(t, func() error {
			_, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "fine"})
			return err
		})
	}
	complete.report(t, "CompleteTurn (branch)", 30*time.Millisecond)
}

// TestPerf_FisheyeWithinBudget measures the fisheye context on the budget
// tree (2,000 main-line messages, 200 branches), with a leaf on every
// ended branch and 20 pinned main-line messages: the selection alone
// (PreviewTurn, which builds the prompt the same way without writing) on
// the main line and on the deepest open branch, and BeginTurn with it.
func TestPerf_FisheyeWithinBudget(t *testing.T) {
	features := fisheyeFeatures()
	if os.Getenv(envPerfP3) == "1" {
		features = append(features, tangent.Fold(tangent.ModeManual))
	}
	e := newEnvWith(t, features)
	tree := e.seedTree(1, 200)
	if os.Getenv(envPerfP3) == "1" {
		e.perfFold(tree)
	}
	e.exec(`INSERT INTO tangent_leaf (line_id, tenant_id, root_line_id, kind, line, status)
		SELECT line_id, tenant_id, root_line_id, (ARRAY['decision','conclusion','answer','dead_end'])[1 + abs(hashtext(line_id::text)) % 4], 'the branch ended', 'confirmed'
		FROM tangent_branch WHERE root_line_id = $1 AND status <> 'open'`, tree.MainID)
	for i := 0; i < len(tree.MainMessages); i += len(tree.MainMessages) / 20 {
		e.exec(`UPDATE tangent_message SET pinned = true WHERE id = $1`, tree.MainMessages[i])
	}
	deep := tree.MainID
	for _, b := range tree.Branches {
		if b.Status == domain.BranchStatusOpen && b.Kind != domain.BranchKindAside && b.Depth >= 2 {
			deep = b.LineID
		}
	}
	var onMain, onBranch, begin timings
	for range perfIterations {
		onMain.timed(t, func() error { return e.fisheyePreview(tree.MainID) })
		onBranch.timed(t, func() error { return e.fisheyePreview(deep) })
		var turn tangent.Turn
		begin.timed(t, func() (err error) {
			turn, err = e.engine.BeginTurn(e.ctx, perfScope, tree.MainID, tangent.TurnInput{Content: "and now?"})
			return err
		})
		if _, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "fine"}); err != nil {
			t.Fatal(err)
		}
	}
	onMain.report(t, "Fisheye (main line)", 40*time.Millisecond)
	onBranch.report(t, "Fisheye (deep branch)", 40*time.Millisecond)
	begin.report(t, "BeginTurn (fisheye)", 60*time.Millisecond)
}

// fisheyePreview previews a turn and checks the fisheye chose it.
func (e *env) fisheyePreview(lineID string) error {
	preview, err := e.engine.PreviewTurn(e.ctx, perfScope, lineID, "next")
	if err == nil && (preview.Fisheye == nil || len(preview.Fisheye.Items) == 0) {
		err = fmt.Errorf("no fisheye items on %s", lineID)
	}
	return err
}

// perfFold folds forty messages of the main line that the history scans.
func (e *env) perfFold(tree seed.Tree) {
	e.t.Helper()
	ids := tree.MainMessages
	from, to := ids[len(ids)-120], ids[len(ids)-81]
	if _, err := e.engine.CreateFold(e.ctx, perfScope, tree.MainID, tangent.FoldInput{FromMessageID: from, ToMessageID: to, Summary: "The middle of the plan, folded."}); err != nil {
		e.t.Fatal(err)
	}
	if preview, err := e.engine.PreviewTurn(e.ctx, perfScope, tree.MainID, "x"); err != nil || len(preview.Folds) != 1 || preview.Folds[0].Messages != 40 {
		e.t.Fatalf("the prompts apply the fold: %+v %v", preview.Folds, err)
	}
}
