package anthropic

import (
	"cmp"
	"encoding/json"
	"fmt"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/internal/httpstream"
	"github.com/Rynvex/tangent/tangent"
)

// streamEvent is the union of the Messages API stream events tangent reads.
type streamEvent struct {
	Type    string `json:"type"`
	Message struct {
		Model string `json:"model"`
		Usage usage  `json:"usage"`
	} `json:"message"`
	Delta struct {
		Type       string `json:"type"`
		Text       string `json:"text"`
		Thinking   string `json:"thinking"`
		StopReason string `json:"stop_reason"`
	} `json:"delta"`
	Usage *usage `json:"usage"`
}

type usage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
}

// accumulator collects a streamed reply.
type accumulator struct {
	model   string
	onDelta func(domain.Delta)
	redact  func(string) string
	text    *httpstream.ReplyBuffer
	usage   domain.Usage
	stop    string
}

func (a *accumulator) event(ev httpstream.SSEEvent) (bool, error) {
	var e streamEvent
	if err := json.Unmarshal([]byte(ev.Data), &e); err != nil {
		return false, fmt.Errorf("anthropic: %w: %w", httpstream.ErrMalformed, err)
	}
	switch e.Type {
	case "message_start":
		a.start(e)
	case "content_block_delta":
		return false, a.delta(e)
	case "message_delta":
		a.stop = cmp.Or(e.Delta.StopReason, a.stop)
		if e.Usage != nil {
			a.usage.OutputTokens = e.Usage.OutputTokens
		}
	case "message_stop":
		return true, nil
	case "error":
		return false, httpstream.StreamError([]byte(ev.Data), a.redact)
	}
	return false, nil
}

// start records the model and the prompt side of the usage: input_tokens
// excludes the cache buckets, tangent's InputTokens includes them.
func (a *accumulator) start(e streamEvent) {
	if e.Message.Model != "" {
		a.model = e.Message.Model
	}
	u := e.Message.Usage
	a.usage.InputTokens = u.InputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens
	a.usage.CacheReadTokens = u.CacheReadInputTokens
	a.usage.CacheWriteTokens = u.CacheCreationInputTokens
	a.usage.OutputTokens = u.OutputTokens
}

func (a *accumulator) delta(e streamEvent) error {
	switch e.Delta.Type {
	case "text_delta":
		if err := a.text.Add(e.Delta.Text); err != nil {
			return err
		}
		a.emit(domain.DeltaText, e.Delta.Text)
	case "thinking_delta":
		a.emit(domain.DeltaReasoning, e.Delta.Thinking)
	}
	return nil
}

func (a *accumulator) emit(kind, text string) {
	if text != "" && a.onDelta != nil {
		a.onDelta(domain.Delta{Kind: kind, Text: text})
	}
}

func (a *accumulator) result() tangent.RunResult {
	return tangent.RunResult{Content: a.text.String(), Usage: a.usage, StopReason: a.stop, Model: a.model}
}
