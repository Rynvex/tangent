package openai_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/openai"
	"github.com/Rynvex/tangent/tangent"
)

func TestRun_ReasoningModelsGetMaxCompletionTokens(t *testing.T) {
	done := stream(`{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}`, `[DONE]`)
	cases := []struct {
		model, field string
		override     string
	}{
		{"o3-mini", "max_completion_tokens", ""}, {"gpt-5", "max_completion_tokens", ""}, {"openai/o1", "max_completion_tokens", ""},
		{"gpt-4o", "max_tokens", ""}, {"deepseek-chat", "max_tokens", ""}, {"omni", "max_tokens", ""},
		{"gpt-4o", "max_completion_tokens", "max_completion_tokens"},
	}
	for _, c := range cases {
		s := newServer(t, done)
		r := newRunner(t, s, func(cfg *openai.Config) { cfg.MaxTokens, cfg.TokenField = 99, c.override })
		req := request
		req.Model = c.model
		if _, err := r.Run(context.Background(), req); err != nil {
			t.Fatal(err)
		}
		body := <-s.bodies
		other := "max_tokens"
		if c.field == other {
			other = "max_completion_tokens"
		}
		if body[c.field] != float64(99) || body[other] != nil {
			t.Errorf("%s (%q): %v", c.model, c.override, body)
		}
	}
	if _, err := openai.New(openai.Config{TokenField: "max_toks"}); err == nil {
		t.Fatal("an unknown token field is refused")
	}
}

func TestRun_AnExhaustedQuotaIsNotRetried(t *testing.T) {
	s := newServer(t, status(429, nil, `{"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"no"}}`))
	r := newRunner(t, s)
	retries := 0
	req := request
	req.OnRetry = func(tangent.Retry) { retries++ }
	_, err := r.Run(context.Background(), req)
	var public *tangent.RunnerError
	if !errors.As(err, &public) || retries != 0 || s.calls.Load() != 1 {
		t.Fatalf("err %v retries %d calls %d", err, retries, s.calls.Load())
	}
}

func TestRun_OneReasoningFieldOnlyBlankEventsAndHugeReplies(t *testing.T) {
	s := newServer(t, stream(
		`{"choices":[{"delta":{"reasoning_content":"r","reasoning":"r"}}]}`,
		``,
		`{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`, `[DONE]`,
	))
	r := newRunner(t, s)
	var deltas []domain.Delta
	req := request
	req.OnDelta = func(d domain.Delta) { deltas = append(deltas, d) }
	if got, err := r.Run(context.Background(), req); err != nil || got.Content != "ok" {
		t.Fatalf("got %+v err %v", got, err)
	}
	if deltas[0].Text != "r" {
		t.Fatalf("reasoning is not doubled: %q", deltas[0].Text)
	}
	big := newServer(t, stream(`{"choices":[{"delta":{"content":"`+strings.Repeat("x", 64)+`"}}]}`))
	r = newRunner(t, big, func(c *openai.Config) { c.MaxReplyBytes = 32 })
	if _, err := r.Run(context.Background(), request); err == nil || !strings.Contains(err.Error(), "longer than") {
		t.Fatalf("err = %v", err)
	}
}

func TestRun_RedirectsAreNotFollowed(t *testing.T) {
	s := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://example.invalid/steal", http.StatusTemporaryRedirect)
	})
	r := newRunner(t, s, func(c *openai.Config) { c.MaxRetries = -1 })
	if _, err := r.Run(context.Background(), request); err == nil || !strings.Contains(err.Error(), "HTTP 307") {
		t.Fatalf("err = %v", err)
	}
}
