package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// The test binary doubles as a fake CLI: with CLIFAKE_MODE set, TestMain
// runs fakeCLI instead of the tests. It writes what it saw (arguments,
// stdin, working directory, environment) to CLIFAKE_REPORT, then plays the
// stream of the mode.

// fakeReport is what the fake CLI saw.
type fakeReport struct {
	Args         []string `json:"args"`
	Stdin        string   `json:"stdin"`
	Cwd          string   `json:"cwd"`
	CwdEntries   []string `json:"cwdEntries"`
	Env          []string `json:"env"`
	SystemPrompt string   `json:"systemPrompt"`
	SystemPath   string   `json:"systemPath"`
	Pid          int      `json:"pid"`
	ChildPid     int      `json:"childPid"`
}

// fakeModes are the scripted streams, one line per event.
var fakeModes = map[string][]string{
	"claude-ok": {
		`not json: a warning the CLI printed`,
		`{"type":"system","subtype":"init","model":"claude-sonnet-x","tools":[],"mcp_servers":[]}`,
		`{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}`,
		`{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}`,
		`{"type":"assistant","parent_tool_use_id":null,"message":{"model":"claude-sonnet-x","content":[{"type":"text","text":"Hello"}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"Hello","stop_reason":"end_turn","total_cost_usd":0.5,` +
			`"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7}}`,
	},
	"claude-thinking": {
		`{"type":"system","subtype":"init","model":"claude-sonnet-x","tools":[]}`,
		`{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":529,"error":"overloaded"}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me think."}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done."}}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"Done.","usage":{"input_tokens":1,"output_tokens":2}}`,
	},
	"claude-whole": {
		`{"type":"system","subtype":"init","model":"claude-sonnet-x","tools":[]}`,
		`{"type":"assistant","message":{"model":"claude-sonnet-x","content":[{"type":"thinking","thinking":"Hmm."},{"type":"text","text":"Part one."}]}}`,
		`{"type":"assistant","message":{"model":"claude-sonnet-x","content":[{"type":"text","text":" Part two."}]}}`,
		`{"type":"result","subtype":"success","is_error":false,"result":"Part one. Part two.","usage":{"input_tokens":1,"output_tokens":2}}`,
	},
	"claude-noauth": {
		`{"type":"system","subtype":"init","model":"claude-sonnet-x","tools":[]}`,
		`{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed"}`,
		`{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","usage":{"input_tokens":0,"output_tokens":0}}`,
		`exit:1`,
	},
	"claude-limit": {
		`{"type":"system","subtype":"init","model":"claude-sonnet-x","tools":[]}`,
		`{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"You've hit your limit · resets 3pm"}]},"error":"rate_limit"}`,
		`{"type":"result","subtype":"success","is_error":true,"result":"You've hit your limit · resets 3pm"}`,
		`exit:1`,
	},
	"claude-retry-limit": {
		`{"type":"system","subtype":"init","model":"claude-sonnet-x","tools":[]}`,
		`{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":60000,"error_status":429,"error":"rate_limit"}`,
		`sleep`,
	},
	"claude-tools": {
		`{"type":"system","subtype":"init","model":"claude-sonnet-x","tools":["Bash","Read"]}`,
		`sleep`,
	},
	"claude-noresult": {
		`{"type":"system","subtype":"init","model":"claude-sonnet-x","tools":[]}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"cut"}}}`,
	},
	"codex-ok": {
		`{"type":"thread.started","thread_id":"t-1"}`,
		`{"type":"turn.started"}`,
		`{"type":"error","message":"Reconnecting... 1/5"}`,
		`{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Thinking**"}}`,
		`{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"First."}}`,
		`{"type":"item.completed","item":{"id":"item_2","type":"todo_list","items":[]}}`,
		`{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Second."}}`,
		`{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":150,"output_tokens":30,"reasoning_output_tokens":10}}`,
	},
	"codex-limit": {
		`{"type":"thread.started","thread_id":"t-1"}`,
		`{"type":"error","message":"You've hit your usage limit. Try again in 2 hours."}`,
		`{"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again in 2 hours."}}`,
		`exit:1`,
	},
	"codex-noauth": {
		`stderr:Error: not logged in. Run codex login first.`,
		`exit:1`,
	},
	"codex-tool": {
		`{"type":"thread.started","thread_id":"t-1"}`,
		`{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"cat ~/.ssh/id_rsa","status":"in_progress"}}`,
		`sleep`,
	},
	"agy-ok": {
		`{"event":"init","conversation_id":"c-1","init":{"model":"gemini-3.8-flash-medium","cwd":"/tmp/x","tools":["view_file","run_command"],"permission_mode":"plan"}}`,
		`{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":0,"state":"DONE","step_type":"user_input"}}`,
		`{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Bon"}}`,
		`{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"jour"}}`,
		`{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"Bonjour","num_turns":1,` +
			`"usage":{"input_tokens":50,"output_tokens":10,"thinking_tokens":4,"cache_read_tokens":20,"total_tokens":60},"denied_actions":[]}}`,
	},
	"agy-noauth": {
		`stderr:error: you are not signed in; run agy once in a terminal to sign in with your Google account`,
		`exit:1`,
	},
	"agy-quota": {
		`{"event":"init","conversation_id":"c-1","init":{"model":"gemini-3.8-flash-medium","tools":[]}}`,
		`{"event":"result","result":{"conversation_id":"c-1","status":"ERROR","error":"Your AI credits balance is too low to continue."}}`,
		`stderr:AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false}`,
		`exit:3`,
	},
	"agy-tool": {
		`{"event":"init","conversation_id":"c-1","init":{"model":"m","tools":["run_command"]}}`,
		`{"event":"step_update","step_update":{"conversation_id":"c-1","step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"command":"ls ~"}}}}`,
		`sleep`,
	},
	"crash": {
		`stderr:panic: something broke near token sk-live-abcdefghijklmnopqrstuvwxyz0123456789 in /home/someone/secret.txt`,
		`exit:3`,
	},
	"hang":  {`child`, `{"type":"system","subtype":"init","model":"m","tools":[]}`, `sleep`},
	"sleep": {`sleep`},
	"huge": {
		`{"type":"system","subtype":"init","model":"m","tools":[]}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"` + strings.Repeat("x", 600) + `"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"` + strings.Repeat("y", 600) + `"}}}`,
		`{"type":"result","subtype":"success","result":"never"}`,
	},
	"exclusive": {`exclusive`, `{"type":"system","subtype":"init","model":"m","tools":[]}`, `{"type":"result","subtype":"success","result":"one at a time"}`},
}

// fakeCLI is the fake CLI's main.
func fakeCLI(mode string) int {
	stdin, _ := io.ReadAll(os.Stdin)
	script, ok := fakeModes[mode]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown fake mode %q\n", mode)
		return 2
	}
	report := fakeReport{Args: os.Args[1:], Stdin: string(stdin), Env: os.Environ(), Pid: os.Getpid()}
	report.Cwd, _ = os.Getwd()
	if entries, err := os.ReadDir(report.Cwd); err == nil {
		for _, e := range entries {
			report.CwdEntries = append(report.CwdEntries, e.Name())
		}
	}
	for i, arg := range os.Args {
		if arg == "--system-prompt-file" && i+1 < len(os.Args) {
			report.SystemPath = os.Args[i+1]
			content, _ := os.ReadFile(report.SystemPath)
			report.SystemPrompt = string(content)
		}
	}
	writeReport(report) // at once: the runner may kill the CLI on any line
	return playScript(script, report)
}

// playScript prints the script; directives start a child, sleep, write to
// stderr, guard against a concurrent run, or exit with a code.
func playScript(script []string, report fakeReport) int {
	for _, line := range script {
		switch {
		case line == "child":
			child := exec.Command(os.Args[0])
			child.Env = append(os.Environ(), "CLIFAKE_MODE=sleep", "CLIFAKE_REPORT=")
			child.Stdout = os.Stdout // the child holds the stdout pipe too
			if err := child.Start(); err != nil {
				return 4
			}
			report.ChildPid = child.Process.Pid
			writeReport(report)
		case line == "exclusive":
			if code := exclusive(); code != 0 {
				return code
			}
			continue
		case line == "sleep":
			writeReport(report)
			time.Sleep(time.Minute)
			return 0
		case strings.HasPrefix(line, "stderr:"):
			fmt.Fprintln(os.Stderr, strings.TrimPrefix(line, "stderr:"))
		case strings.HasPrefix(line, "exit:"):
			writeReport(report)
			var code int
			_, _ = fmt.Sscanf(line, "exit:%d", &code)
			return code
		default:
			fmt.Println(line)
		}
	}
	writeReport(report)
	return 0
}

// exclusive fails (exit 9) when another fake run holds the lock.
func exclusive() int {
	lock := os.Getenv("CLIFAKE_REPORT") + ".lock"
	f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 9
	}
	_ = f.Close()
	time.Sleep(80 * time.Millisecond)
	_ = os.Remove(lock)
	return 0
}

func writeReport(report fakeReport) {
	path := os.Getenv("CLIFAKE_REPORT")
	if path == "" {
		return
	}
	raw, _ := json.Marshal(report)
	if os.WriteFile(path+".tmp", raw, 0o600) == nil {
		_ = os.Rename(path+".tmp", path) // readers never see half a report
	}
}
