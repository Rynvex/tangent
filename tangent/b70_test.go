package tangent_test

import (
	"errors"
	"reflect"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// B7.0: rebuilding a turn by id, the exported request builder and
// TurnPending. The cross-process tests are in b70_remote_test.go.

// sameRequest compares what a runner is asked (the callbacks aside).
func sameRequest(t *testing.T, got, want tangent.RunRequest) {
	t.Helper()
	got.OnDelta, got.OnRetry, want.OnDelta, want.OnRetry = nil, nil, nil, nil
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("request differs:\n got %+v\nwant %+v", got, want)
	}
}

// begunWithContext begins a turn on a main line that carries a note, an
// earlier exchange and an undelivered conclusion card.
func begunWithContext(e *env) (domain.LineView, tangent.Turn) {
	e.t.Helper()
	main := e.mainLine()
	first := e.turn(main.ID, "where do we go", "Kyoto")
	branch := e.branch(main.ID, first.Message.ID, "hotels")
	e.turn(branch.Line.ID, "which hotel", "the quiet one")
	e.mergeWithCard(branch.Line.ID, domain.BranchCard{Question: "Which hotel?", Conclusion: "Stay at the quiet one"})
	if _, err := e.engine.ApplyNoteChanges(e.ctx, scopeA, main.ID, []domain.NoteChange{{Op: domain.NoteOpAdd, Section: domain.NoteSectionFact, Text: "two nights"}}); err != nil {
		e.t.Fatal(err)
	}
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "and then?"})
	if err != nil {
		e.t.Fatal(err)
	}
	if len(turn.Pending.Meta.DeliversCards) != 1 || turn.Pending.Meta.NotesRevision == 0 {
		e.t.Fatalf("the turn should carry the card and the notes: %+v", turn.Pending.Meta)
	}
	return main, turn
}

func TestLoadTurn_RebuildsTheTurnBeginTurnReturned(t *testing.T) {
	e := newEnv(t)
	_, begun := begunWithContext(e)
	loaded, err := e.engine.LoadTurn(e.ctx, tangent.Scope{Tenant: scopeA.Tenant}, begun.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded.Prompt, begun.Prompt) {
		t.Fatalf("prompt differs:\n got %+v\nwant %+v", loaded.Prompt, begun.Prompt)
	}
	if loaded.ID != begun.ID || loaded.LineID != begun.LineID || loaded.RootLineID != begun.RootLineID ||
		loaded.UserMessage.ID != begun.UserMessage.ID || loaded.Pending.ID != begun.Pending.ID ||
		loaded.Provider != begun.Provider || loaded.Model != begun.Model || loaded.Scope != begun.Scope {
		t.Fatalf("loaded %+v\nbegun %+v", loaded, begun)
	}
	sameRequest(t, loaded.Request(), begun.Request())
}

func TestLoadTurn_ARetriedTurnFindsItsOperatorMessage(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	e.turn(main.ID, "hello", "hi")
	e.runner.Queue(tangenttest.Reply{Err: tangenttest.ErrFake})
	failed, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "again"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.RunTurn(e.ctx, failed, e.runner); err != nil {
		t.Fatal(err)
	}
	retried, err := e.engine.RetryTurn(e.ctx, scopeA, main.ID)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := e.engine.LoadTurn(e.ctx, scopeA, retried.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.UserMessage.ID != failed.UserMessage.ID || !reflect.DeepEqual(loaded.Prompt, retried.Prompt) {
		t.Fatalf("loaded %+v\nretried %+v", loaded, retried)
	}
}

func TestLoadTurn_RefusesAnEndedForeignOrUnknownTurn(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	for name, id := range map[string]string{"unknown": "00000000-0000-4000-8000-0000000000aa", "malformed": "x"} {
		if _, err := e.engine.LoadTurn(e.ctx, scopeA, id); !errors.Is(err, domain.ErrTurnNotPending) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := e.engine.LoadTurn(e.ctx, scopeB, turn.ID); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("another tenant: %v", err)
	}
	if _, err := e.engine.LoadTurn(e.ctx, tangent.Scope{}, turn.ID); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("no tenant: %v", err)
	}
	if _, err := e.engine.CancelTurn(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.engine.LoadTurn(e.ctx, scopeA, turn.ID); !errors.Is(err, domain.ErrTurnNotPending) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestTurnPending_TellsAWorkerWhenToStop(t *testing.T) {
	e := newEnv(t)
	main := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if pending, err := e.engine.TurnPending(e.ctx, scopeA, turn.ID); err != nil || !pending {
		t.Fatalf("pending = %v %v", pending, err)
	}
	if pending, err := e.engine.TurnPending(e.ctx, scopeB, turn.ID); err != nil || pending {
		t.Fatalf("another tenant sees it pending: %v %v", pending, err)
	}
	if _, err := e.engine.CancelTurn(e.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	if pending, err := e.engine.TurnPending(e.ctx, scopeA, turn.ID); err != nil || pending {
		t.Fatalf("after the cancel: %v %v", pending, err)
	}
	if _, err := e.engine.TurnPending(e.ctx, tangent.Scope{}, turn.ID); domain.CodeOf(err) != domain.CodeInvalidInput {
		t.Fatalf("no tenant: %v", err)
	}
}

func TestChatRequest_IsWhatRunTurnSends(t *testing.T) {
	e := newEnv(t)
	_, turn := begunWithContext(e)
	if _, err := e.engine.RunTurn(e.ctx, turn, e.runner); err != nil {
		t.Fatal(err)
	}
	requests := e.runner.Requests()
	sent := requests[len(requests)-1]
	sameRequest(t, sent, tangent.ChatRequest(turn.Prompt, turn.Provider, turn.Model))
	sameRequest(t, turn.Request(), sent)
	if len(sent.SystemBlocks) != 2 || !sent.SystemBlocks[0].Stable || sent.SystemBlocks[1].Stable ||
		sent.System != sent.SystemBlocks[0].Text+"\n\n"+sent.SystemBlocks[1].Text {
		t.Fatalf("blocks = %+v", sent.SystemBlocks)
	}
	job, err := e.engine.StartSummary(e.ctx, scopeA, turn.LineID)
	if err != nil {
		t.Fatal(err)
	}
	request := job.Request()
	sameRequest(t, request, tangent.ChatRequest(job.Prompt, job.Provider, job.Model))
	if request.System == "" && len(request.Messages) == 0 {
		t.Fatalf("job request = %+v", request)
	}
}
