package httpapi_test

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/tangent"
	"github.com/Rynvex/tangent/tangenttest"
)

func TestB41_BodiesMustBeJSON(t *testing.T) {
	h := newHarness(t)
	line := h.line()
	cases := []reqOpt{contentType("text/plain"), contentType("application/x-www-form-urlencoded"), contentType("")}
	for _, opt := range cases {
		h.wantError(h.do(http.MethodPost, "/lines", `{"title":"x"}`, opt), http.StatusUnsupportedMediaType, "unsupported_media_type")
	}
	h.wantError(h.do(http.MethodPost, "/lines/"+line+"/archive", nil, contentType("multipart/form-data; boundary=x")), http.StatusUnsupportedMediaType, "unsupported_media_type")
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines", `{"title":"x"}`, contentType("application/json; charset=utf-8")))
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+line+"/read", nil))
	for _, body := range []string{`{"title":"x"} x`, `{"title":"x"}}`, `{"title":"x"}{}`} {
		h.wantError(h.do(http.MethodPost, "/lines", body), http.StatusBadRequest, "invalid_input")
	}
}

func TestB41_RetryRunsTheFailedTurnAgain(t *testing.T) {
	h := newHarness(t)
	line := h.line()
	h.runner.Queue(tangenttest.Reply{Err: tangenttest.ErrFake})
	first := h.turn(line, "will fail")
	retried := h.ok(http.StatusAccepted, h.do(http.MethodPost, "/lines/"+line+"/retry", nil))
	if retried["turnId"] == first || field(retried, "userMessage", "content") != "will fail" {
		t.Fatalf("retried = %v", retried)
	}
	h.dispatcher.Wait()
	page := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+line+"/messages", nil))
	statuses := []string{}
	for _, m := range page["messages"].([]any) {
		statuses = append(statuses, m.(map[string]any)["role"].(string)+":"+m.(map[string]any)["status"].(string))
	}
	if strings.Join(statuses, ",") != "user:done,assistant:error,assistant:done" {
		t.Fatalf("messages = %v", statuses)
	}
	h.wantError(h.do(http.MethodPost, "/lines/"+line+"/retry", nil), http.StatusConflict, "nothing_to_retry")
}

func TestB41_CapabilitiesSayWhetherTheCallerMayWrite(t *testing.T) {
	h := newHarness(t)
	if body := h.ok(http.StatusOK, h.do(http.MethodGet, "/capabilities", nil)); field(body, "permissions", "canWrite") != true {
		t.Fatalf("writer: %v", body["permissions"])
	}
	if body := h.ok(http.StatusOK, h.do(http.MethodGet, "/capabilities", nil, readOnly())); field(body, "permissions", "canWrite") != false {
		t.Fatalf("viewer: %v", body["permissions"])
	}
}

func TestB41_TooLongAndModelNotAllowedAre422(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		c.engineOpts = append(c.engineOpts, tangent.WithModelCheck(func(provider, model string) bool { return provider == "fake" || provider == "" }))
	})
	r := h.do(http.MethodPost, "/lines", map[string]any{"title": strings.Repeat("t", 201)})
	h.wantError(r, http.StatusUnprocessableEntity, "too_long")
	if body := r.json(t); body["field"] != "title" || body["max"] != float64(200) {
		t.Fatalf("extra = %v", body)
	}
	h.wantError(h.do(http.MethodPost, "/lines", map[string]any{"provider": "openai", "model": "gpt-5"}), http.StatusUnprocessableEntity, "model_not_allowed")
}

func TestB41_ALaggingClientIsToldAndAStuckOneIsDropped(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) {
		c.hubOpts = []httpapi.HubOption{httpapi.WithClientBuffer(2), httpapi.WithWriteTimeout(200 * time.Millisecond)}
	})
	s := h.subscribe(tenantA)
	s.comment(t, "connected")
	// Fill the queue faster than the writer can drain it is racy over TCP,
	// so publish a burst; the reader must see the burst's tail or a lagged
	// notice, and never block the publisher.
	for i := range 200 {
		h.hub.Publish(context.Background(), tangent.Event{Type: "test.burst", Tenant: tenantA, Data: map[string]int{"i": i}})
	}
	sawEnd := false
	deadline := time.After(5 * time.Second)
	for !sawEnd {
		select {
		case ev := <-s.events:
			sawEnd = strings.Contains(ev.data, `"i":199`)
		case <-deadline:
			t.Fatal("the burst's last event never arrived")
		}
	}

	conn := stuckClient(t, h)
	defer conn.Close()
	waitFor(t, func() bool { return h.hub.Clients() == 2 })
	big := strings.Repeat("x", 64<<10)
	deadline = time.After(10 * time.Second)
	for h.hub.Clients() != 1 {
		start := time.Now()
		h.hub.Publish(context.Background(), tangent.Event{Type: "test.big", Tenant: tenantA, Data: big})
		if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
			t.Fatalf("publishing to a stuck client blocked for %v", elapsed)
		}
		select {
		case <-deadline:
			t.Fatal("the stuck client was never dropped")
		case <-s.events: // the healthy client keeps reading
		default:
		}
	}
}

// stuckClient opens /events over raw TCP and never reads after the headers.
func stuckClient(t *testing.T, h *harness) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(h.server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "GET /api/events HTTP/1.1\r\nHost: x\r\n%s: %s\r\n\r\n", headerTenant, tenantA)
	status, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || !strings.Contains(status, "200") {
		t.Fatalf("status %q %v", status, err)
	}
	return conn
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached within 10s")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestB41_StreamsAreCapped(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) { c.hubOpts = []httpapi.HubOption{httpapi.WithMaxStreams(3, 2)} })
	h.subscribe(tenantA).comment(t, "connected")
	h.subscribe(tenantA).comment(t, "connected")
	h.wantError(h.do(http.MethodGet, "/events", nil), http.StatusServiceUnavailable, "unavailable")
	h.subscribe(tenantB).comment(t, "connected")
	h.wantError(h.do(http.MethodGet, "/events", nil, as(tenantOff)), http.StatusServiceUnavailable, "unavailable")
}

func TestB41_ConcurrentPublishingAndSubscribing(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) { c.hubOpts = []httpapi.HubOption{httpapi.WithClientBuffer(4)} })
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Go(func() {
			for j := range 200 {
				h.hub.Publish(context.Background(), tangent.Event{Type: "test.concurrent", Tenant: tenantA, Data: map[string]int{"i": i, "j": j}})
			}
		})
	}
	for range 3 {
		wg.Go(func() {
			s := h.subscribe(tenantA)
			s.comment(t, "connected")
			s.cancel()
			<-s.done
		})
	}
	wg.Wait()
}
