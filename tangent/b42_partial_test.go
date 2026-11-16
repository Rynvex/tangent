package tangent_test

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

// clock is a settable time source.
type clock struct{ now atomic.Int64 }

func newClock() *clock {
	c := &clock{}
	c.now.Store(time.Date(2026, 10, 15, 9, 0, 0, 0, time.UTC).UnixNano())
	return c
}

func (c *clock) Now() time.Time          { return time.Unix(0, c.now.Load()).UTC() }
func (c *clock) advance(d time.Duration) { c.now.Add(int64(d)) }

// pendingReply reads the newest message of a line.
func (e *env) pendingReply(engine *tangent.Engine, lineID string) domain.Message {
	e.t.Helper()
	messages, err := engine.ListMessages(e.ctx, scopeA, lineID, 0, 0)
	if err != nil {
		e.t.Fatal(err)
	}
	return messages[len(messages)-1]
}

func text(s string) domain.Delta { return domain.Delta{Kind: domain.DeltaText, Text: s} }

func TestB42_PartialRepliesAreSavedOnTimeAndSize(t *testing.T) {
	c := newClock()
	e := newEnv(t, tangent.WithClock(c.Now), tangent.WithPartialFlush(2*time.Second, 16))
	line := e.mainLine()
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
	if err != nil {
		t.Fatal(err)
	}
	appendText := func(s string) {
		if err := e.engine.AppendDelta(e.ctx, turn.ID, text(s)); err != nil {
			t.Fatal(err)
		}
	}
	appendText("Hello ")
	c.advance(time.Second)
	appendText("world")
	if got := e.pendingReply(e.engine, line.ID); got.Content != "" || got.Meta.StreamSeq != 0 {
		t.Fatalf("nothing is saved before a threshold: %+v", got)
	}
	c.advance(1500 * time.Millisecond)
	appendText("!")
	saved := e.pendingReply(e.engine, line.ID)
	if saved.Content != "Hello world!" || saved.Meta.StreamSeq == 0 || saved.Status != domain.MessagePending {
		t.Fatalf("the interval saves: %+v", saved)
	}
	tail, _ := e.engine.StreamSince(e.ctx, scopeA, line.ID, saved.Meta.StreamSeq)
	if len(tail.Deltas) != 0 || tail.Truncated {
		t.Fatalf("streamSeq covers every delta so far: %+v", tail)
	}
	appendText(" A sentence that is long.")
	bigger := e.pendingReply(e.engine, line.ID)
	if bigger.Content != "Hello world! A sentence that is long." || bigger.Meta.StreamSeq <= saved.Meta.StreamSeq {
		t.Fatalf("the size threshold saves: %+v", bigger)
	}
	e.events.Reset()
	appendText(" x")
	for _, ev := range e.events.Events() {
		if ev.Type == tangent.EventMessageUpdated {
			t.Fatal("a partial save publishes no message.updated")
		}
	}
	done, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "Hello world! A sentence that is long. x"})
	if err != nil || done.Message.Meta.StreamSeq != 0 || done.Message.Content != "Hello world! A sentence that is long. x" {
		t.Fatalf("completion replaces the partial: %+v %v", done.Message, err)
	}
}

func TestB42_ARestartedProcessCancelsWithTheSavedPartial(t *testing.T) {
	c := newClock()
	e := newEnv(t, tangent.WithClock(c.Now), tangent.WithPartialFlush(time.Second, 1<<20))
	line := e.mainLine()
	turn, _ := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
	_ = e.engine.AppendDelta(e.ctx, turn.ID, text("Saved part.\n"))
	c.advance(2 * time.Second)
	_ = e.engine.AppendDelta(e.ctx, turn.ID, text("More"))
	_ = e.engine.AppendDelta(e.ctx, turn.ID, text(" unsaved"))
	// The process "crashes": another engine over the same database takes over.
	other, err := tangent.New(e.pool, tangent.WithLogger(slog.New(slog.DiscardHandler)), tangent.WithFeatures(tangent.AllFeatures()...))
	if err != nil {
		t.Fatal(err)
	}
	if got := e.pendingReply(other, line.ID); got.Content != "Saved part.\nMore" || got.Status != domain.MessagePending {
		t.Fatalf("the saved partial survives: %+v", got)
	}
	out, err := other.CancelTurn(e.ctx, scopeA, line.ID)
	if err != nil || !out.Cancelled || out.Message.Content != "Saved part.\nMore" || out.Message.Meta.StreamSeq != 0 {
		t.Fatalf("cancel keeps the saved partial: %+v %v", out.Message, err)
	}
}

func TestB42_ACancelKeepsTheFilteredText(t *testing.T) {
	e := newEnv(t)
	line := e.mainLine()
	turn, _ := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
	for _, piece := range []string{"Answer so far.\n[BRANCH-SUGGEST]{\"purpose\":\"p\",\"kind\":\"investigate\"}\n", "half a li", "ne"} {
		_ = e.engine.AppendDelta(e.ctx, turn.ID, text(piece))
	}
	out, err := e.engine.CancelTurn(e.ctx, scopeA, line.ID)
	if err != nil || out.Message.Content != "Answer so far.\nhalf a line" {
		t.Fatalf("cancelled = %q %v", out.Message.Content, err)
	}
	if _, err := e.engine.CompleteTurn(e.ctx, turn.ID, tangent.TurnResult{Content: "late"}); err == nil {
		t.Fatal("a late completion of a cancelled turn is refused")
	}
}

// TestB42_PartialSaveRate measures the saves of a 30 s reply streaming 200
// bytes a second in 20-byte deltas (about 50 tokens a second).
func TestB42_PartialSaveRate(t *testing.T) {
	c := newClock()
	e := newEnv(t, tangent.WithClock(c.Now))
	line := e.mainLine()
	turn, _ := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
	saves, last := 0, int64(0)
	for range 300 {
		c.advance(100 * time.Millisecond)
		_ = e.engine.AppendDelta(e.ctx, turn.ID, text("twenty bytes of tex "))
		if seq := e.pendingReply(e.engine, line.ID).Meta.StreamSeq; seq != last {
			saves, last = saves+1, seq
		}
	}
	t.Logf("a 30 s reply of 6000 bytes: %d partial saves", saves)
	if saves < 14 || saves > 16 {
		t.Fatalf("saves = %d, want one per 2 s", saves)
	}
}

func TestB42_ConcurrentStreamsSaveTheirOwnPartials(t *testing.T) {
	e := newEnv(t, tangent.WithPartialFlush(time.Hour, 8))
	var wg sync.WaitGroup
	for i := range 6 {
		wg.Go(func() {
			line, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{})
			if err != nil {
				t.Error(err)
				return
			}
			turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
			if err != nil {
				t.Error(err)
				return
			}
			want := ""
			for j := range 10 {
				piece := fmt.Sprintf("t%d-%d ", i, j)
				want += piece
				if err := e.engine.AppendDelta(e.ctx, turn.ID, text(piece)); err != nil {
					t.Error(err)
				}
			}
			if got := e.pendingReply(e.engine, line.ID).Content; got != strings.TrimRight(want, " ") {
				t.Errorf("turn %d saved %q", i, got)
			}
		})
	}
	wg.Wait()
}
