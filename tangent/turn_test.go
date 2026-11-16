package tangent_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

func TestTurn_BeginStoresTwoMessagesAndPublishesAfterTheCommit(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.turn(main.ID, "first question", "first answer")
	e.events.Reset()

	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "  second question  "})
	if err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventMessageCreated, tangent.EventMessageCreated, tangent.EventLineUpdated)
	if turn.ID != turn.Pending.ID || turn.UserMessage.Content != "second question" || turn.Provider != "anthropic" || turn.RootLineID != main.ID {
		t.Fatalf("turn = %+v", turn)
	}
	if turn.Prompt.UserMessage != "second question" || len(turn.Prompt.History) != 2 || turn.Prompt.History[1].Content != "first answer" {
		t.Fatalf("prompt history = %+v", turn.Prompt.History)
	}
	if line := e.events.Events()[2].Data.(domain.LineView); line.Status != domain.LineStatusThinking {
		t.Fatalf("line.updated carries %q", line.Status)
	}
	if _, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "again"}); err == nil {
		t.Fatal("a second pending turn must be refused")
	} else {
		wantCode(t, err, domain.CodeTurnPending)
	}
	if _, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "  "}); err == nil {
		t.Fatal("an empty message must be refused")
	} else {
		wantCode(t, err, domain.CodeInvalidInput)
	}
}

func TestTurn_CompleteIsOnceAndParsesSuggestions(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "plan the trip"})
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	reply := "Book the train.\n" + domain.BranchSuggestMarker + ` {"purpose":"compare hotels","kind":"investigate"}`
	done, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: reply, Usage: &domain.Usage{InputTokens: 10, OutputTokens: 5}})
	if err != nil {
		t.Fatal(err)
	}
	e.wantTypes(tangent.EventMessageUpdated, tangent.EventLineUpdated)
	if done.Message.Content != "Book the train." || len(done.Message.Meta.Suggestions) != 1 || done.Line.Status != domain.LineStatusIdle {
		t.Fatalf("done = %+v", done.Message)
	}
	if _, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "late"}); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("second completion err = %v", err)
	}

	created, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: done.Message.ID, Purpose: "compare hotels", Kind: domain.BranchKindInvestigate, SuggestionMessageID: done.Message.ID,
	})
	if err != nil || created.Branch.Origin != domain.BranchOriginSuggestion {
		t.Fatalf("accepted suggestion = %+v, %v", created.Branch, err)
	}
	_, err = e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: done.Message.ID, Purpose: "something else", Kind: domain.BranchKindInvestigate, SuggestionMessageID: done.Message.ID,
	})
	wantCode(t, err, domain.CodeSuggestionNotFound)
	_, err = e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: done.Message.ID, Purpose: "compare hotels", Kind: domain.BranchKindInvestigate, SuggestionMessageID: turn.UserMessage.ID,
	})
	wantCode(t, err, domain.CodeSuggestionNotFound)
}

func TestTurn_RunnerErrorsAndPanicsFailTheTurn(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	for name, reply := range map[string]tangenttest.Reply{
		"error": {Err: tangenttest.ErrFake},
		"panic": {Panic: "boom"},
		"empty": {Content: "   "},
	} {
		e.runner.Queue(reply)
		turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "go " + name})
		if err != nil {
			t.Fatal(err)
		}
		done, err := e.engine.RunTurn(e.ctx, turn, e.runner)
		if err != nil {
			t.Fatal(err)
		}
		if done.Message.Status != domain.MessageError || done.Line.Status != domain.LineStatusError {
			t.Fatalf("%s: done = %+v", name, done.Message)
		}
		if name == "panic" && !strings.Contains(done.Message.Content, "the runner crashed") {
			t.Fatalf("panic content = %q", done.Message.Content)
		}
	}
	if _, err := e.engine.RunTurn(e.ctx, tangent.Turn{}, nil); err == nil {
		t.Fatal("RunTurn without a runner must fail")
	}
}

func TestTurn_RetriesArePublished(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.runner.Queue(tangenttest.Reply{Content: "fine", Retries: 2})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.RunTurn(e.ctx, turn, e.runner); err != nil {
		t.Fatal(err)
	}
	retries := e.events.OfType(tangent.EventTurnRetrying)
	if len(retries) != 2 {
		t.Fatalf("retries = %+v", retries)
	}
	data := retries[1].Data.(tangent.TurnRetrying)
	if data.TurnID != turn.ID || data.Attempt != 2 || data.MaxAttempts != 3 || retries[1].LineID != main.ID {
		t.Fatalf("retry data = %+v", data)
	}
}

type gateFunc func(context.Context, tangent.Scope, domain.LineView) error

func (g gateFunc) AllowTurn(ctx context.Context, s tangent.Scope, l domain.LineView) error {
	return g(ctx, s, l)
}

type contributorFunc func(context.Context, tangent.Scope, domain.LineView) ([]domain.PromptSection, error)

func (c contributorFunc) Contribute(ctx context.Context, s tangent.Scope, l domain.LineView) ([]domain.PromptSection, error) {
	return c(ctx, s, l)
}

func TestTurn_GateRefusesBeforeAnythingIsWritten(t *testing.T) {
	offline := domain.NewError("daemon_offline", "the daemon is offline", nil)
	var seen domain.LineView
	e := newEnv(t, tangent.WithTurnGate(gateFunc(func(_ context.Context, s tangent.Scope, l domain.LineView) error {
		seen = l
		return offline
	})))
	main := e.mainLine()
	e.events.Reset()
	_, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if !errors.Is(err, offline) || seen.ID != main.ID {
		t.Fatalf("err = %v, gate saw %q", err, seen.ID)
	}
	if e.count(`SELECT count(*) FROM tangent_message`) != 0 || len(e.events.Events()) != 0 {
		t.Fatal("a refused turn must write and publish nothing")
	}
	_, err = e.engine.BeginTurn(e.ctx, scopeB, main.ID, tangent.TurnInput{Content: "q"})
	wantCode(t, err, domain.CodeLineNotFound)
}

func TestTurn_ContributorSectionsJoinThePromptAndItsFailureFailsTheTurn(t *testing.T) {
	fail := false
	e := newEnv(t, tangent.WithPromptContributor(contributorFunc(func(context.Context, tangent.Scope, domain.LineView) ([]domain.PromptSection, error) {
		if fail {
			return nil, errors.New("plan store down")
		}
		return []domain.PromptSection{{Key: "plan", Title: "Plan", Body: "step 1"}, {Key: domain.SectionNotes, Body: "sneaky"}}, nil
	})), tangent.WithExtraMarkers("[NEEDS-INPUT]"))
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{}
	for _, section := range turn.Prompt.Sections {
		keys = append(keys, section.Key)
	}
	if strings.Join(keys, ",") != "rules,plan,host:notes" {
		t.Fatalf("section keys = %v", keys)
	}
	if _, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "a"}); err != nil {
		t.Fatal(err)
	}

	fail = true
	_, err = e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q2"})
	if err == nil || !strings.Contains(err.Error(), "plan store down") {
		t.Fatalf("err = %v", err)
	}
	line, _ := e.engine.GetLine(e.ctx, scopeA, main.ID)
	if line.Status != domain.LineStatusError || e.count(`SELECT count(*) FROM tangent_message WHERE status = 'pending'`) != 0 {
		t.Fatalf("an unbuilt turn must be failed at once, line %+v", line)
	}
}

func TestTurn_DeltasAreBufferedFromAnotherProcessAndRefusedAfterTheTurn(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := tangent.New(e.pool, tangent.WithPublisher(e.events))
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	if err := other.AppendDelta(e.ctx, turn.ID, domain.Delta{Kind: domain.DeltaText, Text: "par"}); err != nil {
		t.Fatal(err)
	}
	if err := other.AppendDelta(e.ctx, turn.ID, domain.Delta{Kind: "bogus"}); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("bad kind err = %v", err)
	}
	e.wantTypes(tangent.EventMessageDelta)
	if delta := e.events.Events()[0].Data.(domain.Delta); delta.TurnID != turn.ID || delta.Seq <= 0 || e.events.Events()[0].RootLineID != main.ID {
		t.Fatalf("delta = %+v", delta)
	}
	if got, _ := other.StreamSince(e.ctx, scopeA, main.ID, 0); len(got.Deltas) != 1 {
		t.Fatalf("stream = %+v", got)
	}
	if got, _ := other.StreamSince(e.ctx, scopeB, main.ID, 0); len(got.Deltas) != 0 {
		t.Fatalf("another tenant read %+v", got)
	}
	if _, err := other.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "partial"}); err != nil {
		t.Fatal(err)
	}
	if err := other.AppendDelta(e.ctx, turn.ID, domain.Delta{Kind: domain.DeltaText, Text: "late"}); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("late delta err = %v", err)
	}
	if err := e.engine.AppendDelta(e.ctx, "not-a-turn", domain.Delta{Kind: domain.DeltaText}); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("unknown turn err = %v", err)
	}
}

func TestTurn_CancelKeepsTheStreamedTextAndStopsTheRun(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.runner.Queue(tangenttest.Reply{Chunks: []string{"par", "tial"}, Delay: time.Hour})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := e.engine.RunTurn(e.ctx, turn, e.runner)
		result <- err
	}()
	if !e.events.WaitFor(tangent.EventMessageDelta, 2, 5*time.Second) {
		t.Fatal("deltas never arrived")
	}
	cancelled, err := e.engine.CancelTurn(e.ctx, scopeA, main.ID)
	if err != nil || !cancelled.Cancelled || cancelled.Message.Content != "partial" || !cancelled.Message.Meta.Cancelled {
		t.Fatalf("cancel = %+v, %v", cancelled, err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, domain.ErrTurnNotPending) {
			t.Fatalf("the cancelled run returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the run did not stop")
	}
	again, err := e.engine.CancelTurn(e.ctx, scopeA, main.ID)
	if err != nil || again.Cancelled {
		t.Fatalf("cancel without a turn = %+v, %v", again, err)
	}
	_, err = e.engine.CancelTurn(e.ctx, scopeB, main.ID)
	wantCode(t, err, domain.CodeLineNotFound)
}

func TestTurn_FailStaleTurnsEndsOldPendingTurns(t *testing.T) {
	shift := time.Duration(0)
	e := newEnv(t, tangent.WithClock(func() time.Time { return time.Now().Add(shift) }))
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.FailStaleTurns(e.ctx, time.Now().Add(time.Hour)); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("future cutoff err = %v", err)
	}
	if stale, err := e.engine.FailStaleTurns(e.ctx, time.Now().Add(-time.Hour)); err != nil || len(stale) != 0 {
		t.Fatalf("fresh turn failed: %+v %v", stale, err)
	}
	shift = 2 * time.Hour
	e.events.Reset()
	stale, err := e.engine.FailStaleTurns(e.ctx, time.Now().Add(time.Hour))
	if err != nil || len(stale) != 1 || stale[0].Message.ID != turn.ID || stale[0].Message.Status != domain.MessageError {
		t.Fatalf("stale = %+v, %v", stale, err)
	}
	e.wantTypes(tangent.EventMessageUpdated, tangent.EventLineUpdated)
}

func TestTurn_SummaryDueIsReportedUntilASummaryIsPending(t *testing.T) {
	limits := domain.DefaultLimits()
	limits.History.SummaryTriggerTokens = 5
	e := newEnv(t, tangent.WithLimits(limits))
	main := e.mainLine()
	done := e.turn(main.ID, "a fairly long question about many things", "an equally long answer about them")
	if !done.SummaryDue {
		t.Fatal("summary must be due past the trigger")
	}
	if _, err := e.engine.StartSummary(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	if done := e.turn(main.ID, "more", "more"); done.SummaryDue {
		t.Fatal("a pending summary must not be reported as due again")
	}
}

func TestTurn_AnAnsweredAsideEnds(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	anchor := e.turn(main.ID, "q", "a")
	aside, err := e.engine.CreateBranch(e.ctx, scopeA, main.ID, tangent.BranchInput{
		AnchorMessageID: anchor.Message.ID, Purpose: "quick check", Kind: domain.BranchKindAside,
	})
	if err != nil {
		t.Fatal(err)
	}
	e.events.Reset()
	done := e.turn(aside.Line.ID, "what is 2+2?", "4")
	if done.EndedAside == nil || done.EndedAside.Status != domain.BranchStatusDiscarded {
		t.Fatalf("ended aside = %+v", done.EndedAside)
	}
	types := strings.Join(e.events.Types(), ",")
	if !strings.Contains(types, tangent.EventBranchChanged) {
		t.Fatalf("events = %s", types)
	}
	_, err = e.engine.BeginTurn(e.ctx, scopeA, aside.Line.ID, tangent.TurnInput{Content: "again"})
	wantCode(t, err, domain.CodeBranchClosed)
}

func TestTurn_ConcurrentBeginsStartOneTurnAndPublishOnlyIt(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.events.Reset()
	const callers = 6
	results := make(chan error, callers)
	for range callers {
		go func() {
			_, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "race"})
			results <- err
		}()
	}
	started := 0
	for range callers {
		if err := <-results; err == nil {
			started++
		} else if domain.CodeOf(err) != domain.CodeTurnPending {
			t.Fatalf("unexpected err %v", err)
		}
	}
	if started != 1 || len(e.events.OfType(tangent.EventMessageCreated)) != 2 {
		t.Fatalf("started %d, events %v", started, e.events.Types())
	}
	turn, ok, err := pendingTurn(e, main.ID)
	if err != nil || !ok {
		t.Fatal("no pending turn")
	}
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() {
			if err := e.engine.AppendDelta(e.ctx, turn, domain.Delta{Kind: domain.DeltaText, Text: string(rune('a' + i%26))}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if got, _ := e.engine.StreamSince(e.ctx, scopeA, main.ID, 0); len(got.Deltas) != 20 || got.Deltas[19].Seq != got.Seq {
		t.Fatalf("deltas = %d", len(got.Deltas))
	}
}

// pendingTurn returns the id of the line's pending turn.
func pendingTurn(e *env, lineID string) (string, bool, error) {
	messages, err := e.engine.ListMessages(e.ctx, scopeA, lineID, 0, 100)
	if err != nil {
		return "", false, err
	}
	for _, message := range messages {
		if message.Status == domain.MessagePending {
			return message.ID, true, nil
		}
	}
	return "", false, nil
}
