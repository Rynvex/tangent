package tangent_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// fisheyeFeatures are the P2 features with the fisheye context.
func fisheyeFeatures() []tangent.Feature {
	return append(p2Features(tangent.ModeManual), tangent.Fisheye())
}

// fisheyeTree is a main line with twelve exchanges (the first reply
// pinned), a merged branch with a decision, a discarded one with a dead
// end, an open one and a branch below the merged one's sibling.
type fisheyeTree struct {
	main, decided, dead, open, deep string
	first                           tangent.CompletedTurn
}

func (e *env) fisheyeTree() fisheyeTree {
	e.t.Helper()
	tree := fisheyeTree{main: e.mainLine().ID}
	tree.first = e.turn(tree.main, "first question", "first answer")
	for i := range 11 {
		e.turn(tree.main, fmt.Sprintf("question %d", i), fmt.Sprintf("answer %d", i))
	}
	if _, err := e.engine.PinMessage(e.ctx, scopeA, tree.first.Message.ID, true); err != nil {
		e.t.Fatal(err)
	}
	decided := e.branch(tree.main, tree.first.Message.ID, "Ryokan or hotel")
	e.turn(decided.Line.ID, "which?", "the ryokan")
	e.mergeWithCard(decided.Line.ID, domain.BranchCard{Question: "Ryokan or hotel?", Conclusion: "Book the ryokan"})
	if _, err := e.engine.PutLeaf(e.ctx, scopeA, decided.Line.ID, domain.LeafInput{Kind: domain.LeafKindDecision, Line: "Book the ryokan"}); err != nil {
		e.t.Fatal(err)
	}
	dead := e.branch(tree.main, tree.first.Message.ID, "Osaka side trip")
	e.turn(dead.Line.ID, "Osaka?", "far")
	if _, err := e.engine.DiscardBranchWith(e.ctx, scopeA, dead.Line.ID, tangent.DiscardInput{Leaf: &domain.LeafInput{Line: "Too far"}}); err != nil {
		e.t.Fatal(err)
	}
	open := e.branch(tree.main, tree.first.Message.ID, "Rail pass")
	reply := e.turn(open.Line.ID, "pass?", "maybe")
	deep := e.branch(open.Line.ID, reply.Message.ID, "Seat reservations")
	tree.decided, tree.dead, tree.open, tree.deep = decided.Line.ID, dead.Line.ID, open.Line.ID, deep.Line.ID
	return tree
}

func itemsByID(p tangent.Preview) map[string]domain.FisheyeItem {
	out := map[string]domain.FisheyeItem{}
	if p.Fisheye != nil {
		for _, item := range p.Fisheye.Items {
			out[item.ID] = item
		}
	}
	return out
}

func TestFisheye_PicksTheHistoryAndTheBranchesConclusions(t *testing.T) {
	e := newEnvWith(t, fisheyeFeatures())
	tree := e.fisheyeTree()
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, tree.main, "next")
	if err != nil {
		t.Fatal(err)
	}
	items := itemsByID(preview)
	if items[tree.first.Message.ID].Level != domain.FisheyeFull || items[tree.first.Message.ID].Score != 100-11 {
		t.Fatalf("the pinned reply stays whole: %+v", items[tree.first.Message.ID])
	}
	if items[tree.decided].Level != domain.FisheyeLeafOnly || items[tree.dead].Level != domain.FisheyeLeafOnly || items[tree.deep].Level != domain.FisheyeHidden {
		t.Fatalf("branches: decided %+v dead %+v deep %+v", items[tree.decided], items[tree.dead], items[tree.deep])
	}
	if items[tree.decided].Score <= items[tree.dead].Score {
		t.Fatal("a decision outranks a dead end at the same distance")
	}
	system, _ := preview.Prompt.Chat()
	if !strings.Contains(system, "## Other branches' conclusions") || !strings.Contains(system, "> [decision] Ryokan or hotel — Book the ryokan") ||
		!strings.Contains(system, "> [dead_end] Osaka side trip — Too far") || !strings.Contains(system, "Earlier in this session") {
		t.Fatalf("system:\n%s", system)
	}
	stable, _, _ := preview.Prompt.ChatBlocks()
	if strings.Contains(stable, "Other branches' conclusions") {
		t.Fatal("the conclusions change as branches end: they are not in the cacheable part")
	}
	if len(preview.Prompt.History) >= 24 || preview.Fisheye.Tokens == 0 {
		t.Fatalf("fewer verbatim messages: %d", len(preview.Prompt.History))
	}
	e.turn(tree.main, "and now?", "ok")
	if !strings.Contains(e.lastSystem(), "Book the ryokan") {
		t.Fatal("a begun turn uses the fisheye too")
	}
}

func TestFisheye_FromABranchSeesItsSiblingsNotItsPath(t *testing.T) {
	e := newEnvWith(t, fisheyeFeatures())
	tree := e.fisheyeTree()
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, tree.deep, "next")
	if err != nil {
		t.Fatal(err)
	}
	items := itemsByID(preview)
	if _, ok := items[tree.open]; ok {
		t.Fatal("the parent is on the path (its pack carries it), not a sibling")
	}
	if items[tree.decided].Level != domain.FisheyeLeafOnly || items[tree.decided].Score != 5-3 {
		t.Fatalf("an uncle three edges away: %+v", items[tree.decided])
	}
	mainPreview, _ := e.engine.PreviewTurn(e.ctx, scopeA, tree.main, "next")
	if _, ok := itemsByID(mainPreview)[tree.main]; ok {
		t.Fatal("the line itself is no item")
	}
}

func TestFisheye_OffLeavesThePromptAsItWas(t *testing.T) {
	e := newEnvWith(t, p2Features(tangent.ModeManual))
	tree := e.fisheyeTree()
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, tree.main, "next")
	if err != nil {
		t.Fatal(err)
	}
	system, _ := preview.Prompt.Chat()
	if preview.Fisheye != nil || strings.Contains(system, "Other branches' conclusions") || len(preview.Prompt.History) != 24 {
		t.Fatalf("fisheye off: %+v, %d messages", preview.Fisheye, len(preview.Prompt.History))
	}
	if _, err := tangent.New(e.pool, tangent.WithFeatures(tangent.Fisheye())); err == nil || !strings.Contains(err.Error(), "leaf") {
		t.Fatalf("fisheye needs leaf: %v", err)
	}
	caps, _ := newEnvWith(t, fisheyeFeatures()).engine.Capabilities(e.ctx, scopeA)
	found := false
	for _, c := range caps {
		found = found || (c.Name == tangent.FeatureFisheye && c.Enabled && c.Mode == "")
	}
	if !found {
		t.Fatalf("capabilities list fisheye: %+v", caps)
	}
}

func TestBudget_TheFeaturesShareOneBudgetAndTheHistoryGetsTheRest(t *testing.T) {
	e := newEnvWith(t, p2Features(tangent.ModeManual))
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	e.engine.PutGoal(e.ctx, scopeA, main.ID, "Plan the trip")
	e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: "add", Section: "fact", Text: "a fact"}})
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	budget := preview.Budget
	shares := map[string]int{}
	for _, share := range budget.Shares {
		shares[share.Owner] = share.Tokens
	}
	if budget.Total != 40000 || shares[tangent.FeatureNotes] == 0 || shares[tangent.FeatureGoal] == 0 || budget.History != 24000 || budget.Used <= shares[tangent.FeatureNotes] {
		t.Fatalf("budget = %+v", budget)
	}
	limits := domain.DefaultLimits()
	limits.Context.TokenBudget = 400
	small := newEnvWith(t, p2Features(tangent.ModeManual), tangent.WithLimits(limits))
	tight := small.mainLine()
	for i := range 6 {
		small.turn(tight.ID, fmt.Sprintf("question %d %s", i, strings.Repeat("words ", 60)), "answer "+strings.Repeat("more ", 60))
	}
	changes := []domain.NoteChange{}
	for i := range 8 {
		changes = append(changes, domain.NoteChange{Op: "add", Section: "fact", Text: fmt.Sprintf("fact %d %s", i, strings.Repeat("detail ", 40))})
	}
	if _, err := small.engine.ApplyNoteChanges(small.ctx, scopeA, tight.ID, changes); err != nil {
		t.Fatal(err)
	}
	p, _ := small.engine.PreviewTurn(small.ctx, scopeA, tight.ID, "next")
	notes := 0
	for _, share := range p.Budget.Shares {
		if share.Owner == tangent.FeatureNotes {
			notes = share.Tokens
		}
	}
	if notes > 400 || p.Budget.History > 400-notes || len(p.Prompt.History) == 0 {
		t.Fatalf("the notes take what is left of 400, the history the rest: %+v, %d messages", p.Budget, len(p.Prompt.History))
	}
}

func TestFisheye_AMessageANoteComesFromReachesFurther(t *testing.T) {
	e := newEnvWith(t, fisheyeFeatures())
	main := e.mainLine()
	replies := []string{}
	for i := range 8 {
		replies = append(replies, e.turn(main.ID, fmt.Sprintf("q%d", i), fmt.Sprintf("a%d", i)).Message.ID)
	}
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: "add", Section: "fact", Text: "from a2", SourceMessageID: replies[2]}}); err != nil {
		t.Fatal(err)
	}
	preview, err := e.engine.PreviewTurn(e.ctx, scopeA, main.ID, "next")
	if err != nil {
		t.Fatal(err)
	}
	items := itemsByID(preview)
	if items[replies[2]].Level != domain.FisheyeFull || items[replies[2]].Score != 4-5 || items[replies[1]].Level != domain.FisheyeSummary {
		t.Fatalf("referenced %+v, not %+v", items[replies[2]], items[replies[1]])
	}
}
