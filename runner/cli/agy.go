package cli

import (
	"encoding/json"
	"fmt"

	"github.com/Rynvex/tangent/tangent"
)

// agyBackend runs Antigravity CLI (agy) in print mode. Every flag uses the
// attached --flag=value form: a detached --print takes the next argument as
// its prompt.
//
//	--print=                         print mode, no prompt on the command line
//	--input-format=stream-json       the prompt is one NDJSON message on stdin
//	--output-format=stream-json      init / step_update / result events
//	--mode=plan                      never accept-edits or auto, whatever the
//	                                 user's saved Agent Mode is
//	--sandbox                        terminal restrictions for any command
//	--disable-slash-commands         a message starting with "/" stays text
//	--model=<model>                  when one is set
//
// agy has no switch that removes its tools, so chat-only rests on print
// mode refusing every action that needs an approval (nobody can give one),
// the empty working directory, and, as the second line, killing the run as
// soon as a step is a tool call. agy takes no separate system prompt, so
// the system part and the conversation go as one message.
var agyBackend = backend{
	display: "Antigravity",
	env:     []string{"AGY_ADC_AUTH", "GOOGLE_CLOUD_PROJECT"},
	prepare: func(_ runDir, model string, req tangent.RunRequest) (invocation, error) {
		message, err := json.Marshal(agyInput{Event: "user", Message: agyMessage{Content: singleText(req)}})
		if err != nil {
			return invocation{}, fmt.Errorf("encode the agy message: %w", err)
		}
		args := []string{
			"--print=", "--input-format=stream-json", "--output-format=stream-json",
			"--mode=plan", "--sandbox", "--disable-slash-commands",
		}
		if model != "" {
			args = append(args, "--model="+model)
		}
		return invocation{args: args, stdin: string(message) + "\n"}, nil
	},
	parser: func(r *reply) parser { return &agyParser{reply: r} },
}

// agyInput is one stream-json input message.
type agyInput struct {
	Event   string     `json:"event"`
	Message agyMessage `json:"message"`
}

type agyMessage struct {
	Content string `json:"content"`
}

// agyEvent is the union of the stream-json events tangent reads.
type agyEvent struct {
	Event string `json:"event"`
	Init  *struct {
		Model string `json:"model"`
	} `json:"init"`
	Step *struct {
		StepType  string `json:"step_type"`
		State     string `json:"state"`
		TextDelta string `json:"text_delta"`
		ToolName  string `json:"tool_name"`
	} `json:"step_update"`
	Result *struct {
		Status   string    `json:"status"`
		Response string    `json:"response"`
		Error    string    `json:"error"`
		Usage    *agyUsage `json:"usage"`
	} `json:"result"`
}

type agyUsage struct {
	InputTokens     int64 `json:"input_tokens"`
	OutputTokens    int64 `json:"output_tokens"`
	CacheReadTokens int64 `json:"cache_read_tokens"`
}

type agyParser struct {
	*reply
	response string
}

func (p *agyParser) line(raw []byte) error {
	var e agyEvent
	if !decodeLine(raw, &e) {
		return nil
	}
	switch {
	case e.Event == "init" && e.Init != nil:
		p.setModel(e.Init.Model)
	case e.Event == "step_update" && e.Step != nil:
		return p.step(e)
	case e.Event == "result" && e.Result != nil:
		return p.final(e)
	}
	return nil
}

// step streams the agent's text; a tool step stops the run.
func (p *agyParser) step(e agyEvent) error {
	s := e.Step
	if s.StepType == "tool" || s.ToolName != "" {
		return toolUse("step " + s.StepType + " " + s.ToolName)
	}
	if s.StepType == "agent_response" {
		return p.addText(s.TextDelta)
	}
	return nil
}

func (p *agyParser) final(e agyEvent) error {
	r := e.Result
	p.done = true
	if u := r.Usage; u != nil {
		p.usage.InputTokens = u.InputTokens
		p.usage.OutputTokens = u.OutputTokens
		p.usage.CacheReadTokens = u.CacheReadTokens
	}
	if r.Status != "SUCCESS" {
		p.fail(classify(r.Error, failOther), "result "+r.Status+": "+r.Error)
		return nil
	}
	if len(r.Response) > p.limit {
		return &failure{kind: failTooLarge, detail: "the response passed the limit"}
	}
	p.response = r.Response
	return nil
}

func (p *agyParser) finish() (tangent.RunResult, *failure) { return p.reply.finish(p.response) }
