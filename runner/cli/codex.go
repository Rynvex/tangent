package cli

import (
	"fmt"

	"github.com/Rynvex/tangent/tangent"
)

// codexBackend runs Codex non-interactively (`codex exec`):
//
//	exec --json                      JSONL events on stdout
//	--color never
//	--skip-git-repo-check            the working directory is not a repo
//	--ephemeral                      no session files saved to disk
//	--ignore-user-config             no $CODEX_HOME/config.toml (its MCP
//	                                 servers, profiles); login still works
//	--ignore-rules                   no execpolicy .rules files
//	--sandbox read-only
//	-c approval_policy="never"       nothing waits for an approval
//	-c features.shell_tool=false     no command execution tools
//	-c features.unified_exec=false
//	-c web_search="disabled"         no web search tool
//	-c history.persistence="none"    nothing appended to history.jsonl
//	-C <work>                        the empty working directory
//	-m <model>                       when one is set
//	-c model_reasoning_effort="<level>"
//	                                 when the request asks for a reasoning
//	                                 effort Codex knows (codexEffort)
//	-                                the prompt is read from stdin
//
// Codex takes no separate system prompt on stdin, so the system part and
// the conversation go as one text. An item that is a tool call (a command,
// a file change, an MCP or web search call) kills the run.
var codexBackend = backend{
	display: "Codex",
	env:     []string{"CODEX_HOME"},
	prepare: func(dir runDir, model string, req tangent.RunRequest) (invocation, error) {
		args := []string{
			"exec", "--json", "--color", "never", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
			"--sandbox", "read-only", "-c", `approval_policy="never"`, "-c", "features.shell_tool=false", "-c", "features.unified_exec=false",
			"-c", `web_search="disabled"`, "-c", `history.persistence="none"`, "-C", dir.work,
		}
		args = withModel(args, "-m", model)
		if effort := codexEffort(req.ReasoningEffort); effort != "" {
			args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", effort))
		}
		args = append(args, "-")
		return invocation{args: args, stdin: singleText(req)}, nil
	},
	parser: func(r *reply) parser { return &codexParser{reply: r} },
}

// codexEvent is the union of the exec JSONL events tangent reads
// (codex-rs/exec/src/exec_events.rs).
type codexEvent struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Error   *struct {
		Message string `json:"message"`
	} `json:"error"`
	Item *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"item"`
	Usage *struct {
		InputTokens           int64 `json:"input_tokens"`
		CachedInputTokens     int64 `json:"cached_input_tokens"`
		CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
		OutputTokens          int64 `json:"output_tokens"`
	} `json:"usage"`
}

// codexToolItems are the item types that mean a tool ran or is about to.
var codexToolItems = map[string]bool{
	"command_execution": true, "file_change": true, "mcp_tool_call": true, "collab_tool_call": true, "web_search": true,
}

type codexParser struct {
	*reply
	messages int
	// streamErr is the last top-level error event; it fails the run only
	// when the turn does not complete (Codex also reports errors it
	// recovers from).
	streamErr string
}

func (p *codexParser) line(raw []byte) error {
	var e codexEvent
	if !decodeLine(raw, &e) {
		return nil
	}
	switch e.Type {
	case "item.started", "item.updated", "item.completed":
		return p.item(e)
	case "turn.completed":
		p.done = true
		if u := e.Usage; u != nil {
			p.usage.InputTokens = u.InputTokens
			p.usage.OutputTokens = u.OutputTokens
			p.usage.CacheReadTokens = u.CachedInputTokens
			p.usage.CacheWriteTokens = u.CacheWriteInputTokens
		}
	case "turn.failed":
		message := ""
		if e.Error != nil {
			message = e.Error.Message
		}
		p.fail(classify(message, failOther), "turn failed: "+message)
	case "error":
		p.streamErr = e.Message
	}
	return nil
}

// item handles one thread item: agent messages are the reply (each one
// streamed whole, as Codex sends no token deltas), reasoning is reasoning.
func (p *codexParser) item(e codexEvent) error {
	if e.Item == nil {
		return nil
	}
	if codexToolItems[e.Item.Type] {
		return toolUse("item " + e.Item.Type)
	}
	if e.Type != "item.completed" {
		return nil
	}
	switch e.Item.Type {
	case "agent_message":
		text := e.Item.Text
		if p.messages > 0 {
			text = "\n\n" + text
		}
		p.messages++
		return p.addText(text)
	case "reasoning":
		p.addReasoning(e.Item.Text)
	}
	return nil
}

func (p *codexParser) finish() (tangent.RunResult, *failure) {
	if !p.done && p.failed == nil && p.streamErr != "" {
		p.fail(classify(p.streamErr, failOther), "error: "+p.streamErr)
	}
	return p.reply.finish("")
}
