package cli

import (
	"fmt"
	"strings"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// claudeBackend runs Claude Code headless (`claude -p`):
//
//	-p --output-format stream-json --verbose --include-partial-messages
//	   stream every event as one JSON line, with token deltas
//	--tools ""                       no built-in tools
//	--strict-mcp-config              no MCP server but --mcp-config's (none)
//	--safe-mode                      no CLAUDE.md, skills, plugins, hooks, MCP
//	--disable-slash-commands         no skills or commands
//	--permission-mode dontAsk        anything that would ask is denied
//	--no-session-persistence         no transcript saved to disk
//	--system-prompt-file <file>      tangent's system prompt replaces Claude
//	                                 Code's coding-agent prompt
//	--model <model>                  when one is set
//	--effort <level>                 when the request asks for a reasoning
//	                                 effort Claude Code knows (claudeEffort)
//
// The conversation goes on stdin. A run whose init event still lists a tool
// is killed.
var claudeBackend = backend{
	display: "Claude Code",
	env:     []string{"CLAUDE_CONFIG_DIR"},
	prepare: func(dir runDir, model string, req tangent.RunRequest) (invocation, error) {
		system, err := dir.file("system-prompt.md", systemText(req))
		if err != nil {
			return invocation{}, err
		}
		args := []string{
			"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
			"--tools", "", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands",
			"--permission-mode", "dontAsk", "--no-session-persistence", "--system-prompt-file", system,
		}
		args = withEffort(withModel(args, "--model", model), "--effort", claudeEffort(req.ReasoningEffort))
		return invocation{args: args, stdin: transcript(req.Messages)}, nil
	},
	parser: func(r *reply) parser { return &claudeParser{reply: r} },
}

// claudeEvent is the union of the stream-json lines tangent reads (the
// Agent SDK's SDKMessage types).
type claudeEvent struct {
	Type            string         `json:"type"`
	Subtype         string         `json:"subtype"`
	Model           string         `json:"model"`
	Tools           []string       `json:"tools"`
	ParentToolUseID *string        `json:"parent_tool_use_id"`
	Event           *anthropicPart `json:"event"`
	Message         *struct {
		Model   string `json:"model"`
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"content"`
	} `json:"message"`
	Error          string       `json:"error"`
	IsError        bool         `json:"is_error"`
	Result         string       `json:"result"`
	Errors         []string     `json:"errors"`
	APIErrorStatus int          `json:"api_error_status"`
	StopReason     string       `json:"stop_reason"`
	Usage          *claudeUsage `json:"usage"`
	// api_retry
	Attempt      int   `json:"attempt"`
	MaxRetries   int   `json:"max_retries"`
	RetryDelayMs int64 `json:"retry_delay_ms"`
}

// anthropicPart is a raw Messages API stream event (stream_event.event).
type anthropicPart struct {
	Type  string `json:"type"`
	Delta struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		Thinking string `json:"thinking"`
	} `json:"delta"`
}

type claudeUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
}

type claudeParser struct {
	*reply
	partial bool   // token deltas arrive as stream_event lines
	result  string // the result event's text
}

func (p *claudeParser) line(raw []byte) error {
	var e claudeEvent
	if !decodeLine(raw, &e) {
		return nil
	}
	if e.ParentToolUseID != nil && *e.ParentToolUseID != "" {
		return nil // a subagent's message (there are none without tools)
	}
	switch e.Type {
	case "system":
		return p.system(e)
	case "stream_event":
		return p.partialEvent(e)
	case "assistant":
		return p.assistant(e)
	case "result":
		return p.final(e)
	}
	return nil
}

func (p *claudeParser) system(e claudeEvent) error {
	switch e.Subtype {
	case "init":
		p.setModel(e.Model)
		if len(e.Tools) > 0 {
			return toolUse("the session offers tools: " + strings.Join(e.Tools, ","))
		}
	case "api_retry":
		// A usage limit or a refused login is not retried: stop the CLI's
		// own retries and fail at once.
		if kind := claudeErrorKind(e.Error); kind != failOther {
			return &failure{kind: kind, detail: "retry after " + e.Error}
		}
		if p.onRetry != nil {
			p.onRetry(tangent.Retry{Attempt: e.Attempt, MaxAttempts: e.MaxRetries, NextRetryAt: time.Now().Add(time.Duration(e.RetryDelayMs) * time.Millisecond)})
		}
	}
	return nil
}

func (p *claudeParser) partialEvent(e claudeEvent) error {
	if e.Event == nil || e.Event.Type != "content_block_delta" {
		return nil
	}
	p.partial = true
	switch e.Event.Delta.Type {
	case "text_delta":
		return p.addText(e.Event.Delta.Text)
	case "thinking_delta":
		p.addReasoning(e.Event.Delta.Thinking)
	}
	return nil
}

// assistant is a whole message: its text is streamed only when no token
// deltas came (a CLI without --include-partial-messages support).
func (p *claudeParser) assistant(e claudeEvent) error {
	if e.Error != "" {
		p.fail(claudeErrorKind(e.Error), "assistant error "+e.Error)
	}
	if e.Message == nil {
		return nil
	}
	p.setModel(e.Message.Model)
	if p.partial {
		return nil
	}
	for _, block := range e.Message.Content {
		switch block.Type {
		case "text":
			if err := p.addText(block.Text); err != nil {
				return err
			}
		case "thinking":
			p.addReasoning(block.Thinking)
		case "tool_use", "server_tool_use":
			return toolUse("the reply calls a tool")
		}
	}
	return nil
}

func (p *claudeParser) final(e claudeEvent) error {
	p.done = true
	p.stop = e.StopReason
	if u := e.Usage; u != nil {
		p.usage.InputTokens = u.InputTokens + u.CacheCreationInputTokens + u.CacheReadInputTokens
		p.usage.OutputTokens = u.OutputTokens
		p.usage.CacheReadTokens = u.CacheReadInputTokens
		p.usage.CacheWriteTokens = u.CacheCreationInputTokens
	}
	if e.IsError || (e.Subtype != "" && e.Subtype != "success") {
		text := strings.Join(append([]string{e.Result}, e.Errors...), " ")
		p.fail(classifyStatus(e.APIErrorStatus, text), fmt.Sprintf("result %s: %s", e.Subtype, text))
		return nil
	}
	if len(e.Result) > p.limit {
		return &failure{kind: failTooLarge, detail: "the result passed the limit"}
	}
	p.result = e.Result
	return nil
}

func (p *claudeParser) finish() (tangent.RunResult, *failure) { return p.reply.finish(p.result) }

// claudeErrorKind maps an SDKAssistantMessageError.
func claudeErrorKind(code string) failureKind {
	switch code {
	case "authentication_failed", "oauth_org_not_allowed", "cloud_credential_error":
		return failNotLoggedIn
	case "rate_limit", "billing_error":
		return failUsageLimit
	}
	return failOther
}
