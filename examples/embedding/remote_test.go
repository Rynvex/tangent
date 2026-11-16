package embedding_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/examples/embedding"
	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// remoteSetup is the API process (an Engine behind httpapi, queueing turns)
// and a worker process (its own Engine over the same database), wired with
// the example's channel ends.
type remoteSetup struct {
	api, worker *tangent.Engine
	hub         *tangenttest.Recorder
	server      *httptest.Server
	runner      *tangenttest.FakeRunner
	run         embedding.Worker
	wakes       chan struct{}
}

func newRemoteSetup(t *testing.T) *remoteSetup {
	t.Helper()
	pool := tangenttest.Open(t)
	mustExec(t, pool, embedding.HostTurnQueueDDL)
	s := &remoteSetup{hub: tangenttest.NewRecorder(), runner: tangenttest.NewFakeRunner(), wakes: make(chan struct{}, 8)}
	var mu sync.Mutex // the worker exists only after the API engine
	toWorker := embedding.EventSender{Log: quietLog(), Send: func(ctx context.Context, payload []byte) error {
		mu.Lock()
		worker := s.worker
		mu.Unlock()
		return embedding.ReceiveEvent(ctx, worker, nil, payload)
	}}
	s.api = newEngine(t, pool, tangent.WithPublisher(tangent.Publishers(s.hub, toWorker)))
	toAPI := embedding.EventSender{Log: quietLog(), Send: func(ctx context.Context, payload []byte) error {
		return embedding.ReceiveEvent(ctx, s.api, s.hub, payload)
	}}
	deltas := embedding.DeltaSender{Send: func(ctx context.Context, payload []byte) error {
		return embedding.ReceiveDelta(ctx, s.api, payload)
	}}
	mu.Lock()
	s.worker = newEngine(t, pool, tangent.WithPublisher(toAPI), tangent.WithDeltaSink(deltas))
	mu.Unlock()
	s.run = embedding.Worker{Engine: s.worker, Model: s.runner, Pool: pool}
	jobs := tangent.NewRunnerDispatcher(s.api, s.runner)
	t.Cleanup(func() { _ = jobs.Close() })
	handler, err := httpapi.New(httpapi.Config{
		Engine: s.api, Dispatcher: embedding.QueuedDispatcher{Wake: s.wake, Jobs: jobs}, TxOptions: embedding.QueueTurns,
		Scope: func(*http.Request) (tangent.Scope, error) { return scope, nil }, Logger: quietLog(),
	})
	if err != nil {
		t.Fatal(err)
	}
	s.server = httptest.NewServer(http.StripPrefix("/api", handler))
	t.Cleanup(s.server.Close)
	return s
}

func (s *remoteSetup) wake() {
	select {
	case s.wakes <- struct{}{}:
	default:
	}
}

func TestRemoteWorker_RunsAQueuedTurnAndTheAPIProcessStreamsIt(t *testing.T) {
	s := newRemoteSetup(t)
	ctx := tangenttest.Context(t)
	line := newLine(t, ctx, s.api)
	s.runner.Queue(tangenttest.Reply{Chunks: []string{"Kyoto ", "in spring"}})
	status, sent := call(t, s.server.Client(), http.MethodPost, s.server.URL+"/api/lines/"+line+"/messages", map[string]any{"content": "where?"}, nil)
	if status != http.StatusAccepted {
		t.Fatalf("send: %d %v", status, sent)
	}
	select {
	case <-s.wakes:
	case <-time.After(settle):
		t.Fatal("the dispatcher did not wake a worker")
	}
	if ran, err := s.run.RunOne(ctx); err != nil || !ran {
		t.Fatalf("worker: %v %v", ran, err)
	}
	if ran, err := s.run.RunOne(ctx); err != nil || ran {
		t.Fatalf("the queue should be empty: %v %v", ran, err)
	}
	reply := waitMessage(t, ctx, s.api, line, sent["turnId"].(string))
	_, tail := call(t, s.server.Client(), http.MethodGet, s.server.URL+"/api/lines/"+line+"/stream", nil, nil)
	var streamed strings.Builder
	for _, d := range tail["deltas"].([]any) {
		streamed.WriteString(d.(map[string]any)["text"].(string))
	}
	if reply.Content != "Kyoto in spring" || streamed.String() != reply.Content {
		t.Fatalf("reply %q, the API process streamed %q", reply.Content, streamed.String())
	}
	if len(s.hub.OfType(tangent.EventMessageDelta)) == 0 || !s.hub.WaitFor(tangent.EventMessageUpdated, 1, settle) {
		t.Fatalf("the API hub got %v", s.hub.Types())
	}
}

func TestQueueTurns_ARefusedTurnQueuesNothing(t *testing.T) {
	s := newRemoteSetup(t)
	ctx := tangenttest.Context(t)
	line := newLine(t, ctx, s.api)
	if status, _ := call(t, s.server.Client(), http.MethodPost, s.server.URL+"/api/lines/"+line+"/messages", map[string]any{"content": "first"}, nil); status != http.StatusAccepted {
		t.Fatalf("send: %d", status)
	}
	// The first turn is still queued: a second message is refused, and its
	// hook never wrote a row.
	if status, body := call(t, s.server.Client(), http.MethodPost, s.server.URL+"/api/lines/"+line+"/messages", map[string]any{"content": "second"}, nil); status != http.StatusConflict {
		t.Fatalf("second send: %d %v", status, body)
	}
	if ran, err := s.run.RunOne(ctx); err != nil || !ran {
		t.Fatalf("worker: %v %v", ran, err)
	}
	if ran, _ := s.run.RunOne(ctx); ran {
		t.Fatal("a refused turn was queued")
	}
}
