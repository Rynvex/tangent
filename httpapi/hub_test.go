package httpapi_test

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/tangent"
)

// sseEvent is one event read from /events.
type sseEvent struct {
	name, data string
}

// subscription reads /events in the background.
type subscription struct {
	events   chan sseEvent
	comments chan string
	done     chan struct{}
	cancel   context.CancelFunc
}

func (h *harness) subscribe(tenant string, opts ...reqOpt) *subscription {
	h.t.Helper()
	ctx, cancel := context.WithCancel(h.ctx)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.server.URL+"/api/events", nil)
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set(headerTenant, tenant)
	for _, opt := range opts {
		opt(req)
	}
	resp, err := h.server.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "text/event-stream" {
		h.t.Fatalf("events: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	s := &subscription{events: make(chan sseEvent, 64), comments: make(chan string, 64), done: make(chan struct{}), cancel: cancel}
	go s.read(ctx, resp)
	h.t.Cleanup(cancel)
	return s
}

// read parses the stream; it stops when the subscription is cancelled, even
// while nobody takes its events.
func (s *subscription) read(ctx context.Context, resp *http.Response) {
	defer close(s.done)
	defer resp.Body.Close()
	scanner := bufio.NewScanner(resp.Body)
	var ev sseEvent
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, ":"):
			if !deliver(ctx, s.comments, strings.TrimSpace(line[1:])) {
				return
			}
		case strings.HasPrefix(line, "event: "):
			ev.name = line[len("event: "):]
		case strings.HasPrefix(line, "data: "):
			ev.data = line[len("data: "):]
		case line == "" && ev.name != "":
			if !deliver(ctx, s.events, ev) {
				return
			}
			ev = sseEvent{}
		}
	}
}

func (s *subscription) next(t *testing.T) sseEvent {
	t.Helper()
	select {
	case ev := <-s.events:
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("no event within 5s")
		return sseEvent{}
	}
}

func (s *subscription) comment(t *testing.T, want string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case got := <-s.comments:
			if got == want {
				return
			}
		case <-deadline:
			t.Fatalf("no %q comment within 5s", want)
		}
	}
}

func TestHub_EachTenantGetsItsOwnEventsAsNamedSSE(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		c.hubOpts = []httpapi.HubOption{httpapi.WithKeepalive(20 * time.Millisecond), httpapi.WithClientBuffer(8), httpapi.WithHubLogger(slog.New(slog.DiscardHandler))}
	})
	a, b := h.subscribe(tenantA), h.subscribe(tenantB)
	a.comment(t, "connected")
	b.comment(t, "connected")
	if h.hub.Clients() != 2 {
		t.Fatalf("clients = %d", h.hub.Clients())
	}
	line := h.line()
	ev := a.next(t)
	var envelope tangent.Event
	if err := json.Unmarshal([]byte(ev.data), &envelope); err != nil {
		t.Fatal(err)
	}
	if ev.name != tangent.EventLineCreated || envelope.Type != ev.name || envelope.LineID != line || envelope.Tenant != tenantA {
		t.Fatalf("event %s %s", ev.name, ev.data)
	}
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines", map[string]any{"title": "b"}, as(tenantB)))
	if got := b.next(t); !strings.Contains(got.data, `"tenant":"tenant-b"`) {
		t.Fatalf("B got %s", got.data)
	}
	select {
	case leaked := <-a.events:
		t.Fatalf("A received B's event: %s", leaked.data)
	default:
	}
	a.comment(t, "keepalive")
}

func TestHub_CloseEndsTheStreamsAndRefusesNewOnes(t *testing.T) {
	h := newHarness(t)
	s := h.subscribe(tenantA)
	s.comment(t, "connected")
	h.hub.Close()
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream did not end")
	}
	h.wantError(h.do(http.MethodGet, "/events", nil), http.StatusServiceUnavailable, "unavailable")
	h.hub.Close() // twice is fine
	if h.hub.Clients() != 0 {
		t.Fatalf("clients = %d", h.hub.Clients())
	}
}

func deliver[T any](ctx context.Context, ch chan T, v T) bool {
	select {
	case ch <- v:
		return true
	case <-ctx.Done():
		return false
	}
}
