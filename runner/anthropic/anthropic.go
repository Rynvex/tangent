// Package anthropic runs tangent turns against the Anthropic Messages API,
// streamed over SSE with net/http only. The system prompt (the stable
// prefix: rules, pack, notes, host sections) and the newest message are
// marked with cache_control so consecutive turns read the prompt cache.
package anthropic

import (
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

// Defaults of a Config.
const (
	DefaultBaseURL   = "https://api.anthropic.com"
	DefaultVersion   = "2023-06-01"
	DefaultMaxTokens = 4096
	DefaultTimeout   = 10 * time.Minute
)

// Config configures a Runner.
type Config struct {
	// BaseURL is the API root (default https://api.anthropic.com).
	BaseURL string
	// APIKey is required; it never appears in errors or logs.
	APIKey string
	// Version is the anthropic-version header (default 2023-06-01).
	Version string
	// Model is used when a request names none.
	Model string
	// MaxTokens is used when a request sets none (default 4096).
	MaxTokens int
	// DisableCache leaves out every cache_control breakpoint.
	DisableCache bool
	// MaxReplyBytes bounds the reply text (default 1 MiB).
	MaxReplyBytes int
	// HeaderTimeout bounds the wait for response headers with the default
	// client (default 2 minutes).
	HeaderTimeout time.Duration
	// HTTPClient defaults to a client without an overall timeout; Timeout
	// (default 10 minutes) and IdleTimeout (default 2 minutes) bound a call.
	HTTPClient  *http.Client
	Timeout     time.Duration
	IdleTimeout time.Duration
	// MaxRetries for 429 / 5xx (0: the default 3, negative: none) and the
	// backoff's first and longest wait.
	MaxRetries     int
	RetryBaseDelay time.Duration
	RetryMaxDelay  time.Duration
}

// statusOverloaded is Anthropic's "overloaded" answer, retried like a 503.
const statusOverloaded = 529

// Runner is a tangent.Runner over the Messages API.
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
		return nil, errors.New("anthropic: the base URL must be an http(s) URL")
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, errors.New("anthropic: an API key is required")
	}
	client := cfg.HTTPClient
	if client == nil {
		client = httpstream.NewClient(cmp.Or(cfg.HeaderTimeout, httpstream.DefaultHeaderTimeout))
	}
	cfg.Model = strings.TrimSpace(cfg.Model)
	cfg.Version = cmp.Or(strings.TrimSpace(cfg.Version), DefaultVersion)
	return &Runner{cfg: cfg, endpoint: base + "/v1/messages", client: client, redact: httpstream.Redactor(cfg.APIKey)}, nil
}

// DefaultModel is the model used when a request names none.
func (r *Runner) DefaultModel() string { return r.cfg.Model }

// Run streams one call; text and thinking pieces go to OnDelta.
func (r *Runner) Run(ctx context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	model := cmp.Or(strings.TrimSpace(req.Model), r.cfg.Model)
	if model == "" {
		return tangent.RunResult{}, &tangent.RunnerError{Public: "no model is configured for this conversation"}
	}
	body, err := json.Marshal(r.body(model, req))
	if err != nil {
		return tangent.RunResult{}, fmt.Errorf("anthropic: encode the request: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, cmp.Or(r.cfg.Timeout, DefaultTimeout))
	defer cancel()
	acc := &accumulator{model: model, onDelta: req.OnDelta, redact: r.redact, text: httpstream.NewReplyBuffer(r.cfg.MaxReplyBytes)}
	call := httpstream.Call{
		Client: r.client, URL: r.endpoint, Header: r.header(), Body: body, Idle: r.cfg.IdleTimeout, Redact: r.redact, OnRetry: req.OnRetry,
		Policy: httpstream.Policy{
			MaxRetries: r.cfg.MaxRetries, BaseDelay: r.cfg.RetryBaseDelay, MaxDelay: r.cfg.RetryMaxDelay, ExtraRetryable: []int{statusOverloaded},
		},
	}
	if err := call.Stream(ctx, acc.event); err != nil {
		return tangent.RunResult{}, httpstream.Public(err)
	}
	return acc.result(), nil
}

func (r *Runner) header() http.Header {
	header := http.Header{}
	header.Set("x-api-key", r.cfg.APIKey)
	header.Set("anthropic-version", r.cfg.Version)
	return header
}

type cacheControl struct {
	Type string `json:"type"`
}

type textBlock struct {
	Type         string        `json:"type"`
	Text         string        `json:"text"`
	CacheControl *cacheControl `json:"cache_control,omitempty"`
}

type message struct {
	Role    string      `json:"role"`
	Content []textBlock `json:"content"`
}

type messagesRequest struct {
	Model     string      `json:"model"`
	MaxTokens int         `json:"max_tokens"`
	Stream    bool        `json:"stream"`
	System    []textBlock `json:"system,omitempty"`
	Messages  []message   `json:"messages"`
}

// body builds the request: the system prompt as blocks with a cache
// breakpoint after the last stable block (rules, pack, notes, host
// sections), then the messages with a breakpoint on the newest one, so the
// next turn reads everything before its own message from the cache. A
// request without SystemBlocks sends System as one cached block.
func (r *Runner) body(model string, req tangent.RunRequest) messagesRequest {
	out := messagesRequest{
		Model: model, Stream: true, MaxTokens: cmp.Or(req.MaxTokens, r.cfg.MaxTokens, DefaultMaxTokens),
		Messages: make([]message, 0, len(req.Messages)), System: r.system(req),
	}
	for _, m := range req.Messages {
		out.Messages = append(out.Messages, message{Role: m.Role, Content: []textBlock{{Type: "text", Text: m.Content}}})
	}
	if n := len(out.Messages); n > 0 {
		out.Messages[n-1].Content[0].CacheControl = r.breakpoint()
	}
	return out
}

// system renders the system blocks; the breakpoint goes on the last stable
// one (or the only one).
func (r *Runner) system(req tangent.RunRequest) []textBlock {
	blocks := req.SystemBlocks
	if len(blocks) == 0 {
		if strings.TrimSpace(req.System) == "" {
			return nil
		}
		blocks = []tangent.SystemBlock{{Text: req.System, Stable: true}}
	}
	out := make([]textBlock, 0, len(blocks))
	cacheAt := -1
	for _, b := range blocks {
		if strings.TrimSpace(b.Text) == "" {
			continue
		}
		out = append(out, textBlock{Type: "text", Text: b.Text})
		if b.Stable {
			cacheAt = len(out) - 1
		}
	}
	if cacheAt >= 0 {
		out[cacheAt].CacheControl = r.breakpoint()
	}
	return out
}

func (r *Runner) breakpoint() *cacheControl {
	if r.cfg.DisableCache {
		return nil
	}
	return &cacheControl{Type: "ephemeral"}
}
