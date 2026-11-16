package tangent_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// divergeEnv is an engine with notes, leaf and diverge in mode.
func divergeEnv(t *testing.T, opts ...tangent.Option) *env {
	t.Helper()
	return newEnvWith(t, []tangent.Feature{tangent.Notes(), tangent.Leaf(tangent.ModeManual), tangent.Diverge(tangent.ModeManual)}, opts...)
}

func directions(purposes ...string) string {
	items := []string{}
	for _, p := range purposes {
		items = append(items, fmt.Sprintf(`{"purpose":%q,"why":"because %s"}`, p, p))
	}
	return domain.DivergeMarker + `{"directions":[` + strings.Join(items, ",") + `]}`
}

func TestDiverge_NeedsLeaf(t *testing.T) {
	if _, err := tangent.New(tangenttest.Open(t), tangent.WithFeatures(tangent.Diverge(tangent.ModeManual))); err == nil || !strings.Contains(err.Error(), "leaf") {
		t.Fatalf("diverge needs leaf: %v", err)
	}
}

func TestDiverge_AJobOpensTheSiblingBranches(t *testing.T) {
	e := divergeEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "Implement a linked list three ways", "Which ways?")
	if _, err := e.engine.StartDiverge(e.ctx, scopeA, main.ID, tangent.DivergeInput{AnchorMessageID: anchor.Message.ID, Count: 6}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("count: %v", err)
	}
	if _, err := e.engine.StartDiverge(e.ctx, scopeA, main.ID, tangent.DivergeInput{AnchorMessageID: main.ID, Count: 3}); domain.CodeOf(err) != domain.CodeAnchorNotFound {
		t.Fatalf("anchor: %v", err)
	}
	e.rollsBack("diverge", func(opt tangent.TxOption) error {
		_, err := e.engine.StartDiverge(e.ctx, scopeA, main.ID, tangent.DivergeInput{AnchorMessageID: anchor.Message.ID, Count: 3}, opt)
		return err
	})
	job, err := e.engine.StartDiverge(e.ctx, scopeA, main.ID, tangent.DivergeInput{AnchorMessageID: anchor.Message.ID, Count: 3})
	if err != nil || job.Kind != tangent.JobKindDiverge || !strings.Contains(job.Prompt.UserMessage, "exactly 3") || !strings.Contains(job.Prompt.UserMessage, "> agent: Which ways?") {
		t.Fatalf("job = %+v %v", job, err)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, job.ID, directions("Box", "Rc<RefCell>", "arena"), nil); err != nil {
		t.Fatal(err)
	}
	if got := e.events.OfType(tangent.EventBranchChanged); len(got) != 3 {
		t.Fatalf("events = %v", e.events.Types())
	}
	views, _ := e.engine.ListBranches(e.ctx, scopeA, main.ID, false)
	if len(views) != 3 {
		t.Fatalf("views = %+v", views)
	}
	for _, v := range views {
		if v.Origin != domain.BranchOriginDiverge || v.Kind != domain.BranchKindAlternative || v.AnchorMessageID != anchor.Message.ID {
			t.Fatalf("view = %+v", v)
		}
	}
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, e.byPurpose(main.ID, "arena")[0])
	if pack := detail.Pack.Rendered; !strings.Contains(pack, "## Direction") || !strings.Contains(pack, "> Why: because arena") || !strings.Contains(pack, "> Box") {
		t.Fatalf("the pack names the direction and its siblings:\n%s", pack)
	}
}

func TestDiverge_ARefusedOrUnusableJobPublishesJobFailed(t *testing.T) {
	e := divergeEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	for i := range 6 {
		e.branch(main.ID, anchor.Message.ID, fmt.Sprintf("open %d", i))
	}
	job, err := e.engine.StartDiverge(e.ctx, scopeA, main.ID, tangent.DivergeInput{AnchorMessageID: anchor.Message.ID, Count: 2})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.StartDiverge(e.ctx, scopeA, main.ID, tangent.DivergeInput{AnchorMessageID: anchor.Message.ID, Count: 3}); domain.CodeOf(err) != domain.CodeBranchLimit {
		t.Fatalf("no room for three more: %v", err)
	}
	e.branch(main.ID, anchor.Message.ID, "one more")
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, job.ID, directions("x", "y"), nil); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventJobFailed)
	failed := e.events.OfType(tangent.EventJobFailed)[0].Data.(tangent.JobFailed)
	if failed.Kind != tangent.JobKindDiverge || failed.Error.Code != domain.JobErrorFailed || !strings.Contains(failed.Error.Message, "too many open branches") {
		t.Fatalf("job.failed = %+v", failed)
	}
	if n := e.count(`SELECT count(*) FROM tangent_branch WHERE origin = 'diverge'`); n != 0 {
		t.Fatalf("%d branches of a refused diverge", n)
	}
	other := e.mainLine()
	at := e.turn(other.ID, "q", "a")
	unusable, _ := e.engine.StartDiverge(e.ctx, scopeA, other.ID, tangent.DivergeInput{AnchorMessageID: at.Message.ID, Count: 2})
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, unusable.ID, directions("only one"), nil); err != nil {
		t.Fatal(err)
	}
	if got := e.events.OfType(tangent.EventJobFailed); len(got) != 1 || got[0].Data.(tangent.JobFailed).Error.Code != domain.JobErrorUnusable {
		t.Fatalf("events = %v", e.events.Types())
	}
}

// diverged opens two diverged branches with an exchange each.
func (e *env) diverged(main domain.LineView) []string {
	e.t.Helper()
	anchor := e.turn(main.ID, "Which list?", "Pick one")
	job, err := e.engine.StartDiverge(e.ctx, scopeA, main.ID, tangent.DivergeInput{AnchorMessageID: anchor.Message.ID, Count: 2})
	if err != nil {
		e.t.Fatal(err)
	}
	if err := e.engine.FinishJob(e.ctx, job.ID, directions("Box", "arena"), nil); err != nil {
		e.t.Fatal(err)
	}
	return e.byPurpose(main.ID, "Box", "arena")
}

// byPurpose are the ids of the line's branches with the purposes, in that
// order (branches opened in one transaction share their creation time), each
// given an exchange.
func (e *env) byPurpose(lineID string, purposes ...string) []string {
	e.t.Helper()
	views, _ := e.engine.ListBranches(e.ctx, scopeA, lineID, false)
	ids := []string{}
	for _, p := range purposes {
		for _, v := range views {
			if v.Purpose == p {
				e.turn(v.LineID, "how about "+v.Purpose, "it works")
				ids = append(ids, v.LineID)
			}
		}
	}
	if len(ids) != len(purposes) {
		e.t.Fatalf("branches %+v", views)
	}
	return ids
}

const convergeReply = domain.ConvergeMarker + `{"criteria":["Speed"],"scores":[{"criterion":"Speed","option":"O1","score":2,"why":"allocs"},` +
	`{"criterion":"Speed","option":"O2","score":5,"why":"cache"}],"recommendation":{"option":"O2","reason":"arena is fastest"}}`

func TestConverge_CompareThenDecideInOneGo(t *testing.T) {
	e := divergeEnv(t)
	main := e.mainLine()
	ids := e.diverged(main)
	e.rollsBack("converge", func(opt tangent.TxOption) error {
		_, err := e.engine.Converge(e.ctx, scopeA, main.ID, tangent.ConvergeInput{LineIDs: ids}, opt)
		return err
	})
	e.events.Reset()
	started, err := e.engine.Converge(e.ctx, scopeA, main.ID, tangent.ConvergeInput{LineIDs: ids, Criteria: []string{"Speed"}})
	if err != nil || started.Comparison.Status != domain.ComparisonDrafting || started.Job.Kind != tangent.JobKindConverge ||
		!strings.Contains(started.Job.Prompt.UserMessage, "### O1: Box") || !strings.Contains(started.Job.Prompt.UserMessage, "> operator: how about arena") {
		t.Fatalf("started = %+v %v", started, err)
	}
	e.wantTypes(tangent.EventComparisonChanged)
	if _, err := e.engine.DecideComparison(e.ctx, scopeA, started.Comparison.ID, tangent.DecideInput{LineID: ids[1]}); domain.CodeOf(err) != domain.CodeComparisonNotReady {
		t.Fatalf("not ready: %v", err)
	}
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, started.Job.ID, convergeReply, nil); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventComparisonChanged)
	ready, _ := e.engine.GetComparison(e.ctx, scopeA, started.Comparison.ID)
	if ready.Status != domain.ComparisonReady || ready.Matrix.Recommendation.LineID != ids[1] || ready.Matrix.Scores[0][1].Score != 5 || ready.RootLineID != main.ID {
		t.Fatalf("ready = %+v", ready)
	}
	e.rollsBack("decide", func(opt tangent.TxOption) error {
		_, err := e.engine.DecideComparison(e.ctx, scopeA, ready.ID, tangent.DecideInput{LineID: ids[1]}, opt)
		return err
	})
	decided, err := e.engine.DecideComparison(e.ctx, scopeA, ready.ID, tangent.DecideInput{LineID: ids[1]})
	if err != nil || decided.Comparison.Status != domain.ComparisonDecided || decided.Decision.Kind != domain.LeafKindDecision || decided.Decision.Line != "arena is fastest" ||
		len(decided.Discarded) != 1 || decided.Discarded[0].LineID != ids[0] || decided.Discarded[0].Leaf.Kind != domain.LeafKindDeadEnd || decided.Chosen.Status != domain.BranchStatusOpen {
		t.Fatalf("decided = %+v %v", decided, err)
	}
	e.wantTypes(tangent.EventBranchChanged, tangent.EventLineUpdated, tangent.EventLeafChanged, tangent.EventLeafChanged, tangent.EventComparisonChanged)
	leaf, _ := e.engine.GetLeaf(e.ctx, scopeA, ids[0])
	if leaf.Line != "沒選：改走「arena」" || !strings.Contains(leaf.Body, "Speed: 2/5") {
		t.Fatalf("dead end = %+v", leaf)
	}
	list, _ := e.engine.ListComparisons(e.ctx, scopeA, main.ID)
	if len(list.Comparisons) != 1 || list.Comparisons[0].DecidedLineID != ids[1] {
		t.Fatalf("list = %+v", list)
	}
}

func TestConverge_TheOperatorsLineAndAFailedJob(t *testing.T) {
	e := divergeEnv(t)
	main := e.mainLine()
	ids := e.diverged(main)
	failing, _ := e.engine.Converge(e.ctx, scopeA, main.ID, tangent.ConvergeInput{LineIDs: ids})
	e.events.Reset()
	if err := e.engine.FinishJob(e.ctx, failing.Job.ID, "", fmt.Errorf("down")); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventComparisonChanged, tangent.EventJobFailed)
	timed, _ := e.engine.Converge(e.ctx, scopeA, main.ID, tangent.ConvergeInput{LineIDs: ids})
	e.exec(`UPDATE tangent_job SET created_at = now() - interval '1 hour' WHERE id = $1`, timed.Job.ID)
	e.events.Reset()
	if _, err := e.engine.FailStaleJobs(e.ctx); err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventComparisonChanged, tangent.EventJobFailed)
	again, _ := e.engine.Converge(e.ctx, scopeA, main.ID, tangent.ConvergeInput{LineIDs: ids})
	if err := e.engine.FinishJob(e.ctx, again.Job.ID, convergeReply, nil); err != nil {
		t.Fatal(err)
	}
	decided, err := e.engine.DecideComparison(e.ctx, scopeA, again.Comparison.ID, tangent.DecideInput{LineID: ids[0], Line: "Box after all"})
	if err != nil || decided.Decision.Line != "Box after all" {
		t.Fatalf("decided = %+v %v", decided, err)
	}
	if _, err := e.engine.DecideComparison(e.ctx, scopeA, again.Comparison.ID, tangent.DecideInput{LineID: ids[0]}); domain.CodeOf(err) != domain.CodeComparisonDecided {
		t.Fatalf("twice: %v", err)
	}
	if _, err := e.engine.GetComparison(e.ctx, scopeB, again.Comparison.ID); domain.CodeOf(err) != domain.CodeComparisonNotFound {
		t.Fatalf("another tenant: %v", err)
	}
	raw, _ := json.Marshal(decided.Comparison)
	if !strings.Contains(string(raw), `"decidedLineId"`) {
		t.Fatalf("json = %s", raw)
	}
}

func TestDiverge_OffRefusesEverything(t *testing.T) {
	policy := &switchPolicy{off: map[string]bool{}}
	e := divergeEnv(t, tangent.WithFeaturePolicy(policy))
	main := e.mainLine()
	ids := e.diverged(main)
	policy.set(tangent.FeatureDiverge, true)
	if _, err := e.engine.Converge(e.ctx, scopeA, main.ID, tangent.ConvergeInput{LineIDs: ids}); domain.CodeOf(err) != domain.CodeFeatureDisabled {
		t.Fatalf("off: %v", err)
	}
	if _, err := e.engine.ListComparisons(e.ctx, scopeA, main.ID); domain.CodeOf(err) != domain.CodeFeatureDisabled {
		t.Fatalf("off: %v", err)
	}
}

func TestDecide_TheDeadEndTextFollowsTheServerLanguage(t *testing.T) {
	e := divergeEnv(t, tangent.WithLeafTexts(domain.EnglishLeafTexts()))
	main := e.mainLine()
	ids := e.diverged(main)
	started, _ := e.engine.Converge(e.ctx, scopeA, main.ID, tangent.ConvergeInput{LineIDs: ids})
	if err := e.engine.FinishJob(e.ctx, started.Job.ID, convergeReply, nil); err != nil {
		t.Fatal(err)
	}
	decided, err := e.engine.DecideComparison(e.ctx, scopeA, started.Comparison.ID, tangent.DecideInput{LineID: ids[1]})
	if err != nil || decided.DeadEnds[0].Line != "Not chosen: went with arena" {
		t.Fatalf("decided = %+v %v", decided, err)
	}
}
