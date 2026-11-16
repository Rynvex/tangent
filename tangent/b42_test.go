package tangent_test

import (
	"strings"
	"sync"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

// streamed joins the text deltas published for a turn and checks their
// seqs only grow.
func streamed(t *testing.T, events []tangent.Event, turnID string) string {
	t.Helper()
	var b strings.Builder
	last := int64(0)
	for _, ev := range events {
		d, ok := ev.Data.(domain.Delta)
		if ev.Type != tangent.EventMessageDelta || !ok || d.TurnID != turnID {
			continue
		}
		if d.Seq <= last {
			t.Errorf("seq %d after %d", d.Seq, last)
		}
		last = d.Seq
		b.WriteString(d.Text)
	}
	return b.String()
}

func TestB42_StreamedTextLeavesMarkerLinesOutAndMatchesTheStoredReply(t *testing.T) {
	e := newEnv(t, tangent.WithExtraMarkers("[NEEDS-INPUT]"))
	line := e.mainLine()
	e.runner.Queue(tangenttest.Reply{Chunks: []string{
		"Here is the plan.\n[1] source one\n[BRAN", "CH-SUGGEST]{\"purpose\":\"Check the", " budget\",\"kind\":\"investigate\"}\n",
		"[NEEDS-INPUT] secret\n", "Done.\n  [BRANCH-SUGGEST]{\"purpose\":\"Last\",\"kind\":\"alternative\"}",
	}})
	turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "plan it"})
	if err != nil {
		t.Fatal(err)
	}
	done, err := e.engine.RunTurn(e.ctx, turn, e.runner)
	if err != nil {
		t.Fatal(err)
	}
	got := streamed(t, e.events.Events(), turn.ID)
	if strings.Contains(got, "BRANCH-SUGGEST") || strings.Contains(got, "NEEDS-INPUT") {
		t.Fatalf("a marker line was streamed: %q", got)
	}
	if want := "Here is the plan.\n[1] source one\nDone."; got != want {
		t.Fatalf("streamed %q, want %q", got, want)
	}
	if len(done.Message.Meta.Suggestions) != 2 {
		t.Fatalf("parsing at completion is unchanged: %+v", done.Message.Meta.Suggestions)
	}
	tail, err := e.engine.StreamSince(e.ctx, scopeA, line.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var fromTail strings.Builder
	for _, d := range tail.Deltas {
		fromTail.WriteString(d.Text)
	}
	if fromTail.String() != got {
		t.Fatalf("/stream %q differs from the events %q", fromTail.String(), got)
	}
}

func TestB42_StreamsMatchTheStoredReplyWithoutMarkersToo(t *testing.T) {
	e := newEnv(t)
	line := e.mainLine()
	e.runner.Queue(tangenttest.Reply{Chunks: []string{"\n Plain ", "answer\n\n", "second paragraph  \n\n  "}})
	turn, _ := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
	done, err := e.engine.RunTurn(e.ctx, turn, e.runner)
	if err != nil {
		t.Fatal(err)
	}
	if got := streamed(t, e.events.Events(), turn.ID); got != done.Message.Content {
		t.Fatalf("streamed %q, stored %q", got, done.Message.Content)
	}
}

func TestB42_ConcurrentTurnsKeepTheirOwnFilters(t *testing.T) {
	e := newEnv(t)
	var wg sync.WaitGroup
	for i := range 6 {
		wg.Go(func() {
			line, err := e.engine.CreateLine(e.ctx, scopeA, tangent.LineInput{})
			if err != nil {
				t.Error(err)
				return
			}
			runner := tangenttest.NewFakeRunner(tangenttest.Reply{Chunks: []string{"line ", string(rune('a' + i)), "\n[BRANCH-SUG", "GEST]{}\nend"}})
			turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
			if err != nil {
				t.Error(err)
				return
			}
			if _, err := e.engine.RunTurn(e.ctx, turn, runner); err != nil {
				t.Error(err)
			}
			if got := streamed(t, e.events.Events(), turn.ID); got != "line "+string(rune('a'+i))+"\nend" {
				t.Errorf("turn %d streamed %q", i, got)
			}
		})
	}
	wg.Wait()
}

func TestB42_TheHeldEndOfTheLastLineIsFlushedAtCompletion(t *testing.T) {
	e := newEnv(t)
	line := e.mainLine()
	e.runner.Queue(tangenttest.Reply{Chunks: []string{"See\n", "[BRANCH"}})
	turn, _ := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
	done, err := e.engine.RunTurn(e.ctx, turn, e.runner)
	if err != nil {
		t.Fatal(err)
	}
	if got := streamed(t, e.events.Events(), turn.ID); got != "See\n[BRANCH" || done.Message.Content != got {
		t.Fatalf("streamed %q, stored %q", got, done.Message.Content)
	}
}

func TestR1_ACancelRacingAppendsLeavesNoStreamBehind(t *testing.T) {
	e := newEnv(t)
	line := e.mainLine()
	for range 20 {
		turn, err := e.engine.BeginTurn(e.ctx, scopeA, line.ID, tangent.TurnInput{Content: "q"})
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		wg.Go(func() {
			for range 50 {
				_ = e.engine.AppendDelta(e.ctx, turn.ID, domain.Delta{Kind: domain.DeltaText, Text: "word "})
			}
		})
		wg.Go(func() {
			if _, err := e.engine.CancelTurn(e.ctx, scopeA, line.ID); err != nil {
				t.Error(err)
			}
		})
		wg.Wait()
		if n := e.engine.OpenStreams(); n != 0 {
			t.Fatalf("%d stream(s) left after the cancel", n)
		}
	}
}
