package openai_test

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
	"github.com/Rynvex/tangent/runner/openai"
	"github.com/Rynvex/tangent/tangent"
)

const key = "sk-test-secret"

// server answers each request with the next handler (the last repeats) and
// keeps every request body.
type server struct {
	*httptest.Server
	calls  atomic.Int32
	bodies chan map[string]any
	auth   chan string
}

func newServer(t *testing.T, handlers ...http.HandlerFunc) *server {
	t.Helper()
	s := &server{bodies: make(chan map[string]any, 16), auth: make(chan string, 16)}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(s.calls.Add(1)) - 1
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.bodies <- body
		s.auth <- r.Header.Get("Authorization")
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		handlers[min(n, len(handlers)-1)](w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

func stream(lines ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, line := range lines {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", line)
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

func newRunner(t *testing.T, s *server, mutate ...func(*openai.Config)) *openai.Runner {
	t.Helper()
	cfg := openai.Config{BaseURL: s.URL + "/v1", APIKey: key, Model: "gpt-test", RetryBaseDelay: time.Millisecond, IdleTimeout: time.Second}
	for _, m := range mutate {
		m(&cfg)
	}
	r, err := openai.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

var request = tangent.RunRequest{System: "be brief", Messages: []domain.ChatMessage{{Role: "user", Content: "hi"}}}

func TestRun_StreamsTextAndReasoningAndReportsUsage(t *testing.T) {
	s := newServer(t, stream(
		`{"model":"gpt-test-2025","choices":[{"delta":{"role":"assistant","reasoning_content":"thinking"}}]}`,
		`{"choices":[{"delta":{"content":"Hel"}}]}`,
		`{"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}`,
		`{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":100}}}`,
		`[DONE]`,
	))
	r := newRunner(t, s, func(c *openai.Config) { c.MaxTokens = 512 })
	var deltas []domain.Delta
	req := request
	req.OnDelta = func(d domain.Delta) { deltas = append(deltas, d) }
	got, err := r.Run(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.Content != "Hello" || got.StopReason != "stop" || got.Model != "gpt-test-2025" {
		t.Fatalf("result = %+v", got)
	}
	if got.Usage != (domain.Usage{InputTokens: 120, OutputTokens: 7, CacheReadTokens: 100}) {
		t.Fatalf("usage = %+v", got.Usage)
	}
	if len(deltas) != 3 || deltas[0].Kind != domain.DeltaReasoning || deltas[1].Text != "Hel" || deltas[2].Kind != domain.DeltaText {
		t.Fatalf("deltas = %+v", deltas)
	}
	body := <-s.bodies
	messages := body["messages"].([]any)
	first := messages[0].(map[string]any)
	if body["model"] != "gpt-test" || body["stream"] != true || body["max_tokens"] != float64(512) || first["role"] != "system" || len(messages) != 2 {
		t.Fatalf("body = %v", body)
	}
	if opts := body["stream_options"].(map[string]any); opts["include_usage"] != true {
		t.Fatalf("stream_options = %v", opts)
	}
	if auth := <-s.auth; auth != "Bearer "+key {
		t.Fatalf("authorization = %q", auth)
	}
}

func TestRun_TheRequestModelWinsAndDeepSeekCacheHitsCount(t *testing.T) {
	s := newServer(t, stream(
		`{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":1,"prompt_cache_hit_tokens":40}}`,
	))
	r := newRunner(t, s, func(c *openai.Config) { c.APIKey = "" })
	req := request
	req.Model, req.MaxTokens = "deepseek-chat", 64
	got, err := r.Run(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "deepseek-chat" || got.Usage.CacheReadTokens != 40 || got.Content != "x" {
		t.Fatalf("got %+v (a finished reply without [DONE] is complete)", got)
	}
	body := <-s.bodies
	if body["model"] != "deepseek-chat" || body["max_tokens"] != float64(64) {
		t.Fatalf("body = %v", body)
	}
	if auth := <-s.auth; auth != "" {
		t.Fatalf("no key, no header: %q", auth)
	}
}

func TestRun_RetriesARateLimitAndTellsTheEngine(t *testing.T) {
	s := newServer(t, status(429, http.Header{"Retry-After": {"0"}}, `{"error":{"message":"slow down"}}`), stream(`{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`, `[DONE]`))
	r := newRunner(t, s)
	var retries []tangent.Retry
	req := request
	req.OnRetry = func(info tangent.Retry) { retries = append(retries, info) }
	got, err := r.Run(context.Background(), req)
	if err != nil || got.Content != "ok" || len(retries) != 1 || retries[0].Attempt != 1 {
		t.Fatalf("got %+v err %v retries %+v", got, err, retries)
	}
}

func TestRun_FailuresAreOperatorTextsWithoutTheKey(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		want    string
	}{
		{"unauthorized", status(401, nil, `{"error":{"type":"invalid_request_error","message":"Incorrect API key provided: `+key+`"}}`), "refused the credentials"},
		{"bad request", status(400, nil, `{"error":{"message":"no"}}`), "refused the request (HTTP 400)"},
		{"server error", status(503, nil, `oops`), "unavailable (HTTP 503)"},
		{"error event", stream(`{"error":{"type":"server_error","message":"` + key + `"}}`), "stopped the reply (server_error)"},
		{"disconnect", stream(`{"choices":[{"delta":{"content":"par"}}]}`), "ended before the reply was complete"},
		{"garbage", stream(`{not json`), "could not be read"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := newServer(t, c.handler)
			r := newRunner(t, s, func(cfg *openai.Config) { cfg.MaxRetries = -1 })
			_, err := r.Run(context.Background(), request)
			var public *tangent.RunnerError
			if !errors.As(err, &public) || !strings.Contains(public.Public, c.want) {
				t.Fatalf("err = %v, want %q", err, c.want)
			}
			if strings.Contains(err.Error(), key) || strings.Contains(public.Public, key) {
				t.Fatalf("the key leaked: %v", err)
			}
		})
	}
}

func TestRun_CancellingStopsTheStream(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	s := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n")
		w.(http.Flusher).Flush()
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
	stalled := newRunner(t, s, func(c *openai.Config) { c.IdleTimeout = 30 * time.Millisecond })
	if _, err := stalled.Run(context.Background(), request); err == nil || !strings.Contains(err.Error(), "stopped sending") {
		t.Fatalf("a silent stream fails: %v", err)
	}
	timed := newRunner(t, s, func(c *openai.Config) { c.Timeout = 30 * time.Millisecond })
	if _, err := timed.Run(context.Background(), request); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the call timeout ends the run: %v", err)
	}
}

func TestNew_ChecksTheConfig(t *testing.T) {
	if _, err := openai.New(openai.Config{BaseURL: "://bad", Model: "m"}); err == nil {
		t.Fatal("a bad base URL is refused")
	}
	r, err := openai.New(openai.Config{})
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
