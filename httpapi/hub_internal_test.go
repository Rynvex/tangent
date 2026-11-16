package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestClient_AFullQueueDropsItsOldestMessage(t *testing.T) {
	c := &client{send: make(chan queued, 2)}
	for _, m := range []string{"a", "b", "c", "d"} {
		c.offer(queued{message: []byte(m)})
	}
	if got := string((<-c.send).message) + string((<-c.send).message); got != "cd" {
		t.Fatalf("kept %q, want the newest two", got)
	}
	if c.dropped.Load() != 2 {
		t.Fatalf("dropped = %d", c.dropped.Load())
	}
}

// recordingWriter keeps what a stream writes.
type recordingWriter struct {
	header http.Header
	body   strings.Builder
}

func (w *recordingWriter) Header() http.Header         { return w.header }
func (w *recordingWriter) Write(p []byte) (int, error) { return w.body.Write(p) }
func (w *recordingWriter) WriteHeader(int)             {}
func (w *recordingWriter) Flush()                      {}

func TestStream_TellsALaggingClientAndEndsAPersistentOne(t *testing.T) {
	now := time.Unix(0, 0)
	h := NewHub(WithMaxLag(time.Minute))
	h.now = func() time.Time { return now }
	w := &recordingWriter{header: http.Header{}}
	s := &stream{h: h, w: w, controller: http.NewResponseController(w), tenant: "t"}
	c := &client{send: make(chan queued, 1)}
	c.offer(queued{message: []byte("a")})
	c.offer(queued{message: []byte("b")})
	if !s.caughtUp(c) || !strings.Contains(w.body.String(), "event: stream.lagged") || !strings.Contains(w.body.String(), `"dropped":1`) {
		t.Fatalf("notice: %q", w.body.String())
	}
	now = now.Add(30 * time.Second)
	c.offer(queued{message: []byte("c")})
	if !s.caughtUp(c) {
		t.Fatal("still within the allowed lag")
	}
	now = now.Add(31 * time.Second)
	c.offer(queued{message: []byte("d")})
	if s.caughtUp(c) {
		t.Fatal("losing events for over a minute ends the stream")
	}
	<-c.send
	s.lagSince = time.Time{}
	if !s.caughtUp(c) || !s.lagSince.IsZero() {
		t.Fatal("a drained queue without drops resets the lag")
	}
}

func TestHub_AFilteredClientGetsDeltasAsItsFilterLeavesThem(t *testing.T) {
	h := NewHub(WithHubLogger(slog.New(slog.DiscardHandler)))
	hide := deltaFilter(func(_ string, d domain.Delta) (domain.Delta, bool) {
		if d.Kind == domain.DeltaTool {
			return d, false
		}
		d.Text = strings.ToUpper(d.Text)
		return d, true
	})
	plain, err := h.add("t", nil)
	if err != nil {
		t.Fatal(err)
	}
	filtered, err := h.add("t", hide)
	if err != nil {
		t.Fatal(err)
	}
	publish := func(data any) {
		h.Publish(context.Background(), tangent.Event{Type: tangent.EventMessageDelta, Tenant: "t", LineID: "l", Data: data})
	}
	publish(domain.Delta{TurnID: "turn", Seq: 7, Kind: domain.DeltaText, Text: "hi"})
	publish(json.RawMessage(`{"turnId":"turn","seq":8,"kind":"tool","text":"secret"}`))
	publish(map[string]any{"turnId": "turn", "seq": 9, "kind": "reasoning", "text": "relayed"})
	publish([]int{1, 2}) // not a delta
	h.Publish(context.Background(), tangent.Event{Type: tangent.EventLineUpdated, Tenant: "t", LineID: "l", Data: map[string]any{"id": "l"}})

	drain := func(c *client) []string {
		out := []string{}
		for len(c.send) > 0 {
			if message := h.render(c, <-c.send); message != nil {
				out = append(out, string(message))
			}
		}
		return out
	}
	if got := drain(plain); len(got) != 5 || !strings.Contains(got[1], "secret") || !strings.Contains(got[3], "[1,2]") {
		t.Fatalf("an unfiltered client gets everything as published: %q", got)
	}
	got := drain(filtered)
	if len(got) != 3 || !strings.Contains(got[0], `"text":"HI"`) || !strings.Contains(got[0], `"seq":7`) ||
		!strings.Contains(got[1], `"text":"RELAYED"`) || !strings.Contains(got[2], "event: line.updated") {
		t.Fatalf("filtered client got %q", got)
	}
	for _, message := range got {
		if strings.Contains(message, "secret") || strings.Contains(message, "[1,2]") {
			t.Fatalf("a dropped or undecodable delta reached the filtered client: %q", message)
		}
	}
}
