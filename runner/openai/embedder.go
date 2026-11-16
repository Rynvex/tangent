package openai

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultEmbedTimeout bounds one embedding call.
const DefaultEmbedTimeout = 30 * time.Second

// embedReplyMaxBytes bounds an embeddings reply.
const embedReplyMaxBytes = 32 << 20

// EmbedderConfig configures an Embedder over an OpenAI-compatible
// /embeddings endpoint. Dim is the vectors' size: it is sent as
// "dimensions" (models that cannot shorten their vectors must be given
// their own size) and every reply is checked against it.
type EmbedderConfig struct {
	BaseURL    string
	APIKey     string
	Model      string
	Dim        int
	Headers    map[string]string
	HTTPClient *http.Client
	Timeout    time.Duration
}

// Embedder is a tangent.Embedder over an OpenAI-compatible endpoint.
type Embedder struct {
	cfg      EmbedderConfig
	endpoint string
	client   *http.Client
}

// NewEmbedder checks the configuration and returns an Embedder.
func NewEmbedder(cfg EmbedderConfig) (*Embedder, error) {
	base := strings.TrimRight(cmp.Or(strings.TrimSpace(cfg.BaseURL), DefaultBaseURL), "/")
	parsed, err := url.Parse(base)
	switch {
	case err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "":
		return nil, errors.New("openai: the base URL must be an http(s) URL")
	case strings.TrimSpace(cfg.Model) == "":
		return nil, errors.New("openai: an embedding model is required")
	case cfg.Dim <= 0:
		return nil, errors.New("openai: the embedding dimension is required")
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: cmp.Or(cfg.Timeout, DefaultEmbedTimeout)}
	}
	return &Embedder{cfg: cfg, endpoint: base + "/embeddings", client: client}, nil
}

// Dim is the size of the vectors.
func (e *Embedder) Dim() int { return e.cfg.Dim }

type embedRequest struct {
	Model      string   `json:"model"`
	Input      []string `json:"input"`
	Dimensions int      `json:"dimensions,omitempty"`
}

type embedReply struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

// Embed returns one vector per text, in the texts' order.
func (e *Embedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return [][]float32{}, nil
	}
	body, _ := json.Marshal(embedRequest{Model: e.cfg.Model, Input: texts, Dimensions: e.cfg.Dim})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("openai embeddings: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if e.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+e.cfg.APIKey)
	}
	for k, v := range e.cfg.Headers {
		req.Header.Set(k, v)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openai embeddings: %s", e.redact(err.Error()))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, embedReplyMaxBytes))
	if err != nil {
		return nil, fmt.Errorf("openai embeddings: read the reply: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("openai embeddings: status %d: %s", resp.StatusCode, e.redact(string(raw)))
	}
	return e.vectors(raw, len(texts))
}

// vectors reads the reply's vectors into the texts' order.
func (e *Embedder) vectors(raw []byte, n int) ([][]float32, error) {
	var reply embedReply
	if err := json.Unmarshal(raw, &reply); err != nil {
		return nil, fmt.Errorf("openai embeddings: the reply is not JSON: %w", err)
	}
	out := make([][]float32, n)
	for _, d := range reply.Data {
		if d.Index < 0 || d.Index >= n || len(d.Embedding) != e.cfg.Dim {
			return nil, fmt.Errorf("openai embeddings: a vector of size %d for text %d (want %d of %d)", len(d.Embedding), d.Index, e.cfg.Dim, n)
		}
		out[d.Index] = d.Embedding
	}
	for i, v := range out {
		if v == nil {
			return nil, fmt.Errorf("openai embeddings: no vector for text %d", i)
		}
	}
	return out, nil
}

// redact keeps the key out of errors.
func (e *Embedder) redact(text string) string {
	if e.cfg.APIKey == "" {
		return text
	}
	return strings.ReplaceAll(text, e.cfg.APIKey, "[redacted]")
}
