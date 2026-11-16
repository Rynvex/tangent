package anthropic_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/anthropic"
	"github.com/Rynvex/tangent/tangent"
)

const key = "sk-ant-secret"

type server struct {
	*httptest.Server
	calls   atomic.Int32
	bodies  chan map[string]any
	headers chan http.Header
}

func newServer(t *testing.T, handlers ...http.HandlerFunc) *server {
	t.Helper()
	s := &server{bodies: make(chan map[string]any, 16), headers: make(chan http.Header, 16)}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(s.calls.Add(1)) - 1
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.bodies <- body
		s.headers <- r.Header.Clone()
		if r.URL.Path != "/v1/messages" {
			http.NotFound(w, r)
			return
		}
		handlers[min(n, len(handlers)-1)](w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

// event is one named SSE event.
type event struct{ name, data string }

func stream(events ...event) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, ev := range events {
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.name, ev.data)
			w.(http.Flusher).Flush()
		}
	}
}

func status(code int, header http.Header, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		for k, v := range header {
			w.Header()[k] = v
		}
		w.WriteHeader(code)
		_, _ = io.WriteString(w, body)
	}
}

func newRunner(t *testing.T, s *server, mutate ...func(*anthropic.Config)) *anthropic.Runner {
	t.Helper()
	cfg := anthropic.Config{BaseURL: s.URL, APIKey: key, Model: "claude-test", RetryBaseDelay: time.Millisecond, IdleTimeout: time.Second}
	for _, m := range mutate {
		m(&cfg)
	}
	r, err := anthropic.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

var request = tangent.RunRequest{
	System: "stable rules", Messages: []domain.ChatMessage{{Role: "user", Content: "q1"}, {Role: "assistant", Content: "a1"}, {Role: "user", Content: "q2"}},
}

var happy = []event{
	{"message_start", `{"type":"message_start","message":{"model":"claude-test-2025","usage":{"input_tokens":20,"cache_creation_input_tokens":300,"cache_read_input_tokens":1000,"output_tokens":1}}}`},
	{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`},
	{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}`},
	{"ping", `{"type":"ping"}`},
	{"content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}`},
	{"content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}`},
	{"content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}`},
	{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}`},
	{"message_stop", `{"type":"message_stop"}`},
}

func TestRun_StreamsAndReportsCacheUsage(t *testing.T) {
	s := newServer(t, stream(happy...))
	r := newRunner(t, s)
	var deltas []domain.Delta
	req := request
	req.OnDelta = func(d domain.Delta) { deltas = append(deltas, d) }
	got, err := r.Run(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	want := domain.Usage{InputTokens: 1320, OutputTokens: 9, CacheReadTokens: 1000, CacheWriteTokens: 300}
	if got.Content != "Hello" || got.StopReason != "end_turn" || got.Model != "claude-test-2025" || got.Usage != want {
		t.Fatalf("result = %+v", got)
	}
	if len(deltas) != 3 || deltas[0].Kind != domain.DeltaReasoning || deltas[0].Text != "hmm" || deltas[2].Text != "lo" {
		t.Fatalf("deltas = %+v", deltas)
	}
	header := <-s.headers
	if header.Get("x-api-key") != key || header.Get("anthropic-version") != anthropic.DefaultVersion || header.Get("Authorization") != "" {
		t.Fatalf("headers = %v", header)
	}
	body := <-s.bodies
	if body["model"] != "claude-test" || body["stream"] != true || body["max_tokens"] != float64(anthropic.DefaultMaxTokens) {
		t.Fatalf("body = %v", body)
	}
	system := body["system"].([]any)[0].(map[string]any)
	if system["text"] != "stable rules" || system["cache_control"].(map[string]any)["type"] != "ephemeral" {
		t.Fatalf("the stable system prefix carries cache_control: %v", system)
	}
	messages := body["messages"].([]any)
	last := messages[2].(map[string]any)["content"].([]any)[0].(map[string]any)
	first := messages[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	if last["cache_control"] == nil || first["cache_control"] != nil || last["text"] != "q2" {
		t.Fatalf("only the newest message is a cache breakpoint: %v", messages)
	}
}

func TestRun_CachingCanBeTurnedOffAndTheRequestModelWins(t *testing.T) {
	s := newServer(t, stream(happy...))
	r := newRunner(t, s, func(c *anthropic.Config) { c.DisableCache, c.MaxTokens = true, 1000 })
	req := tangent.RunRequest{Model: "claude-other", MaxTokens: 77, Messages: []domain.ChatMessage{{Role: "user", Content: "q"}}}
	if _, err := r.Run(context.Background(), req); err != nil {
		t.Fatal(err)
	}
	body := <-s.bodies
	if body["model"] != "claude-other" || body["max_tokens"] != float64(77) || body["system"] != nil {
		t.Fatalf("body = %v", body)
	}
	if strings.Contains(fmt.Sprint(body), "cache_control") {
		t.Fatalf("no cache_control when disabled: %v", body)
	}
}

func TestRun_RetriesOverloadAndTellsTheEngine(t *testing.T) {
	s := newServer(t, status(529, http.Header{"Retry-After": {"0"}}, `{"type":"error","error":{"type":"overloaded_error","message":"busy"}}`), stream(happy...))
	r := newRunner(t, s)
	retries := 0
	req := request
	req.OnRetry = func(tangent.Retry) { retries++ }
	if got, err := r.Run(context.Background(), req); err != nil || got.Content != "Hello" || retries != 1 {
		t.Fatalf("got %+v err %v retries %d", got, err, retries)
	}
}

func TestRun_FailuresAreOperatorTextsWithoutTheKey(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		want    string
	}{
		{"unauthorized", status(401, nil, `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key `+key+`"}}`), "refused the credentials"},
		{"rate limited", status(429, nil, `{}`), "rate limiting"},
		{"error event", stream(event{"error", `{"type":"error","error":{"type":"overloaded_error","message":"` + key + `"}}`}), "stopped the reply (overloaded_error)"},
		{"disconnect", stream(happy[:5]...), "ended before the reply was complete"},
		{"garbage", stream(event{"content_block_delta", `{oops`}), "could not be read"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := newServer(t, c.handler)
			r := newRunner(t, s, func(cfg *anthropic.Config) { cfg.MaxRetries = -1 })
			_, err := r.Run(context.Background(), request)
			var public *tangent.RunnerError
			if !errors.As(err, &public) || !strings.Contains(public.Public, c.want) {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if strings.Contains(err.Error(), key) {
				t.Fatalf("the key leaked: %v", err)
			}
		})
	}
}

func TestRun_CancellingStopsTheStream(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	s := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		stream(happy[:5]...)(w, r)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	})
	r := newRunner(t, s)
	ctx, cancel := context.WithCancel(context.Background())
	req := request
	req.OnDelta = func(domain.Delta) { cancel() }
	if _, err := r.Run(ctx, req); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestNew_ChecksTheConfig(t *testing.T) {
	if _, err := anthropic.New(anthropic.Config{BaseURL: "ftp://x", APIKey: key}); err == nil {
		t.Fatal("a bad base URL is refused")
	}
	if _, err := anthropic.New(anthropic.Config{}); err == nil {
		t.Fatal("the API key is required")
	}
	r, err := anthropic.New(anthropic.Config{APIKey: key})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Run(context.Background(), request); err == nil || !strings.Contains(err.Error(), "model") {
		t.Fatalf("a run without any model is refused: %v", err)
	}
	if r.DefaultModel() != "" {
		t.Fatal("no default model")
	}
}
