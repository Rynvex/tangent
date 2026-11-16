package openai

import (
	"cmp"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/internal/httpstream"
	"github.com/Rynvex/tangent/tangent"
)

// doneData ends a Chat Completions stream.
const doneData = "[DONE]"

type chunk struct {
	Model   string `json:"model"`
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
			Reasoning        string `json:"reasoning"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens        int64 `json:"prompt_tokens"`
		CompletionTokens    int64 `json:"completion_tokens"`
		PromptTokensDetails *struct {
			CachedTokens int64 `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
		PromptCacheHitTokens int64 `json:"prompt_cache_hit_tokens"`
	} `json:"usage"`
	Error json.RawMessage `json:"error"`
}

// accumulator collects a streamed reply.
type accumulator struct {
	model   string
	onDelta func(domain.Delta)
	text    *httpstream.ReplyBuffer
	usage   domain.Usage
	stop    string
	redact  func(string) string
}

func (a *accumulator) event(ev httpstream.SSEEvent) (bool, error) {
	data := strings.TrimSpace(ev.Data)
	if data == doneData {
		return true, nil
	}
	var c chunk
	if err := json.Unmarshal([]byte(data), &c); err != nil {
		return false, fmt.Errorf("openai: %w: %w", httpstream.ErrMalformed, err)
	}
	if len(c.Error) > 0 && string(c.Error) != "null" {
		return false, httpstream.StreamError([]byte(`{"error":`+string(c.Error)+`}`), a.redactor())
	}
	if c.Model != "" {
		a.model = c.Model
	}
	for _, choice := range c.Choices {
		a.emit(domain.DeltaReasoning, cmp.Or(choice.Delta.ReasoningContent, choice.Delta.Reasoning))
		if err := a.text.Add(choice.Delta.Content); err != nil {
			return false, err
		}
		a.emit(domain.DeltaText, choice.Delta.Content)
		if choice.FinishReason != nil && *choice.FinishReason != "" {
			a.stop = *choice.FinishReason
		}
	}
	if u := c.Usage; u != nil {
		a.usage = domain.Usage{InputTokens: u.PromptTokens, OutputTokens: u.CompletionTokens, CacheReadTokens: u.PromptCacheHitTokens}
		if u.PromptTokensDetails != nil && u.PromptTokensDetails.CachedTokens > 0 {
			a.usage.CacheReadTokens = u.PromptTokensDetails.CachedTokens
		}
	}
	return false, nil
}

func (a *accumulator) emit(kind, text string) {
	if text != "" && a.onDelta != nil {
		a.onDelta(domain.Delta{Kind: kind, Text: text})
	}
}

func (a *accumulator) redactor() func(string) string {
	if a.redact == nil {
		return func(s string) string { return s }
	}
	return a.redact
}

func (a *accumulator) result() tangent.RunResult {
	return tangent.RunResult{Content: a.text.String(), Usage: a.usage, StopReason: a.stop, Model: a.model}
}
