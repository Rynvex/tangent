package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/runner/cli"
)

func TestLoadConfig_CLIProvidersMixWithAPIProviders(t *testing.T) {
	cfg, err := loadConfig(env{
		"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "claude-cli", "TANGENT_MODEL": "sonnet", "TANGENT_CLAUDE_CLI_PATH": "/opt/claude",
		"TANGENT_CLAUDE_CLI_MAX_CONCURRENT": "3", "ANTHROPIC_API_KEY": "k", "TANGENT_JOB_MODEL": "anthropic:claude-haiku-4-5",
		"TANGENT_CODEX_CLI_MODEL": "gpt-5-codex", "TANGENT_CLI_ENV": "CLAUDE_CODE_OAUTH_TOKEN, HTTPS_PROXY",
	}.get)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.CLI[providerClaudeCLI]; got != (cliSettings{Path: "/opt/claude", Model: "sonnet", MaxConcurrent: 3}) {
		t.Fatalf("claude-cli settings %+v", got)
	}
	if cfg.CLI[providerAgyCLI].MaxConcurrent != cli.DefaultMaxConcurrent || !reflect.DeepEqual(cfg.CLIEnv, []string{"CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY"}) {
		t.Fatalf("defaults %+v %v", cfg.CLI, cfg.CLIEnv)
	}
	// G1: without an allowlist an enabled CLI offers its presets (aliases allowed, not listed); agy-cli is not enabled.
	if cfg.defaultModel() != "sonnet" || !cfg.allowModel("", "") || !cfg.allowModel("claude-cli", "sonnet") || !cfg.allowModel("codex-cli", "gpt-5-codex") ||
		!cfg.allowModel("claude-cli", "opus") || !cfg.allowModel("claude-cli", "claude-opus-5-5") || !cfg.allowModel("codex-cli", "gpt-6-luna") ||
		cfg.allowModel("agy-cli", "gemini-3.8-flash-medium") || cfg.allowModel("claude-cli", "claude-x") {
		t.Fatal("model checks")
	}
	want := map[string][]string{
		"claude-cli": {"sonnet", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"},
		"anthropic":  {"claude-haiku-4-5"},
		"codex-cli":  {"gpt-5-codex", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.4-mini"},
	}
	got := cfg.modelCatalog()
	if len(got) != 3 || got[0].Provider != "claude-cli" || got[1].Provider != "anthropic" || got[2].Provider != "codex-cli" {
		t.Fatalf("catalog order %+v", got)
	}
	for _, group := range got {
		if !reflect.DeepEqual(group.Models, want[group.Provider]) {
			t.Fatalf("%s models %q", group.Provider, group.Models)
		}
	}
	r, err := buildRunner(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"claude-cli", "codex-cli", "anthropic"} {
		if r.runners[name] == nil {
			t.Fatalf("no %s runner: %v", name, r.runners)
		}
	}
	if r.runners["agy-cli"] != nil {
		t.Fatal("agy-cli is not configured")
	}
}

func TestLoadConfig_CLIJobModelRegistersItsRunner(t *testing.T) {
	cfg, err := loadConfig(env{"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "anthropic", "TANGENT_MODEL": "claude-x", "ANTHROPIC_API_KEY": "k",
		"TANGENT_JOB_MODEL": "agy-cli:gemini-3.8-flash-low"}.get)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.runnerProviders()[providerAgyCLI] || !cfg.allowModel("agy-cli", "gemini-3.8-flash-low") {
		t.Fatalf("job model on a CLI: %v", cfg.runnerProviders())
	}
}

func TestLoadConfig_RefusesBadCLISettings(t *testing.T) {
	for _, c := range []struct {
		name string
		env  env
		want string
	}{
		{"no model", env{"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "codex-cli"}, "TANGENT_MODEL"},
		{"bad concurrency", env{"TANGENT_DEV": "1", "TANGENT_AGY_CLI_MAX_CONCURRENT": "0"}, "TANGENT_AGY_CLI_MAX_CONCURRENT"},
		{"secret passed on", env{"TANGENT_DEV": "1", "TANGENT_CLI_ENV": "TANGENT_TOKEN"}, "TANGENT_CLI_ENV"},
		{"api key passed on", env{"TANGENT_DEV": "1", "TANGENT_CLI_ENV": "ANTHROPIC_API_KEY"}, "TANGENT_CLI_ENV"},
		{"option-like model", env{"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "claude-cli", "TANGENT_MODEL": "--dangerously-skip-permissions"}, "TANGENT_CLAUDE_CLI"},
		{"unknown job provider", env{"TANGENT_DEV": "1", "TANGENT_JOB_MODEL": "copilot-cli:x"}, "claude-cli"},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg, err := loadConfig(c.env.get)
			if err == nil {
				_, err = buildRunner(cfg)
			}
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to mention %q", err, c.want)
			}
		})
	}
}

// fakeClaudeScript is a stand-in claude: it reads the prompt from stdin and
// prints a stream-json reply.
const fakeClaudeScript = `#!/bin/sh
cat >/dev/null
echo '{"type":"system","subtype":"init","model":"claude-fake","tools":[]}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"from the CLI"}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"from the CLI","usage":{"input_tokens":3,"output_tokens":4}}'
`

func TestServer_TurnThroughACLIProvider(t *testing.T) {
	script := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(script, []byte(fakeClaudeScript), 0o700); err != nil {
		t.Fatal(err)
	}
	r := start(t, testConfig(t, func(c *config) {
		c.Provider = providerClaudeCLI
		c.CLI = c.withCLIModel(providerClaudeCLI, "sonnet")
		s := c.CLI[providerClaudeCLI]
		s.Path = script
		c.CLI[providerClaudeCLI] = s
		c.AllowedModels[modelRef{providerClaudeCLI, "sonnet"}] = true
	}))
	status, body := r.request(http.MethodPost, "/api/lines", `{"title":"cli"}`, testToken)
	if status != http.StatusCreated {
		t.Fatalf("%d %s", status, body)
	}
	lineID := decodeObject(t, body)["id"].(string)
	if status, body = r.request(http.MethodPost, "/api/lines/"+lineID+"/messages", `{"content":"hello"}`, testToken); status != http.StatusAccepted {
		t.Fatalf("%d %s", status, body)
	}
	r.app.dispatcher.Wait()
	_, body = r.request(http.MethodGet, "/api/lines/"+lineID+"/messages", "", testToken)
	messages := decodeObject(t, body)["messages"].([]any)
	last := messages[len(messages)-1].(map[string]any)
	if last["content"] != "from the CLI" || last["status"] != "done" {
		t.Fatalf("reply %v", last)
	}
}

func decodeObject(t *testing.T, body string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return out
}
