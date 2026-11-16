package tangent_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

func TestB41_TextCapsRefuseLongInput(t *testing.T) {
	e := newEnv(t, tangent.WithLimits(domain.Limits{Text: domain.TextLimits{MessageMaxRunes: 10}}))
	_, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: strings.Repeat("t", 201)})
	wantCode(t, err, domain.CodeTooLong)
	_, err = e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Model: strings.Repeat("m", 101)})
	wantCode(t, err, domain.CodeTooLong)
	line := e.mainLine()
	long := strings.Repeat("p", 101)
	_, err = e.engine.UpdateLine(e.ctx, scopeA, line.ID, tangent.LinePatch{Provider: &long})
	wantCode(t, err, domain.CodeTooLong)
	_, err = e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "eleven char"})
	if e := domain.AsError(err, domain.DefaultLimits()); e == nil || e.Code != domain.CodeTooLong || e.Extra["field"] != "content" || e.Extra["max"] != 10 {
		t.Fatalf("err = %v", err)
	}
	done := e.turn(line.ID, "ten chars!", "ok")
	_, err = e.engine.CreateBranch(e.ctx, scopeA, line.ID, tangent.BranchInput{AnchorMessageID: done.Message.ID, Purpose: "p", Kind: domain.BranchKindInvestigate, Model: long})
	wantCode(t, err, domain.CodeTooLong)
	_, err = e.engine.MoveToBranch(e.ctx, scopeA, line.ID, tangent.MoveInput{Count: 2, Purpose: "p", Provider: long})
	wantCode(t, err, domain.CodeTooLong)
}

// allowOnly allows the listed provider/model pairs.
func allowOnly(pairs ...string) func(provider, model string) bool {
	return func(provider, model string) bool {
		for _, pair := range pairs {
			if pair == provider+"/"+model {
				return true
			}
		}
		return false
	}
}

func TestB41_DefaultModelAndModelCheck(t *testing.T) {
	e := newEnv(t, tangent.WithDefaultModel("anthropic", "sonnet"), tangent.WithModelCheck(allowOnly("anthropic/sonnet", "anthropic/haiku", "openai/gpt-5")))
	line, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Title: "defaults"})
	if err != nil || line.Provider != "anthropic" || line.Model != "sonnet" {
		t.Fatalf("line = %s/%s %v", line.Provider, line.Model, err)
	}
	if other, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Provider: "openai", Model: "gpt-5"}); err != nil || other.Model != "gpt-5" {
		t.Fatalf("an allowed pair: %v", err)
	}
	_, err = e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{Provider: "openai"})
	wantCode(t, err, domain.CodeModelNotAllowed)
	bad := "opus"
	_, err = e.engine.UpdateLine(e.ctx, scopeA, line.ID, tangent.LinePatch{Model: &bad})
	wantCode(t, err, domain.CodeModelNotAllowed)
	good := "haiku"
	if updated, err := e.engine.UpdateLine(e.ctx, scopeA, line.ID, tangent.LinePatch{Model: &good}); err != nil || updated.Model != "haiku" {
		t.Fatalf("the line's provider with an allowed model: %v", err)
	}
	done := e.turn(line.ID, "q", "a")
	_, err = e.engine.CreateBranch(e.ctx, scopeA, line.ID, tangent.BranchInput{AnchorMessageID: done.Message.ID, Purpose: "p", Kind: domain.BranchKindInvestigate, Model: "opus"})
	wantCode(t, err, domain.CodeModelNotAllowed)
	_, err = e.engine.MoveToBranch(e.ctx, scopeA, line.ID, tangent.MoveInput{Count: 2, Purpose: "p", Provider: "openai"})
	wantCode(t, err, domain.CodeModelNotAllowed)
	if _, err := e.engine.CreateBranch(e.ctx, scopeA, line.ID, tangent.BranchInput{AnchorMessageID: done.Message.ID, Purpose: "p", Kind: domain.BranchKindInvestigate}); err != nil {
		t.Fatalf("a branch that inherits an allowed model: %v", err)
	}
}

func TestB41_RetryTurnRunsTheFailedTurnAgain(t *testing.T) {
	e := newEnv(t)
	line := e.mainLine()
	e.turn(line.ID, "first", "first answer")
	e.runner.Queue(tangenttest.Reply{Err: tangenttest.ErrFake})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "second"})
	if err != nil {
		t.Fatal(err)
	}
	failed, _ := e.engine.RunTurn(e.ctx, turn, e.runner)
	if failed.Message.Status != domain.MessageError || failed.Message.Meta.Model != "sonnet" || failed.Message.Meta.Provider != "anthropic" || failed.Message.Meta.DurationMs < 0 {
		t.Fatalf("the failed reply keeps provider, model, duration: %+v", failed.Message.Meta)
	}
	e.events.Reset()
	retry, err := e.engine.RetryTurn(e.ctx, scopeA, line.ID)
	if err != nil {
		t.Fatal(err)
	}
	if retry.UserMessage.ID != turn.UserMessage.ID || retry.ID == turn.ID || retry.Prompt.UserMessage != "second" {
		t.Fatalf("retry = %+v", retry)
	}
	for _, entry := range retry.Prompt.History {
		if entry.Content == "second" {
			t.Fatalf("the operator's message is only the turn's own: %v", retry.Prompt.History)
		}
	}
	e.wantTypes(tangent.EventMessageCreated, tangent.EventLineUpdated)
	e.runner.Queue(tangenttest.Reply{Content: "second answer"})
	if done, err := e.engine.RunTurn(e.ctx, retry, e.runner); err != nil || done.Message.Content != "second answer" {
		t.Fatalf("done = %+v %v", done.Message, err)
	}
	_, err = e.engine.RetryTurn(e.ctx, scopeA, line.ID)
	wantCode(t, err, domain.CodeNothingToRetry)
	_, err = e.engine.RetryTurn(e.ctx, scopeB, line.ID)
	wantCode(t, err, domain.CodeLineNotFound)
}

// blockingRunner holds every run until released.
type blockingRunner struct{ release chan struct{} }

func (b blockingRunner) Run(ctx context.Context, _ tangent.RunRequest) (tangent.RunResult, error) {
	select {
	case <-b.release:
		return tangent.RunResult{Content: "ok"}, nil
	case <-ctx.Done():
		return tangent.RunResult{}, ctx.Err()
	}
}

func TestB41_TheDispatcherBoundsItsQueueAndEachTenant(t *testing.T) {
	e := newEnv(t)
	runner := blockingRunner{release: make(chan struct{})}
	d := tangent.NewRunnerDispatcher(e.engine, runner, tangent.WithMaxQueue(3), tangent.WithMaxTenantTurns(2))
	t.Cleanup(func() { _ = d.Close() })
	start := func(scope tangent.Scope) error {
		line, err := e.engine.CreateLine(e.ctx, scope, tangent.LineInput{})
		if err != nil {
			t.Fatal(err)
		}
		turn, err := e.engine.BeginTurn(e.ctx, scope, line.ID, tangent.TurnInput{Content: "q"})
		if err != nil {
			t.Fatal(err)
		}
		return d.DispatchTurn(e.ctx, turn)
	}
	if err := start(scopeA); err != nil {
		t.Fatal(err)
	}
	if err := start(scopeA); err != nil {
		t.Fatal(err)
	}
	if err := start(scopeA); !errors.Is(err, tangent.ErrDispatcherBusy) {
		t.Fatalf("a third turn of one tenant: %v", err)
	}
	if err := start(scopeB); err != nil {
		t.Fatalf("another tenant still fits: %v", err)
	}
	if err := start(scopeB); !errors.Is(err, tangent.ErrDispatcherBusy) {
		t.Fatalf("the queue is full: %v", err)
	}
	if held := d.InFlight(); held != 3 {
		t.Fatalf("in flight: %d", held)
	}
	close(runner.release)
	d.Wait()
	if held := d.InFlight(); held != 0 {
		t.Fatalf("in flight after the work: %d", held)
	}
	if err := start(scopeA); err != nil {
		t.Fatalf("finished work frees the queue: %v", err)
	}
	d.Wait()
}

func TestB41_ConcurrentDispatchRespectsTheQueue(t *testing.T) {
	e := newEnv(t)
	runner := blockingRunner{release: make(chan struct{})}
	d := tangent.NewRunnerDispatcher(e.engine, runner, tangent.WithMaxQueue(4))
	t.Cleanup(func() { _ = d.Close() })
	var mu sync.Mutex
	accepted := 0
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Go(func() {
			id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
			if d.DispatchJob(e.ctx, tangent.Job{ID: id, Kind: "nope", Scope: scopeA}) == nil {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	close(runner.release)
	d.Wait()
	if accepted != 4 {
		t.Fatalf("accepted %d of 8 with a queue of 4", accepted)
	}
}

func TestB41_TurnRequestsCarryStableAndVolatileSystemBlocks(t *testing.T) {
	e := newEnv(t)
	line := e.mainLine()
	e.turn(line.ID, "q", "a")
	requests := e.runner.Requests()
	req := requests[len(requests)-1]
	if len(req.SystemBlocks) == 0 || !req.SystemBlocks[0].Stable {
		t.Fatalf("blocks = %+v", req.SystemBlocks)
	}
	joined := []string{}
	for _, b := range req.SystemBlocks {
		joined = append(joined, b.Text)
	}
	if strings.Join(joined, "\n\n") != req.System {
		t.Fatalf("the blocks add up to System")
	}
}

func TestB41_AJobTheDispatcherRefusesIsFailedAtOnce(t *testing.T) {
	e := newEnvWith(t, []tangent.Feature{tangent.Summary(tangent.ModeAuto)},
		tangent.WithLimits(domain.Limits{History: domain.HistoryLimits{SummaryTriggerTokens: 1}}))
	d := tangent.NewRunnerDispatcher(e.engine, e.runner, tangent.WithMaxQueue(1))
	t.Cleanup(func() { _ = d.Close() })
	line := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "a long enough question"})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.DispatchTurn(e.ctx, turn); err != nil {
		t.Fatal(err)
	}
	d.Wait()
	if n := e.count(`SELECT count(*) FROM tangent_job WHERE kind = 'summary' AND status = 'failed'`); n != 1 {
		t.Fatalf("the summary the full queue refused is failed: %d (pending %d)", n, e.count(`SELECT count(*) FROM tangent_job WHERE status = 'pending'`))
	}
}
