package tangent_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// Two engines over one database stand for two processes: the API process
// (clients, /stream, SSE) and a worker process that runs the turns. What
// crosses between them goes through JSON, as it would over a real channel.

// wire carries one process's events to another: the receiving engine
// observes each event, then its own publisher (the hub) gets it.
type wire struct {
	mu   sync.Mutex
	to   *tangent.Engine
	sink tangent.Publisher
}

func (w *wire) connect(to *tangent.Engine, sink tangent.Publisher) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.to, w.sink = to, sink
}

func (w *wire) Publish(ctx context.Context, ev tangent.Event) {
	w.mu.Lock()
	to, sink := w.to, w.sink
	w.mu.Unlock()
	if to == nil {
		return
	}
	raw, err := json.Marshal(ev.Data)
	if err != nil {
		panic(err)
	}
	ev.Data = json.RawMessage(raw)
	to.Observe(ctx, ev)
	if sink != nil {
		sink.Publish(ctx, ev)
	}
}

// deltaWire hands a worker's deltas to the API process's AppendDelta.
type deltaWire struct{ to *tangent.Engine }

func (d deltaWire) SendDelta(ctx context.Context, remote tangent.RemoteDelta) error {
	raw, err := json.Marshal(remote)
	if err != nil {
		return err
	}
	var received tangent.RemoteDelta
	if err := json.Unmarshal(raw, &received); err != nil {
		return err
	}
	return d.to.AppendDelta(ctx, received.TurnID, received.Delta)
}

// processes is an API engine and a worker engine over one schema, wired
// both ways.
type processes struct {
	*env
	worker       *tangent.Engine
	workerEvents *tangenttest.Recorder
}

func newProcesses(t *testing.T, apiOpts ...tangent.Option) *processes {
	t.Helper()
	toWorker, toAPI := &wire{}, &wire{}
	api := newEnv(t)
	hub := tangenttest.NewRecorder()
	api.engine = mustEngine(t, api, append([]tangent.Option{tangent.WithPublisher(tangent.Publishers(hub, toWorker))}, apiOpts...)...)
	api.events = hub
	workerEvents := tangenttest.NewRecorder()
	worker := mustEngine(t, api, tangent.WithPublisher(tangent.Publishers(workerEvents, toAPI)), tangent.WithDeltaSink(deltaWire{to: api.engine}))
	toAPI.connect(api.engine, hub)
	toWorker.connect(worker, nil)
	return &processes{env: api, worker: worker, workerEvents: workerEvents}
}

func mustEngine(t *testing.T, e *env, opts ...tangent.Option) *tangent.Engine {
	t.Helper()
	engine, err := tangent.New(e.pool, append([]tangent.Option{tangent.WithLogger(slog.New(slog.DiscardHandler)), tangent.WithFeatures(tangent.AllFeatures()...)}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func deltaText(deltas []domain.Delta) string {
	var b strings.Builder
	for _, d := range deltas {
		b.WriteString(d.Text)
	}
	return b.String()
}

func TestRemoteWorker_ItsDeltasStreamFromTheAPIProcess(t *testing.T) {
	p := newProcesses(t)
	main := p.mainLine()
	begun, err := p.engine.BeginTurn(p.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := p.worker.LoadTurn(p.ctx, scopeA, begun.ID)
	if err != nil {
		t.Fatal(err)
	}
	// "[BR" could still become a marker: the API process holds it until the
	// turn ends, then streams it like CompleteTurn does in one process.
	runner := tangenttest.NewFakeRunner(tangenttest.Reply{Chunks: []string{"Hel", "lo there\n", "[BR"}})
	done, err := p.worker.RunTurn(p.ctx, loaded, runner)
	if err != nil {
		t.Fatal(err)
	}
	tail, err := p.engine.StreamSince(p.ctx, scopeA, main.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := deltaText(tail.Deltas); got != done.Message.Content || got != "Hello there\n[BR" {
		t.Fatalf("the API process streamed %q, the reply is %q", got, done.Message.Content)
	}
	published := p.events.OfType(tangent.EventMessageDelta)
	if len(published) != len(tail.Deltas) {
		t.Fatalf("published %d deltas, buffered %d", len(published), len(tail.Deltas))
	}
	for i, ev := range published {
		if ev.Data.(domain.Delta).Seq != tail.Deltas[i].Seq {
			t.Fatalf("delta %d: published seq %d, buffered %d", i, ev.Data.(domain.Delta).Seq, tail.Deltas[i].Seq)
		}
	}
	if n := len(p.workerEvents.OfType(tangent.EventMessageDelta)); n != 0 {
		t.Fatalf("the worker published %d deltas itself", n)
	}
	if workerTail, _ := p.worker.StreamSince(p.ctx, scopeA, main.ID, 0); len(workerTail.Deltas) != 0 {
		t.Fatalf("the worker buffered %v", workerTail.Deltas)
	}
	if !p.events.WaitFor(tangent.EventMessageUpdated, 1, time.Second) {
		t.Fatalf("the worker's completion did not reach the API hub: %v", p.events.Types())
	}
}

func TestRemoteWorker_PartialRepliesAreSavedInTheAPIsSequence(t *testing.T) {
	p := newProcesses(t, tangent.WithPartialFlush(time.Hour, 4))
	main := p.mainLine()
	begun, err := p.engine.BeginTurn(p.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := p.worker.LoadTurn(p.ctx, scopeA, begun.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.worker.AppendDelta(p.ctx, loaded.ID, domain.Delta{Kind: domain.DeltaText, Text: "streamed so far"}); err != nil {
		t.Fatal(err)
	}
	messages, err := p.engine.ListMessages(p.ctx, scopeA, main.ID, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	pending := messages[len(messages)-1]
	tail, _ := p.engine.StreamSince(p.ctx, scopeA, main.ID, 0)
	if pending.Content != "streamed so far" || pending.Meta.StreamSeq == 0 || pending.Meta.StreamSeq != tail.Seq {
		t.Fatalf("partial %q at seq %d, the API buffer is at %d", pending.Content, pending.Meta.StreamSeq, tail.Seq)
	}
}

func TestRemoteWorker_ACancelInTheAPIProcessStopsTheWorkersRun(t *testing.T) {
	p := newProcesses(t)
	main := p.mainLine()
	begun, err := p.engine.BeginTurn(p.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := p.worker.LoadTurn(p.ctx, scopeA, begun.ID)
	if err != nil {
		t.Fatal(err)
	}
	runner := tangenttest.NewFakeRunner(tangenttest.Reply{Chunks: []string{"half an answer"}, Delay: time.Minute})
	finished := make(chan error, 1)
	go func() {
		_, err := p.worker.RunTurn(context.WithoutCancel(p.ctx), loaded, runner)
		finished <- err
	}()
	if !p.events.WaitFor(tangent.EventMessageDelta, 1, 5*time.Second) {
		t.Fatal("no delta reached the API process")
	}
	cancelled, err := p.engine.CancelTurn(p.ctx, scopeA, main.ID)
	if err != nil || !cancelled.Cancelled || cancelled.Message.Content != "half an answer" {
		t.Fatalf("cancel = %+v %v", cancelled, err)
	}
	select {
	case err := <-finished:
		if !errors.Is(err, domain.ErrTurnNotPending) {
			t.Fatalf("the worker's run ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the worker kept running after the cancel")
	}
}

func TestRemoteWorker_ADeletedLineIsForgottenInTheOtherProcess(t *testing.T) {
	p := newProcesses(t)
	main := p.mainLine()
	begun, err := p.engine.BeginTurn(p.ctx, scopeA, main.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.engine.AppendDelta(p.ctx, begun.ID, domain.Delta{Kind: domain.DeltaText, Text: "buffered"}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.engine.CompleteTurn(p.ctx, begun.ID, tangent.TurnResult{Content: "buffered"}); err != nil {
		t.Fatal(err)
	}
	if tail, _ := p.engine.StreamSince(p.ctx, scopeA, main.ID, 0); len(tail.Deltas) != 1 {
		t.Fatalf("the API process buffers %v", tail.Deltas)
	}
	// A tree is deleted only when it is not answering; the worker deletes it.
	if _, err := p.worker.DeleteTree(p.ctx, scopeA, main.ID); err != nil {
		t.Fatal(err)
	}
	if tail, _ := p.engine.StreamSince(p.ctx, scopeA, main.ID, 0); len(tail.Deltas) != 0 {
		t.Fatalf("the API process still buffers %v", tail.Deltas)
	}
}

func TestObserve_IgnoresWhatItDoesNotKnow(t *testing.T) {
	e := newEnv(t)
	e.engine.Observe(e.ctx,
		tangent.Event{Type: "something.else", Data: json.RawMessage(`{}`)},
		tangent.Event{Type: tangent.EventMessageUpdated, Data: json.RawMessage(`not json`)},
		tangent.Event{Type: tangent.EventLineDeleted, Data: nil},
	)
	if len(e.events.Events()) != 0 {
		t.Fatalf("Observe published %v", e.events.Types())
	}
}
