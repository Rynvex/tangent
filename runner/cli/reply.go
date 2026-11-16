package cli

import (
	"cmp"
	"errors"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/runner/internal/httpstream"
	"github.com/Rynvex/tangent/tangent"
)

// reply collects a streamed reply; the backends' parsers feed it.
type reply struct {
	model   string
	onDelta func(domain.Delta)
	onRetry func(tangent.Retry)
	text    *httpstream.ReplyBuffer
	limit   int
	usage   domain.Usage
	stop    string
	// failed is a failure the stream reported; done marks the stream's
	// final event (a run without one did not finish).
	failed *failure
	done   bool
}

func newReply(model string, req tangent.RunRequest, maxReply int) *reply {
	return &reply{model: model, onDelta: req.OnDelta, onRetry: req.OnRetry, text: httpstream.NewReplyBuffer(maxReply), limit: replyLimit(maxReply)}
}

// replyLimit is the effective reply bound.
func replyLimit(maxReply int) int { return cmp.Or(max(maxReply, 0), httpstream.DefaultMaxReplyBytes) }

// addText appends reply text and streams it; a reply over the limit stops
// the run.
func (r *reply) addText(text string) error {
	if text == "" {
		return nil
	}
	if err := r.text.Add(text); err != nil {
		if errors.Is(err, httpstream.ErrReplyTooLarge) {
			return &failure{kind: failTooLarge, detail: "the reply passed the limit"}
		}
		return err
	}
	r.emit(domain.DeltaText, text)
	return nil
}

// addReasoning streams a thinking piece (not part of the reply).
func (r *reply) addReasoning(text string) { r.emit(domain.DeltaReasoning, text) }

func (r *reply) emit(kind, text string) {
	if text != "" && r.onDelta != nil {
		r.onDelta(domain.Delta{Kind: kind, Text: text})
	}
}

// setModel records the model the CLI says it ran.
func (r *reply) setModel(model string) { r.model = cmp.Or(model, r.model) }

// fail records the first failure the stream reported.
func (r *reply) fail(kind failureKind, detail string) {
	if r.failed == nil {
		r.failed = &failure{kind: kind, detail: detail}
	}
}

// toolUse stops the run: the CLI offered or called a tool.
func toolUse(detail string) error { return &failure{kind: failToolUse, detail: detail} }

// finish is the run's result, or why it failed.
func (r *reply) finish(content string) (tangent.RunResult, *failure) {
	if r.failed != nil {
		return tangent.RunResult{}, r.failed
	}
	if !r.done {
		return tangent.RunResult{}, &failure{kind: failIncomplete, detail: "the stream ended before its final event"}
	}
	return tangent.RunResult{Content: cmp.Or(content, r.text.String()), Usage: r.usage, StopReason: r.stop, Model: r.model}, nil
}
