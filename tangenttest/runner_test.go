package tangenttest_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

func TestFakeRunner_AnswersInOrderStreamsRetriesAndFails(t *testing.T) {
	r := tangenttest.NewFakeRunner(
		tangenttest.Reply{Chunks: []string{"a", "b"}, Retries: 1, Usage: domain.Usage{InputTokens: 3}},
		tangenttest.Reply{Err: tangenttest.ErrFake},
	)
	var deltas []domain.Delta
	var retries []tangent.Retry
	req := tangent.RunRequest{
		Model:   "m",
		OnDelta: func(d domain.Delta) { deltas = append(deltas, d) },
		OnRetry: func(info tangent.Retry) { retries = append(retries, info) },
	}
	got, err := r.Run(context.Background(), req)
	if err != nil || got.Content != "ab" || got.Usage.InputTokens != 3 || len(deltas) != 2 || len(retries) != 1 || retries[0].MaxAttempts != 2 {
		t.Fatalf("first = %+v %v deltas %v retries %v", got, err, deltas, retries)
	}
	if _, err := r.Run(context.Background(), tangent.RunRequest{}); !errors.Is(err, tangenttest.ErrFake) {
		t.Fatalf("second err = %v", err)
	}
	if got, _ := r.Run(context.Background(), tangent.RunRequest{}); got.Content != "ok" {
		t.Fatalf("default = %+v", got)
	}
	r.Respond = func(req tangent.RunRequest) tangenttest.Reply { return tangenttest.Reply{Content: "for " + req.Model} }
	if got, _ := r.Run(context.Background(), req); got.Content != "for m" {
		t.Fatalf("respond = %+v", got)
	}
	r.Queue(tangenttest.Reply{Content: "queued"})
	if got, _ := r.Run(context.Background(), req); got.Content != "queued" || len(r.Requests()) != 5 {
		t.Fatalf("queued = %+v, %d requests", got, len(r.Requests()))
	}
}

func TestFakeRunner_DelaysEndWithTheContextAndPanicsPanic(t *testing.T) {
	r := tangenttest.NewFakeRunner(tangenttest.Reply{Delay: time.Hour}, tangenttest.Reply{Delay: time.Millisecond, Content: "late"}, tangenttest.Reply{Panic: "boom"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := r.Run(ctx, tangent.RunRequest{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	if got, err := r.Run(context.Background(), tangent.RunRequest{}); err != nil || got.Content != "late" {
		t.Fatalf("delayed = %+v %v", got, err)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("expected a panic")
		}
	}()
	_, _ = r.Run(context.Background(), tangent.RunRequest{})
}

func TestRecorder_KeepsAndWaitsForEvents(t *testing.T) {
	r := tangenttest.NewRecorder()
	go func() {
		time.Sleep(5 * time.Millisecond)
		r.Publish(context.Background(), tangent.Event{Type: tangent.EventLineCreated})
		r.Publish(context.Background(), tangent.Event{Type: tangent.EventLineUpdated})
	}()
	if !r.WaitFor(tangent.EventLineUpdated, 1, time.Second) {
		t.Fatal("event never seen")
	}
	if got := r.Types(); len(got) != 2 || got[0] != tangent.EventLineCreated || len(r.OfType(tangent.EventLineUpdated)) != 1 {
		t.Fatalf("types = %v", got)
	}
	if r.WaitFor(tangent.EventLineDeleted, 1, 5*time.Millisecond) {
		t.Fatal("an event that never came was reported")
	}
	r.Reset()
	if len(r.Events()) != 0 {
		t.Fatal("reset kept events")
	}
}
