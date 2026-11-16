package tangent_test

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

func TestDispatcher_RunsTurnsAndJobsAndWritesTheOutcomeBack(t *testing.T) {
	e := newEnv(t)
	_, branch, reply := e.draftable()
	runner := tangenttest.NewFakeRunner(tangenttest.Reply{Chunks: []string{"a", "b"}})
	runner.Respond = func(req tangent.RunRequest) tangenttest.Reply {
		if strings.Contains(req.Messages[0].Content, domain.BranchCardMarker) {
			return tangenttest.Reply{Content: draftReply(t, reply.ID)}
		}
		return tangenttest.Reply{Content: "fallback"}
	}
	d := tangent.NewRunnerDispatcher(e.engine, runner)

	ctx, cancel := context.WithCancel(e.ctx)
	turn, err := e.engine.BeginTurn(ctx, scopeA, branch.Line.ID, tangent.TurnInput{Content: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.DispatchTurn(ctx, turn); err != nil {
		t.Fatal(err)
	}
	cancel() // the run outlives the dispatching request
	d.Wait()
	messages, _ := e.engine.ListMessages(e.ctx, scopeA, branch.Line.ID, 0, 10)
	if last := messages[len(messages)-1]; last.Content != "ab" || last.Status != domain.MessageDone {
		t.Fatalf("dispatched turn = %+v", last)
	}

	job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.DispatchJob(e.ctx, job); err != nil {
		t.Fatal(err)
	}
	d.Wait()
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	if detail.Draft.Status != domain.BranchDraftReady {
		t.Fatalf("dispatched draft = %+v", detail.Draft)
	}
	if req := runner.Requests()[1]; req.Provider != "anthropic" || req.Model != "sonnet" || req.System != "" || len(req.Messages) != 1 {
		t.Fatalf("job request = %+v", req)
	}
}

func TestDispatcher_PanicsAndTimeoutsFailTheWork(t *testing.T) {
	e := newEnv(t)
	main, branch, _ := e.draftable()
	runner := tangenttest.NewFakeRunner(
		tangenttest.Reply{Panic: "boom"},
		tangenttest.Reply{Delay: time.Hour},
		tangenttest.Reply{Panic: errors.New("job boom")},
	)
	d := tangent.NewRunnerDispatcher(e.engine, runner, tangent.WithTurnTimeout(50*time.Millisecond), tangent.WithJobTimeout(time.Minute), nil)

	for i := range 2 {
		turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
		if err != nil {
			t.Fatal(err)
		}
		if err := d.DispatchTurn(e.ctx, turn); err != nil {
			t.Fatal(err)
		}
		d.Wait()
		line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID)
		if line.Status != domain.LineStatusError {
			t.Fatalf("run %d left the line %q (%s)", i, line.Status, line.StatusDetail)
		}
	}

	job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.DispatchJob(e.ctx, job); err != nil {
		t.Fatal(err)
	}
	d.Wait()
	detail, _ := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	if detail.Draft.Status != domain.BranchDraftFailed || detail.Draft.Error != domain.DraftRunFailedText {
		t.Fatalf("a crashed job must fail the draft: %+v", detail.Draft)
	}

	empty := tangent.NewRunnerDispatcher(e.engine, nil)
	if empty.DispatchTurn(e.ctx, tangent.Turn{}) == nil || empty.DispatchJob(e.ctx, tangent.Job{}) == nil {
		t.Fatal("a dispatcher without a runner must refuse work")
	}
}

// plainRunner answers every request with "x".
type plainRunner struct{}

func (plainRunner) Run(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
	return tangent.RunResult{Content: "x"}, nil
}

func TestDispatcher_AJobForAVanishedBranchIsDroppedQuietly(t *testing.T) {
	e := newEnv(t)
	main, branch, _ := e.draftable()
	job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.DeleteTree(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	d := tangent.NewRunnerDispatcher(e.engine, plainRunner{})
	if err := d.DispatchJob(e.ctx, job); err != nil {
		t.Fatal(err)
	}
	d.Wait()
	if err := e.engine.FinishJob(e.ctx, job.ID, "", nil); !errors.Is(err, domain.ErrJobNotFound) {
		t.Fatalf("err = %v", err)
	}
}

// H2: Shutdown waits for runs, cancels them when its context ends (they
// write their failure back) and refuses later work; Close cancels at once.
func TestDispatcher_ShutdownStopsRunsAndRefusesWork(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	quick := tangent.NewRunnerDispatcher(e.engine, tangenttest.NewFakeRunner())
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if err := quick.DispatchTurn(e.ctx, turn); err != nil {
		t.Fatal(err)
	}
	if err := quick.Shutdown(e.ctx); err != nil {
		t.Fatalf("graceful shutdown: %v", err)
	}
	if err := quick.DispatchTurn(e.ctx, turn); !errors.Is(err, tangent.ErrDispatcherClosed) {
		t.Fatalf("dispatch after shutdown: %v", err)
	}

	slow := tangent.NewRunnerDispatcher(e.engine, tangenttest.NewFakeRunner(tangenttest.Reply{Delay: time.Hour}))
	turn, err = e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q2"})
	if err != nil {
		t.Fatal(err)
	}
	if err := slow.DispatchTurn(e.ctx, turn); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(e.ctx, 50*time.Millisecond)
	defer cancel()
	if err := slow.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("forced shutdown: %v", err)
	}
	line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if line.Status != domain.LineStatusError || line.StatusDetail != "the model run was cancelled" {
		t.Fatalf("a cancelled run must be written back: %q %q", line.Status, line.StatusDetail)
	}
	if err := tangent.NewRunnerDispatcher(e.engine, plainRunner{}).Close(); err != nil {
		t.Fatal(err)
	}
}

// H2: WithMaxConcurrent bounds the runs that execute at once.
func TestDispatcher_MaxConcurrentBoundsRuns(t *testing.T) {
	e := newEnv(t)
	var running, peak atomic.Int32
	runner := runnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
		now := running.Add(1)
		for {
			old := peak.Load()
			if now <= old || peak.CompareAndSwap(old, now) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		running.Add(-1)
		return tangent.RunResult{Content: "ok"}, nil
	})
	d := tangent.NewRunnerDispatcher(e.engine, runner, tangent.WithMaxConcurrent(2))
	for range 5 {
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
	if peak.Load() > 2 || e.count(`SELECT count(*) FROM tangent_message WHERE status = 'pending'`) != 0 {
		t.Fatalf("peak %d", peak.Load())
	}
}

// A turn waiting for a slot when the dispatcher closes is failed, not lost.
func TestDispatcher_ATurnWaitingForASlotIsFailedOnClose(t *testing.T) {
	e := newEnv(t)
	d := tangent.NewRunnerDispatcher(e.engine, tangenttest.NewFakeRunner(tangenttest.Reply{Delay: time.Hour}, tangenttest.Reply{Delay: time.Hour}), tangent.WithMaxConcurrent(1))
	lines := []domain.LineView{e.mainLine(), e.mainLine()}
	for _, line := range lines {
		turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
		if err != nil {
			t.Fatal(err)
		}
		if err := d.DispatchTurn(e.ctx, turn); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(20 * time.Millisecond)
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	if e.count(`SELECT count(*) FROM tangent_message WHERE status = 'pending'`) != 0 {
		t.Fatal("every turn must be written back")
	}
}
