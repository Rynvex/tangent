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

// H1: a cancelled in-process run keeps all it streamed, beyond the 64 KiB
// ring and including a single delta larger than the ring.
func TestReview_CancelKeepsTheWholeStreamOfAnInProcessRun(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	chunks := []string{strings.Repeat("a", 70*1024)}
	for range 40 {
		chunks = append(chunks, strings.Repeat("b", 1024))
	}
	e.runner.Queue(tangenttest.Reply{Chunks: chunks, Delay: time.Hour})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "long"})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := e.engine.RunTurn(e.ctx, turn, e.runner); done <- err }()
	if !e.events.WaitFor(tangent.EventMessageDelta, len(chunks), 5*time.Second) {
		t.Fatal("deltas never arrived")
	}
	cancelled, err := e.engine.CancelTurn(e.ctx, scopeA, main.ID)
	if err != nil || len(cancelled.Message.Content) != 110*1024 {
		t.Fatalf("partial is %d bytes, %v", len(cancelled.Message.Content), err)
	}
	if err := <-done; !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("run err = %v", err)
	}
}

// M2: an engine that learns a turn ended elsewhere forgets it, so later
// deltas are refused instead of buffered from the stale cache.
func TestReview_ATurnEndedByAnotherEngineIsForgotten(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := tangent.New(e.pool, tangent.WithFeatures(tangent.AllFeatures()...))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "done elsewhere"}); err != nil {
		t.Fatal(err)
	}
	if err := e.engine.AppendDelta(e.ctx, turn.ID, domain.Delta{Kind: domain.DeltaText, Text: "cached"}); err != nil {
		t.Fatalf("the cached turn still takes deltas before anything told it otherwise: %v", err)
	}
	if _, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "late"}); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("err = %v", err)
	}
	if err := e.engine.AppendDelta(e.ctx, turn.ID, domain.Delta{Kind: domain.DeltaText, Text: "late"}); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("after ErrTurnNotPending the turn must be forgotten: %v", err)
	}
}

// M3: a cancel that lands before the run starts stops it; a second run of
// the same turn is refused; a cancel from another process stops a
// streaming run at its next check.
func TestReview_RunTurnSeesCancelsAndRefusesDuplicates(t *testing.T) {
	shift := atomic.Int64{}
	e := newEnv(t, tangent.WithClock(func() time.Time { return time.Now().Add(time.Duration(shift.Load())) }))
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.CancelTurn(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.RunTurn(e.ctx, turn, e.runner); !errors.Is(err, domain.ErrTurnNotPending) || len(e.runner.Requests()) != 0 {
		t.Fatalf("a cancelled turn must not run: %v, %d requests", err, len(e.runner.Requests()))
	}

	gate := make(chan struct{})
	runner := &steppedRunner{step: gate}
	turn, err = e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q2"})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := e.engine.RunTurn(e.ctx, turn, runner); done <- err }()
	if !e.events.WaitFor(tangent.EventMessageDelta, 1, 5*time.Second) {
		t.Fatal("first delta never arrived")
	}
	_, err = e.engine.RunTurn(e.ctx, turn, runner)
	wantCode(t, err, domain.CodeTurnPending)

	other, _ := tangent.New(e.pool)
	if _, err := other.CancelTurn(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	shift.Store(int64(time.Minute))
	close(gate)
	select {
	case err := <-done:
		if !errors.Is(err, domain.ErrTurnNotPending) || !runner.stopped.Load() {
			t.Fatalf("run err = %v, stopped %v", err, runner.stopped.Load())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the run was not stopped")
	}
}

// steppedRunner streams one delta, waits for step, streams another, then
// runs until its context ends.
type steppedRunner struct {
	step    chan struct{}
	stopped atomic.Bool
}

func (r *steppedRunner) Run(ctx context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	req.OnDelta(domain.Delta{Kind: domain.DeltaText, Text: "one "})
	<-r.step
	req.OnDelta(domain.Delta{Kind: domain.DeltaText, Text: "two"})
	select {
	case <-ctx.Done():
		r.stopped.Store(true)
		return tangent.RunResult{}, ctx.Err()
	case <-time.After(5 * time.Second):
		return tangent.RunResult{Content: "never stopped"}, nil
	}
}

// M5: raw runner errors and panic values are logged, never stored or
// published; a RunnerError's public text is.
func TestReview_RunnerFailuresAreStoredAsFixedTexts(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	cases := []struct {
		reply tangenttest.Reply
		want  string
	}{
		{tangenttest.Reply{Err: errors.New("401 from https://api.example.com key sk-secret")}, "Turn failed: the model run failed"},
		{tangenttest.Reply{Panic: "secret panic value"}, "Turn failed: the runner crashed"},
		{tangenttest.Reply{Err: &tangent.RunnerError{Public: "rate limited, try again later", Err: errors.New("429 body")}}, "Turn failed: rate limited, try again later"},
		{tangenttest.Reply{Err: context.DeadlineExceeded}, "Turn failed: the model run timed out"},
	}
	for _, c := range cases {
		e.runner.Queue(c.reply)
		turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
		if err != nil {
			t.Fatal(err)
		}
		e.events.Reset()
		done, err := e.engine.RunTurn(e.ctx, turn, e.runner)
		if err != nil || done.Message.Content != c.want || strings.Contains(done.Line.StatusDetail, "secret") {
			t.Fatalf("stored %q / %q, %v", done.Message.Content, done.Line.StatusDetail, err)
		}
		for _, ev := range e.events.Events() {
			if message, ok := ev.Data.(domain.Message); ok && strings.Contains(message.Content+message.Meta.Error, "secret") {
				t.Fatalf("published %+v", message)
			}
		}
	}
	if (&tangent.RunnerError{Public: "x"}).Error() != "x" || errors.Unwrap(&tangent.RunnerError{Public: "x", Err: context.Canceled}) != context.Canceled {
		t.Fatal("RunnerError basics")
	}
}

// M6: a draft whose prompt cannot be built (the caller's context ended right
// after the claim) is ended on a detached context, not left drafting.
func TestReview_AnAbandonedDraftIsEndedEvenWhenTheContextIsGone(t *testing.T) {
	ctx, cancel := context.WithCancel(tangenttest.Context(t))
	publisher := &cancelOnDraft{cancel: cancel}
	e := newEnv(t, tangent.WithPublisher(publisher))
	_, branch, _ := e.draftable()
	if _, err := e.engine.StartDraft(ctx, scopeA, branch.Line.ID); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	detail, err := e.engine.GetBranch(e.ctx, scopeA, branch.Line.ID)
	if err != nil || detail.Draft.Status != domain.BranchDraftFailed {
		t.Fatalf("draft = %+v, %v", detail.Draft, err)
	}
}

// cancelOnDraft cancels a context when a draft starts.
type cancelOnDraft struct{ cancel context.CancelFunc }

func (p *cancelOnDraft) Publish(_ context.Context, ev tangent.Event) {
	if change, ok := ev.Data.(tangent.BranchChange); ok && change.Change == tangent.BranchDraft && change.Branch.DraftStatus == domain.BranchDraftDrafting {
		p.cancel()
	}
}

// M8: deleting a tree stops the runs of the jobs that went with it.
func TestReview_DeleteTreeStopsTheRunsOfItsJobs(t *testing.T) {
	e := newEnv(t)
	main, branch, _ := e.draftable()
	job, err := e.engine.StartDraft(e.ctx, scopeA, branch.Line.ID)
	if err != nil {
		t.Fatal(err)
	}
	runner := tangenttest.NewFakeRunner(tangenttest.Reply{Delay: time.Hour})
	d := tangent.NewRunnerDispatcher(e.engine, runner)
	if err := d.DispatchJob(e.ctx, job); err != nil {
		t.Fatal(err)
	}
	for len(runner.Requests()) == 0 {
		time.Sleep(time.Millisecond)
	}
	if _, err := e.engine.DeleteTree(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	stopped := make(chan struct{})
	go func() { d.Wait(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the job run of a deleted tree kept running")
	}
}

// LOW: a turn cancelled while its runner still finished keeps the usage.
func TestReview_TheUsageOfACancelledRunIsRecorded(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	release, started := make(chan struct{}), make(chan struct{})
	runner := runnerFunc(func(context.Context, tangent.RunRequest) (tangent.RunResult, error) {
		close(started)
		<-release
		return tangent.RunResult{Content: "too late", Usage: domain.Usage{InputTokens: 40, OutputTokens: 2}}, nil
	})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := e.engine.RunTurn(e.ctx, turn, runner); done <- err }()
	<-started
	if _, err := e.engine.CancelTurn(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("err = %v", err)
	}
	if e.count(`SELECT input_tokens FROM tangent_line WHERE id = $1`, main.ID) != 40 {
		t.Fatal("the usage of the cancelled run was lost")
	}
}

type runnerFunc func(context.Context, tangent.RunRequest) (tangent.RunResult, error)

func (f runnerFunc) Run(ctx context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	return f(ctx, req)
}

// LOW: MoveToBranch validates the purpose before anything is read.
func TestReview_MoveRefusesABadPurpose(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.turn(main.ID, "q", "a")
	_, err := e.engine.MoveToBranch(e.ctx, scopeA, main.ID, tangent.MoveInput{Count: 2, Purpose: "  "})
	wantCode(t, err, domain.CodeInvalidInput)
}

// MarkRead republishes the ancestors of a branch (their unread totals).
func TestReview_MarkReadRepublishesTheAncestors(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	branch := e.branch(main.ID, anchor.Message.ID, "b")
	inner := e.branch(branch.Line.ID, e.turn(branch.Line.ID, "bq", "ba").Message.ID, "c")
	e.events.Reset()
	if _, err := e.engine.MarkRead(e.ctx, scopeA, inner.Line.ID); err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for _, ev := range e.events.OfType(tangent.EventLineUpdated) {
		ids = append(ids, ev.LineID)
	}
	if strings.Join(ids, ",") != strings.Join([]string{inner.Line.ID, branch.Line.ID, main.ID}, ",") {
		t.Fatalf("updated lines = %v", ids)
	}
}
