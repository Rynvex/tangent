package tangent_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/store"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// recordingPolicy answers fixed modes and remembers every call.
type recordingPolicy struct {
	mu     sync.Mutex
	modes  map[string]tangent.Mode
	calls  int
	actors []string
}

func (p *recordingPolicy) Mode(_ context.Context, scope tangent.Scope, feature string) tangent.Mode {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	p.actors = append(p.actors, scope.Actor)
	if mode, ok := p.modes[feature]; ok {
		return mode
	}
	return tangent.ModeAuto
}

func (p *recordingPolicy) reset() (int, []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	calls, actors := p.calls, p.actors
	p.calls, p.actors = 0, nil
	return calls, actors
}

// M1: a policy answering out-of-range modes fails closed below, and above
// it cannot widen a configured mode.
func TestPhase2Review_InvalidPolicyModesAreClamped(t *testing.T) {
	policy := &recordingPolicy{modes: map[string]tangent.Mode{tangent.FeatureNotes: tangent.Mode(-1), tangent.FeatureSummary: tangent.Mode(99)}}
	e := newEnv(t, tangent.WithFeaturePolicy(policy))
	caps, err := e.engine.Capabilities(e.ctx, scopeA)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]tangent.Capability{}
	for _, c := range caps {
		got[c.Name] = c
	}
	if got[tangent.FeatureNotes].Enabled || got[tangent.FeatureSummary].Mode != "suggest" {
		t.Fatalf("caps = %+v", caps)
	}
	_, err = e.engine.ListNotes(e.ctx, scopeA, e.mainLine().ID)
	wantCode(t, err, domain.CodeFeatureDisabled)
}

// LOW: a dependent is off while a requirement is off.
func TestPhase2Review_ADependentIsOffWhenItsRequirementIs(t *testing.T) {
	called := false
	base := tangent.StubFeature(tangent.StubSpec{Name: "base"})
	dependent := tangent.StubFeature(tangent.StubSpec{Name: "dependent", Requires: []string{"base"},
		AfterCommit: func(string) []tangent.Event { called = true; return nil }})
	e := newEnvWith(t, []tangent.Feature{base, dependent}, tangent.WithFeaturePolicy(policy{"tenant-a/base": tangent.ModeOff}))
	e.turn(e.mainLine().ID, "q", "a")
	if called {
		t.Fatal("a feature whose requirement the policy switched off must not run")
	}
}

// LOW: the policy is asked once per feature per call, before the
// transaction, with the actor who began the turn (also from another engine).
func TestPhase2Review_ThePolicyIsResolvedOncePerCallWithTheTurnsActor(t *testing.T) {
	policy := &recordingPolicy{}
	e := newEnv(t, tangent.WithFeaturePolicy(policy))
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	policy.reset()
	if _, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "a"}); err != nil {
		t.Fatal(err)
	}
	calls, actors := policy.reset()
	if calls != len(tangent.AllFeatures()) {
		t.Fatalf("policy called %d times for one CompleteTurn", calls)
	}
	for _, actor := range actors {
		if actor != scopeA.Actor {
			t.Fatalf("actors = %v", actors)
		}
	}
	turn, err = e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q2"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := tangent.New(e.pool, tangent.WithFeatures(tangent.AllFeatures()...), tangent.WithFeaturePolicy(policy))
	if err != nil {
		t.Fatal(err)
	}
	policy.reset()
	if _, err := other.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "a"}); err != nil {
		t.Fatal(err)
	}
	if _, actors := policy.reset(); len(actors) == 0 || actors[0] != scopeA.Actor {
		t.Fatalf("another engine must read the actor from the turn: %v", actors)
	}
}

// M2: no summary job (or SummaryDue) after a failed turn; jobs started
// while a turn is failed are still dispatched.
func TestPhase2Review_FailedTurnsStartNoSummaryAndKeepTheirJobs(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.History.SummaryTriggerTokens = 5
	e := newEnvWith(t, append(without(tangent.FeatureSummary), tangent.Summary(tangent.ModeAuto)), tangent.WithLimits(limits))
	main := e.mainLine()
	e.turn(main.ID, "a fairly long question here", "a fairly long answer here")
	e.runner.Queue(tangenttest.Reply{Err: tangenttest.ErrFake})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "fails"})
	if err != nil {
		t.Fatal(err)
	}
	// The first turn's auto summary is pending; drop it so only the failure decides.
	e.exec(`UPDATE tangent_job SET status = 'superseded'`)
	failed, err := e.engine.RunTurn(e.ctx, turn, e.runner)
	if err != nil || len(failed.Jobs) != 0 || failed.SummaryDue {
		t.Fatalf("a failed turn started %+v (due %v), %v", failed.Jobs, failed.SummaryDue, err)
	}
}

// recordingDispatcher remembers the jobs it was given.
type recordingDispatcher struct {
	mu   sync.Mutex
	jobs []tangent.Job
}

func (d *recordingDispatcher) DispatchTurn(context.Context, tangent.Turn) error { return nil }
func (d *recordingDispatcher) DispatchJob(_ context.Context, j tangent.Job) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.jobs = append(d.jobs, j)
	return nil
}

func TestPhase2Review_JobsOfATurnFailedInBeginTurnGoToTheJobDispatcher(t *testing.T) {
	probe := tangent.StubFeature(tangent.StubSpec{Name: "probe", Jobs: func(kind string) []tangent.Job {
		return []tangent.Job{{ID: "job-for-" + kind, Kind: "probe_job"}}
	}})
	contributor := contributorFunc(func(context.Context, tangent.Scope, domain.LineView) ([]domain.PromptSection, error) {
		return nil, errors.New("contributor down")
	})
	e := newEnvWith(t, []tangent.Feature{probe}, tangent.WithPromptContributor(contributor))
	sink := &recordingDispatcher{}
	e.engine.SetJobDispatcher(sink)
	if _, err := e.engine.BeginTurn(e.ctx, scopeA, e.mainLine().ID, tangent.TurnInput{Content: "q"}); err == nil {
		t.Fatal("the turn must fail")
	}
	if len(sink.jobs) != 1 || sink.jobs[0].ID != "job-for-turn_completed" {
		t.Fatalf("jobs = %+v", sink.jobs)
	}
}

// M3: an aside ended by its answer runs OnBranchClosed and AfterCommit for
// the closed branch.
func TestPhase2Review_AnAnsweredAsideRunsTheBranchClosedHooks(t *testing.T) {
	var closedInTx []string
	probe := tangent.StubFeature(tangent.StubSpec{
		Name:           "probe",
		OnBranchClosed: func(context.Context, store.Tx) error { closedInTx = append(closedInTx, "closed"); return nil },
		AfterCommit:    func(kind string) []tangent.Event { return []tangent.Event{{Type: "probe." + kind}} },
	})
	e := newEnvWith(t, []tangent.Feature{tangent.Aside(), probe})
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	aside, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Purpose: "quick", Kind: domain.BranchKindAside})
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	e.turn(aside.Line.ID, "2+2?", "4")
	if len(closedInTx) != 1 || len(e.events.OfType("probe."+"branch_closed")) != 1 {
		t.Fatalf("in tx %v, events %v", closedInTx, e.events.Types())
	}
}

// M4: a feature hook that refuses every completion does not keep the turn
// pending: the turn fails at once without the hooks.
func TestPhase2Review_ARefusingTurnHookFailsTheTurnAtOnce(t *testing.T) {
	probe := tangent.StubFeature(tangent.StubSpec{Name: "probe", OnTurnCompleted: func(context.Context, store.Tx) error { return errHook }})
	e := newEnvWith(t, []tangent.Feature{probe})
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	done, err := e.engine.RunTurn(e.ctx, turn, e.runner)
	if !errors.Is(err, errHook) || done.Line.Status != domain.LineStatusError || done.Message.Content != "Turn failed: the reply could not be recorded" {
		t.Fatalf("done = %+v, %v", done.Message, err)
	}
	if e.count(`SELECT count(*) FROM tangent_message WHERE status = 'pending'`) != 0 {
		t.Fatal("the turn must not stay pending")
	}
}

// M5: notes off records no notes revision as sent, so turning notes back on
// resends them.
func TestPhase2Review_NotesOffRecordsNoRevisionSent(t *testing.T) {
	off := newEnvWith(t, without(tangent.FeatureNotes))
	main := off.mainLine()
	if _, err := off.rawStore().ApplyNoteChanges(off.ctx, store.ApplyNotesInput{Tenant: scopeA.Tenant, LineID: main.ID, Changes: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "x"}}}); err != nil {
		t.Fatal(err)
	}
	off.turn(main.ID, "q", "a")
	on, err := tangent.New(off.pool, tangent.WithFeatures(tangent.AllFeatures()...))
	if err != nil {
		t.Fatal(err)
	}
	turn, err := on.BeginTurn(off.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q2"})
	if err != nil || !turn.Prompt.NotesChanged {
		t.Fatalf("notes turned back on must count as changed: %v %v", turn.Prompt.NotesChanged, err)
	}
	if _, err := on.CompleteTurn(off.ctx, turn.ID, tangent.TurnResult{Content: "a2"}); err != nil {
		t.Fatal(err)
	}
	if off.count(`SELECT notes_revision_sent FROM tangent_line WHERE id = $1`, main.ID) != 1 {
		t.Fatal("with notes on the revision is recorded")
	}
}

// M6: a hook that writes, then a later hook that fails: everything rolls
// back, nothing is published; for creating and for merging a branch (the
// card and the notes stay unwritten).
func TestPhase2Review_AFailingLaterHookRollsBackEarlierHookWrites(t *testing.T) {
	writer := func(ctx context.Context, tx store.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE tangent_line SET title = 'written by a hook'`)
		return err
	}
	failing := func(context.Context, store.Tx) error { return errHook }
	features := append(tangent.AllFeatures(),
		tangent.StubFeature(tangent.StubSpec{Name: "writer", OnBranchCreated: writer, OnBranchClosed: writer}),
		tangent.StubFeature(tangent.StubSpec{Name: "failing", OnBranchCreated: failing, OnBranchClosed: failing}),
	)
	plain := newEnv(t)
	main := plain.mainLine()
	anchor := plain.turn(main.ID, "q", "a")
	branch := plain.branch(main.ID, anchor.Message.ID, "side")
	reply := plain.turn(branch.Line.ID, "bq", "ba")
	e, err := tangent.New(plain.pool, tangent.WithFeatures(features...), tangent.WithPublisher(plain.events))
	if err != nil {
		t.Fatal(err)
	}
	plain.events.Reset()
	_, err = e.CreateBranch(plain.ctx, scopeA, main.ID, tangent.BranchInput{AnchorMessageID: anchor.Message.ID, Purpose: "p", Kind: domain.BranchKindInvestigate})
	if !errors.Is(err, errHook) {
		t.Fatalf("create err = %v", err)
	}
	detail, _ := e.GetBranch(plain.ctx, scopeA, branch.Line.ID)
	_, err = e.MergeBranch(plain.ctx, scopeA, branch.Line.ID, tangent.MergeInput{
		Card:               domain.BranchCard{Question: "q", Conclusion: "c", Evidence: []domain.BranchCardEvidence{{MessageID: reply.Message.ID}}},
		ParentTipMessageID: detail.ParentTipMessageID, NoteChanges: []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "n"}},
	})
	if !errors.Is(err, errHook) {
		t.Fatalf("merge err = %v", err)
	}
	if plain.count(`SELECT count(*) FROM tangent_line WHERE title = 'written by a hook'`) != 0 ||
		plain.count(`SELECT count(*) FROM tangent_message WHERE kind = 'branch_card'`) != 0 ||
		plain.count(`SELECT count(*) FROM tangent_note`) != 0 || plain.count(`SELECT count(*) FROM tangent_branch`) != 1 {
		t.Fatal("a failing later hook must roll back the earlier hook's write and the write itself")
	}
	if len(plain.events.Events()) != 0 {
		t.Fatalf("rolled-back writes published %v", plain.events.Types())
	}
}

// LOW: a superseded summary job that comes back unusable does not start the
// backoff.
func TestPhase2Review_ASupersededSummaryDoesNotBackOff(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.History.SummaryTriggerTokens = 5
	e := newEnv(t, tangent.WithLimits(limits))
	main := e.mainLine()
	e.turn(main.ID, "a fairly long question", "a fairly long answer")
	old, err := e.engine.StartSummary(e.ctx, scopeA, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.StartSummary(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.engine.FinishJob(e.ctx, old.ID, "garbage", nil); !errors.Is(err, domain.ErrJobNotPending) {
		t.Fatalf("err = %v", err)
	}
	e.exec(`UPDATE tangent_job SET status = 'superseded' WHERE status = 'pending'`)
	if done := e.turn(main.ID, "more words", "more words"); !done.SummaryDue {
		t.Fatal("a superseded job must not start the backoff")
	}
}

// LOW: a turn that hits its timeout is stored as timed out, and time spent
// waiting for a slot does not count against the timeout.
func TestPhase2Review_TimeoutsAreReportedAndStartAfterTheSlot(t *testing.T) {
	e := newEnv(t)
	timedOut := e.mainLine()
	d := tangent.NewRunnerDispatcher(e.engine, tangenttest.NewFakeRunner(tangenttest.Reply{Delay: time.Hour}), tangent.WithTurnTimeout(50*time.Millisecond))
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, timedOut.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.DispatchTurn(e.ctx, turn); err != nil {
		t.Fatal(err)
	}
	if err := d.Shutdown(e.ctx); err != nil {
		t.Fatal(err)
	}
	if line, _ := e.engine.GetLine(e.ctx, scopeA, timedOut.ID); line.StatusDetail != "the model run timed out" {
		t.Fatalf("detail = %q", line.StatusDetail)
	}

	slow := runnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
		time.Sleep(150 * time.Millisecond)
		return tangent.RunResult{Content: "ok"}, nil
	})
	d = tangent.NewRunnerDispatcher(e.engine, slow, tangent.WithMaxConcurrent(1), tangent.WithTurnTimeout(250*time.Millisecond))
	for range 3 {
		line := e.mainLine()
		turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
		if err != nil {
			t.Fatal(err)
		}
		if err := d.DispatchTurn(e.ctx, turn); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.Shutdown(e.ctx); err != nil {
		t.Fatal(err)
	}
	if n := e.count(`SELECT count(*) FROM tangent_line WHERE status = 'error'`); n != 1 {
		t.Fatalf("%d lines failed; waiting for a slot must not use up the timeout", n)
	}
}

// LOW: a promotion still runs AfterCommit (the branch read succeeds) and
// emits branch_closed.
func TestPhase2Review_PromotionRunsAfterCommit(t *testing.T) {
	probe := tangent.StubFeature(tangent.StubSpec{Name: "probe", AfterCommit: func(kind string) []tangent.Event { return []tangent.Event{{Type: "probe." + kind}} }})
	e := newEnvWith(t, []tangent.Feature{probe})
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "alt")
	e.turn(branch.Line.ID, "bq", "ba")
	e.events.Reset()
	if _, err := e.engine.PromoteBranch(e.ctx, scopeA, branch.Line.ID); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(e.events.Types(), ","), "probe.branch_closed") {
		t.Fatalf("events = %v", e.events.Types())
	}
}
