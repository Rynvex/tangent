// Package openai runs tangent turns against an OpenAI-compatible Chat
// Completions endpoint (OpenAI, DeepSeek, OpenRouter, Ollama, ...), streamed
// over SSE with net/http only.
package openai

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Rynvex/tangent/runner/internal/httpstream"
	"github.com/Rynvex/tangent/tangent"
)

// DefaultBaseURL is OpenAI's API.
const DefaultBaseURL = "https://api.openai.com/v1"

// DefaultTimeout bounds one call when Config.Timeout is not set.
const DefaultTimeout = 10 * time.Minute

// Config configures a Runner. Only BaseURL and the model have meaning to
// every compatible endpoint; APIKey may be empty (Ollama).
type Config struct {
	// BaseURL is the API root ending before /chat/completions.
	BaseURL string
	// APIKey is sent as a bearer token; it never appears in errors or logs.
	APIKey string
	// Model is used when a request names none.
	Model string
	// MaxTokens is sent when a request sets none (0: not sent).
	MaxTokens int
	// TokenField names the token cap field: "max_tokens" or
	// "max_completion_tokens"; empty picks by model (o-series and gpt-5
	// models take max_completion_tokens).
	TokenField string
	// MaxReplyBytes bounds the reply text (default 1 MiB).
	MaxReplyBytes int
	// HeaderTimeout bounds the wait for response headers with the default
	// client (default 2 minutes).
	HeaderTimeout time.Duration
	// Headers are extra request headers (OpenRouter's HTTP-Referer, ...).
	Headers map[string]string
	// HTTPClient defaults to a client without an overall timeout (streams
	// are long); Timeout and IdleTimeout bound a call instead.
	HTTPClient *http.Client
	// Timeout bounds one call (default 10 minutes); IdleTimeout bounds a
	// silent stream (default 2 minutes).
	Timeout     time.Duration
	IdleTimeout time.Duration
	// MaxRetries for 429 / 5xx (0: the default 3, negative: none) and the
	// backoff's first and longest wait.
	MaxRetries     int
	RetryBaseDelay time.Duration
	RetryMaxDelay  time.Duration
}

// Runner is a tangent.Runner over a Chat Completions endpoint.
type Runner struct {
	cfg      Config
	endpoint string
	client   *http.Client
	redact   func(string) string
}

// New checks the configuration and returns a Runner.
func New(cfg Config) (*Runner, error) {
	base := strings.TrimRight(cmp.Or(strings.TrimSpace(cfg.BaseURL), DefaultBaseURL), "/")
	parsed, err := url.Parse(base)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, errors.New("openai: the base URL must be an http(s) URL")
	}
	client := cfg.HTTPClient
	if client == nil {
		client = httpstream.NewClient(cmp.Or(cfg.HeaderTimeout, httpstream.DefaultHeaderTimeout))
	}
	cfg.Model = strings.TrimSpace(cfg.Model)
	switch cfg.TokenField {
	case "", fieldMaxTokens, fieldMaxCompletionTokens:
	default:
		return nil, errors.New("openai: TokenField must be max_tokens or max_completion_tokens")
	}
	return &Runner{cfg: cfg, endpoint: base + "/chat/completions", client: client, redact: httpstream.Redactor(cfg.APIKey)}, nil
}

// DefaultModel is the model used when a request names none.
func (r *Runner) DefaultModel() string { return r.cfg.Model }

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model         string        `json:"model"`
	Messages      []chatMessage `json:"messages"`
	Stream        bool          `json:"stream"`
	StreamOptions struct {
		IncludeUsage bool `json:"include_usage"`
	} `json:"stream_options"`
	MaxTokens           int `json:"max_tokens,omitempty"`
	MaxCompletionTokens int `json:"max_completion_tokens,omitempty"`
}

// Names of the token cap field.
const (
	fieldMaxTokens           = "max_tokens"
	fieldMaxCompletionTokens = "max_completion_tokens"
)

// tokenField is the field a model takes: o-series reasoning models (o1, o3,
// o4-mini, ...) and gpt-5 models refuse max_tokens. A router prefix such as
// "openai/" is ignored.
func (r *Runner) tokenField(model string) string {
	if r.cfg.TokenField != "" {
		return r.cfg.TokenField
	}
	name := strings.ToLower(model[strings.LastIndex(model, "/")+1:])
	if strings.HasPrefix(name, "gpt-5") || (len(name) > 1 && name[0] == 'o' && name[1] >= '0' && name[1] <= '9') {
		return fieldMaxCompletionTokens
	}
	return fieldMaxTokens
}

// quotaExhausted spots OpenAI's insufficient_quota 429, which a retry
// cannot fix.
func quotaExhausted(status int, body []byte) bool {
	return status == http.StatusTooManyRequests && bytes.Contains(body, []byte("insufficient_quota"))
}

// Run streams one call; text and reasoning pieces go to OnDelta.
func (r *Runner) Run(ctx context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	model := cmp.Or(strings.TrimSpace(req.Model), r.cfg.Model)
	if model == "" {
		return tangent.RunResult{}, &tangent.RunnerError{Public: "no model is configured for this conversation"}
	}
	body, err := json.Marshal(r.body(model, req))
	if err != nil {
		return tangent.RunResult{}, fmt.Errorf("openai: encode the request: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, cmp.Or(r.cfg.Timeout, DefaultTimeout))
	defer cancel()
	acc := &accumulator{model: model, onDelta: req.OnDelta, redact: r.redact, text: httpstream.NewReplyBuffer(r.cfg.MaxReplyBytes)}
	call := httpstream.Call{
		Client: r.client, URL: r.endpoint, Header: r.header(), Body: body, Idle: r.cfg.IdleTimeout, Redact: r.redact, OnRetry: req.OnRetry,
		Policy: httpstream.Policy{MaxRetries: r.cfg.MaxRetries, BaseDelay: r.cfg.RetryBaseDelay, MaxDelay: r.cfg.RetryMaxDelay, NoRetry: quotaExhausted},
	}
	err = call.Stream(ctx, acc.event)
	if errors.Is(err, httpstream.ErrEarlyEnd) && acc.stop != "" {
		err = nil // finished, only the closing [DONE] is missing
	}
	if err != nil {
		return tangent.RunResult{}, httpstream.Public(err)
	}
	return acc.result(), nil
}

func (r *Runner) body(model string, req tangent.RunRequest) chatRequest {
	messages := make([]chatMessage, 0, len(req.Messages)+1)
	if strings.TrimSpace(req.System) != "" {
		messages = append(messages, chatMessage{Role: "system", Content: req.System})
	}
	for _, m := range req.Messages {
		messages = append(messages, chatMessage{Role: m.Role, Content: m.Content})
	}
	out := chatRequest{Model: model, Messages: messages, Stream: true}
	if limit := cmp.Or(req.MaxTokens, r.cfg.MaxTokens); r.tokenField(model) == fieldMaxCompletionTokens {
		out.MaxCompletionTokens = limit
	} else {
		out.MaxTokens = limit
	}
	out.StreamOptions.IncludeUsage = true
	return out
}

func (r *Runner) header() http.Header {
	header := http.Header{}
	for name, value := range r.cfg.Headers {
		header.Set(name, value)
	}
	if r.cfg.APIKey != "" {
		header.Set("Authorization", "Bearer "+r.cfg.APIKey)
	}
	return header
}
