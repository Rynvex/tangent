package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/httpapi"
	"github.com/Rynvex/tangent/runner/cli"
	"github.com/Rynvex/tangent/tangent"
)

// standInLookPath makes the named executables "installed" for one test.
func standInLookPath(t *testing.T, installed ...string) {
	t.Helper()
	old := lookPath
	lookPath = func(file string) (string, error) {
		if slices.Contains(installed, file) {
			return "/usr/local/bin/" + filepath.Base(file), nil
		}
		return "", exec.ErrNotFound
	}
	t.Cleanup(func() { lookPath = old })
}

func groupOf(t *testing.T, groups []tangent.ModelGroup, provider string) tangent.ModelGroup {
	t.Helper()
	for _, g := range groups {
		if g.Provider == provider {
			return g
		}
	}
	t.Fatalf("no %s group in %+v", provider, groups)
	return tangent.ModelGroup{}
}

func detailOf(g tangent.ModelGroup, model string) (tangent.ModelDetail, bool) {
	for _, d := range g.Details {
		if d.Model == model {
			return d, true
		}
	}
	return tangent.ModelDetail{}, false
}

func TestModelCatalog_CLIPresetsWithDetails(t *testing.T) {
	cfg, err := loadConfig(env{"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "claude-cli", "TANGENT_MODEL": "claude-custom-1", "TANGENT_AGY_CLI_MODEL": "gemini-4-argon"}.get)
	if err != nil {
		t.Fatal(err)
	}
	catalog := cfg.modelCatalog()
	claude := groupOf(t, catalog, providerClaudeCLI)
	if catalog[0].Provider != providerClaudeCLI {
		t.Fatalf("the default provider comes first: %+v", catalog)
	}
	wantModels := []string{"claude-custom-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"}
	if !reflect.DeepEqual(claude.Models, wantModels) {
		t.Fatalf("a custom model comes first, then the presets in order: %q", claude.Models)
	}
	if claude.Ready == nil || *claude.Ready || claude.Reason != "binary not found" {
		t.Fatalf("a missing CLI is reported, not refused: %+v", claude)
	}
	opus, _ := detailOf(claude, "claude-opus-5-5")
	if opus.DisplayName != "Claude Opus 5.5" || opus.Status != tangent.ModelCurrent || !reflect.DeepEqual(opus.EffortLevels, cli.EffortLevels(cli.Claude)) {
		t.Fatalf("opus %+v", opus)
	}
	if haiku, _ := detailOf(claude, "claude-haiku-5-5"); haiku.EffortLevels != nil || haiku.DisplayName != "Claude Haiku 5.5" {
		t.Fatalf("haiku takes no effort: %+v", haiku)
	}
	if custom, ok := detailOf(claude, "claude-custom-1"); !ok || custom.DisplayName != "" || len(custom.EffortLevels) != 4 {
		t.Fatalf("a custom CLI model gets its CLI's levels and no name: %+v", custom)
	}
	agy := groupOf(t, catalog, providerAgyCLI)
	if agy.Models[0] != "gemini-4-argon" || len(agy.Models) != 6 {
		t.Fatalf("agy %q", agy.Models)
	}
	if flash, _ := detailOf(agy, "gemini-3.8-flash-low"); flash.Status != tangent.ModelLegacy || flash.EffortLevels != nil {
		t.Fatalf("agy's models take no effort: %+v", flash)
	}
	if !cfg.allowModel("claude-cli", "opus") || !cfg.allowModel("claude-cli", "fable") || slices.Contains(claude.Models, "opus") {
		t.Fatal("aliases are allowed but not listed")
	}
	if cfg.allowModel("codex-cli", "gpt-6.1-sol") {
		t.Fatal("codex-cli is not enabled")
	}
}

func TestModelCatalog_AllowlistStaysStrict(t *testing.T) {
	cfg, err := loadConfig(env{"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "claude-cli", "TANGENT_MODEL": "sonnet", "TANGENT_ALLOWED_MODELS": "claude-cli:sonnet"}.get)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.allowModel("claude-cli", "opus") || cfg.allowModel("claude-cli", "claude-opus-5-5") || !cfg.allowModel("claude-cli", "sonnet") {
		t.Fatal("an allowlist allows exactly its models")
	}
	if got := groupOf(t, cfg.modelCatalog(), providerClaudeCLI).Models; !reflect.DeepEqual(got, []string{"sonnet"}) {
		t.Fatalf("models %q", got)
	}
}

func TestLoadConfig_CLIAutodetect(t *testing.T) {
	standInLookPath(t, "claude", "/opt/agy")
	dev, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_AGY_CLI_PATH": "/opt/agy"}.get)
	if err != nil {
		t.Fatal(err)
	}
	runners := dev.runnerProviders()
	if !dev.CLIAutodetect || !runners[providerClaudeCLI] || !runners[providerAgyCLI] || runners[providerCodexCLI] {
		t.Fatalf("dev detects the installed CLIs: %v", runners)
	}
	claude := groupOf(t, dev.modelCatalog(), providerClaudeCLI)
	if claude.Ready == nil || !*claude.Ready || claude.Reason != "" || claude.Models[0] != "claude-opus-5-5" {
		t.Fatalf("a detected CLI is ready with its presets: %+v", claude)
	}
	if !dev.allowModel("agy-cli", "gemini-4-carbon") || dev.allowModel("codex-cli", "gpt-6-luna") {
		t.Fatal("only detected CLIs offer their presets")
	}
	r, err := buildRunner(dev)
	if err != nil || r.runners[providerClaudeCLI] == nil || r.runners[providerCodexCLI] != nil {
		t.Fatalf("runners %v %v", r.runners, err)
	}
	for name, e := range map[string]env{
		"off in dev":     {"TANGENT_DEV": "1", "TANGENT_CLI_AUTODETECT": "0"},
		"off by default": {"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "fake"},
	} {
		cfg, err := loadConfig(e.get)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.runnerProviders()[providerClaudeCLI] {
			t.Errorf("%s: claude-cli enabled", name)
		}
	}
	on, err := loadConfig(env{"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "fake", "TANGENT_CLI_AUTODETECT": "1"}.get)
	if err != nil || !on.runnerProviders()[providerClaudeCLI] {
		t.Fatalf("on outside dev when asked: %v", err)
	}
	if _, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_CLI_AUTODETECT": "maybe"}.get); err == nil || !strings.Contains(err.Error(), "TANGENT_CLI_AUTODETECT") {
		t.Fatalf("a bad switch is refused: %v", err)
	}
}

func TestLoadConfig_FallbackModel(t *testing.T) {
	cfg, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_CLI_AUTODETECT": "0", "TANGENT_FALLBACK_MODEL": " Codex-CLI:gpt-6-luna "}.get)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Fallback != (modelRef{providerCodexCLI, "gpt-6-luna"}) || !cfg.runnerProviders()[providerCodexCLI] || !strings.Contains(cfg.String(), "fallbackModel=codex-cli:gpt-6-luna") {
		t.Fatalf("fallback %+v %v", cfg.Fallback, cfg.runnerProviders())
	}
	r, err := buildRunner(cfg)
	if err != nil || r.fallback != cfg.Fallback || r.runners[providerCodexCLI] == nil {
		t.Fatalf("runner %+v %v", r, err)
	}
	for text, want := range map[string]string{"gpt-6": "provider:model", "copilot:x": "unknown provider", "anthropic:claude-x": "ANTHROPIC_API_KEY"} {
		if _, err := loadConfig(env{"TANGENT_DEV": "1", "TANGENT_FALLBACK_MODEL": text}.get); err == nil || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), "TANGENT_FALLBACK_MODEL") {
			t.Errorf("%q: %v", text, err)
		}
	}
}

// recorder is a runner that records its requests and answers with err (or
// its name), streaming a delta first when streams is set.
type recorder struct {
	name    string
	err     error
	streams bool
	got     *[]tangent.RunRequest
}

func (r recorder) Run(_ context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	*r.got = append(*r.got, req)
	if r.streams && req.OnDelta != nil {
		req.OnDelta(domain.Delta{Kind: domain.DeltaText, Text: "partial"})
	}
	if r.err != nil {
		return tangent.RunResult{}, r.err
	}
	return tangent.RunResult{Content: r.name}, nil
}

var usageLimit = &tangent.RunnerError{Public: "the Claude Code subscription's usage limit is reached", Err: fmt.Errorf("%w: limit", cli.ErrUsageLimit)}

func TestRoutedRunner_FallsBackOnceOnALimit(t *testing.T) {
	onDelta := func(domain.Delta) {}
	for _, c := range []struct {
		name      string
		primary   recorder
		req       tangent.RunRequest
		fallback  modelRef
		wantCalls int
		wantErr   bool
	}{
		{"cli usage limit", recorder{name: "claude", err: usageLimit}, tangent.RunRequest{Provider: "claude-cli", Model: "opus", OnDelta: onDelta}, modelRef{"codex-cli", "gpt-6-luna"}, 2, false},
		{"api 429", recorder{name: "openai", err: &tangent.RunnerError{Public: "the model provider is rate limiting requests (HTTP 429)"}}, tangent.RunRequest{Provider: "openai", Model: "gpt-x"}, modelRef{"codex-cli", "gpt-6-luna"}, 2, false},
		{"other error", recorder{name: "claude", err: errors.New("boom")}, tangent.RunRequest{Provider: "claude-cli", Model: "opus"}, modelRef{"codex-cli", "gpt-6-luna"}, 1, true},
		{"already streamed", recorder{name: "claude", err: usageLimit, streams: true}, tangent.RunRequest{Provider: "claude-cli", Model: "opus", OnDelta: onDelta}, modelRef{"codex-cli", "gpt-6-luna"}, 1, true},
		{"no fallback", recorder{name: "claude", err: usageLimit}, tangent.RunRequest{Provider: "claude-cli", Model: "opus"}, modelRef{}, 1, true},
		{"same model", recorder{name: "claude", err: usageLimit}, tangent.RunRequest{Provider: "claude-cli"}, modelRef{"claude-cli", "opus"}, 1, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			var primaryCalls, fallbackCalls []tangent.RunRequest
			c.primary.got = &primaryCalls
			r := routedRunner{
				runners:         map[string]tangent.Runner{c.req.Provider: c.primary, "codex-cli": recorder{name: "codex", got: &fallbackCalls}},
				defaultProvider: "claude-cli", models: map[string]string{"claude-cli": "opus"}, fallback: c.fallback,
			}
			if c.fallback.Provider == "claude-cli" {
				r.runners["claude-cli"] = c.primary
			}
			result, err := r.Run(context.Background(), c.req)
			if calls := len(primaryCalls) + len(fallbackCalls); calls != c.wantCalls || (err != nil) != c.wantErr {
				t.Fatalf("calls %d err %v", calls, err)
			}
			if c.wantErr {
				return
			}
			if result.Content != "codex" || result.Model != "gpt-6-luna" || fallbackCalls[0].Model != "gpt-6-luna" || fallbackCalls[0].Provider != "codex-cli" {
				t.Fatalf("the fallback answered: %+v %+v", result, fallbackCalls)
			}
		})
	}
}

func TestRoutedRunner_ReasoningEffortFromHostMeta(t *testing.T) {
	meta := func(effort string) json.RawMessage { return json.RawMessage(`{"reasoningEffort":"` + effort + `"}`) }
	for _, c := range []struct {
		name string
		req  tangent.RunRequest
		want string
	}{
		{"claude opus", tangent.RunRequest{Provider: "claude-cli", Model: "claude-opus-5-5", HostMeta: meta("high")}, "high"},
		{"alias", tangent.RunRequest{Provider: "claude-cli", Model: "sonnet", HostMeta: meta("MAX")}, "max"},
		{"default model", tangent.RunRequest{Provider: "claude-cli", HostMeta: meta("low")}, "low"},
		{"haiku takes none", tangent.RunRequest{Provider: "claude-cli", Model: "claude-haiku-5-5", HostMeta: meta("high")}, ""},
		{"codex max is xhigh", tangent.RunRequest{Provider: "codex-cli", Model: "gpt-6.1-sol", HostMeta: meta("max")}, "xhigh"},
		{"claude xhigh is max", tangent.RunRequest{Provider: "claude-cli", Model: "opus", HostMeta: meta("xhigh")}, "max"},
		{"agy takes none", tangent.RunRequest{Provider: "agy-cli", Model: "gemini-4-carbon", HostMeta: meta("high")}, ""},
		{"api provider takes none", tangent.RunRequest{Provider: "openai", Model: "gpt-x", HostMeta: meta("high")}, ""},
		{"unknown level", tangent.RunRequest{Provider: "claude-cli", Model: "opus", HostMeta: meta("ultra")}, ""},
		{"no meta", tangent.RunRequest{Provider: "claude-cli", Model: "opus"}, ""},
		{"own field wins", tangent.RunRequest{Provider: "claude-cli", Model: "opus", ReasoningEffort: "medium", HostMeta: meta("high")}, "medium"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var got []tangent.RunRequest
			r := routedRunner{runners: map[string]tangent.Runner{c.req.Provider: recorder{got: &got}}, models: map[string]string{"claude-cli": "opus"}}
			if _, err := r.Run(context.Background(), c.req); err != nil {
				t.Fatal(err)
			}
			if got[0].ReasoningEffort != c.want {
				t.Fatalf("effort %q, want %q", got[0].ReasoningEffort, c.want)
			}
		})
	}
	var primary, backup []tangent.RunRequest
	r := routedRunner{
		runners:  map[string]tangent.Runner{"claude-cli": recorder{err: usageLimit, got: &primary}, "codex-cli": recorder{got: &backup}},
		fallback: modelRef{"codex-cli", "gpt-6.1-sol"},
	}
	if _, err := r.Run(context.Background(), tangent.RunRequest{Provider: "claude-cli", Model: "opus", HostMeta: meta("max")}); err != nil {
		t.Fatal(err)
	}
	if primary[0].ReasoningEffort != "max" || backup[0].ReasoningEffort != "xhigh" {
		t.Fatalf("the fallback gets its own level: %q / %q", primary[0].ReasoningEffort, backup[0].ReasoningEffort)
	}
	var jobs []tangent.RunRequest
	job := routedRunner{runners: map[string]tangent.Runner{"fake": recorder{got: &jobs}}, defaultProvider: "fake"}
	if _, err := job.Run(context.Background(), tangent.RunRequest{}); err != nil || jobs[0].OnDelta != nil {
		t.Fatal("a job (no OnDelta) stays a job")
	}
}

// lineBook is a lineReader over fixed lines.
type lineBook map[string]domain.LineView

func (b lineBook) GetLine(_ context.Context, _ tangent.Scope, id string) (domain.LineView, error) {
	if line, ok := b[id]; ok {
		return line, nil
	}
	return domain.LineView{}, domain.ErrLineNotFound
}

func metaRequest(t *testing.T, id, body string) *http.Request {
	t.Helper()
	r, err := http.NewRequest(http.MethodPost, "/lines/"+id, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.SetPathValue("id", id)
	return r
}

func TestEffortMeta(t *testing.T) {
	book := lineBook{
		"main":   {Line: domain.Line{ID: "main", HostMeta: json.RawMessage(`{"reasoningEffort":"high","other":1}`)}},
		"plain":  {Line: domain.Line{ID: "plain", HostMeta: json.RawMessage(`{}`)}},
		"branch": {Line: domain.Line{ID: "branch", HostMeta: json.RawMessage(`{}`)}, ConversationBranch: &domain.BranchRef{RootLineID: "main"}},
		"own":    {Line: domain.Line{ID: "own", HostMeta: json.RawMessage(`{"reasoningEffort":"low"}`)}, ConversationBranch: &domain.BranchRef{RootLineID: "main"}},
	}
	hook := effortMeta(book, tangent.Scope{Tenant: "t", Actor: "a"})
	for _, c := range []struct {
		name, op, id, body, want string
	}{
		{"create with effort", httpapi.OpLinesCreate, "", `{"title":"x","reasoningEffort":" High "}`, `{"reasoningEffort":"high"}`},
		{"create without", httpapi.OpLinesCreate, "", `{"title":"x"}`, ``},
		{"update leaves it", httpapi.OpLinesUpdate, "main", `{"title":"x"}`, ``},
		{"update keeps other keys", httpapi.OpLinesUpdate, "main", `{"reasoningEffort":"low"}`, `{"other":1,"reasoningEffort":"low"}`},
		{"update clears", httpapi.OpLinesUpdate, "main", `{"reasoningEffort":""}`, `{"other":1}`},
		{"send names its own", httpapi.OpTurnsSend, "plain", `{"content":"hi","reasoningEffort":"medium"}`, `{"reasoningEffort":"medium"}`},
		{"send takes the line's", httpapi.OpTurnsSend, "main", `{"content":"hi"}`, `{"reasoningEffort":"high"}`},
		{"a branch takes its main line's", httpapi.OpTurnsSend, "branch", `{"content":"hi"}`, `{"reasoningEffort":"high"}`},
		{"a branch's own wins", httpapi.OpTurnsSend, "own", `{"content":"hi"}`, `{"reasoningEffort":"low"}`},
		{"none", httpapi.OpTurnsSend, "plain", `{"content":"hi"}`, ``},
		{"unknown line", httpapi.OpTurnsSend, "gone", `{"content":"hi"}`, ``},
		{"other ops", httpapi.OpBranchesCreate, "main", `{"reasoningEffort":"high"}`, ``},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := hook(metaRequest(t, c.id, c.body), c.op)
			if err != nil || string(got) != c.want {
				t.Fatalf("got %s %v, want %s", got, err, c.want)
			}
		})
	}
	_, err := hook(metaRequest(t, "main", `{"reasoningEffort":"ultra"}`), httpapi.OpLinesUpdate)
	var refused *domain.Error
	if !errors.As(err, &refused) || refused.Code != domain.CodeInvalidInput {
		t.Fatalf("an unknown level is refused: %v", err)
	}
}

// fakeClaudeArgsScript is a stand-in claude that writes its arguments to a
// file and answers.
const fakeClaudeArgsScript = `#!/bin/sh
cat >/dev/null
echo "$@" > %q
echo '{"type":"system","subtype":"init","model":"claude-fake","tools":[]}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'
`

func TestServer_ReasoningEffortReachesTheCLI(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args")
	script := filepath.Join(dir, "claude")
	if err := os.WriteFile(script, []byte(fmt.Sprintf(fakeClaudeArgsScript, argsFile)), 0o700); err != nil {
		t.Fatal(err)
	}
	r := start(t, testConfig(t, func(c *config) {
		c.Provider = providerClaudeCLI
		c.CLI = c.withCLIModel(providerClaudeCLI, "claude-opus-5-5")
		s := c.CLI[providerClaudeCLI]
		s.Path, s.Installed = script, true
		c.CLI[providerClaudeCLI] = s
		c.AllowedModels[modelRef{providerClaudeCLI, "claude-opus-5-5"}] = true
	}))
	status, body := r.request(http.MethodPost, "/api/lines", `{"title":"effort","reasoningEffort":"high"}`, testToken)
	if status != http.StatusCreated || !strings.Contains(body, `"hostMeta":{"reasoningEffort":"high"}`) {
		t.Fatalf("%d %s", status, body)
	}
	lineID := decodeObject(t, body)["id"].(string)
	if status, body = r.request(http.MethodPatch, "/api/lines/"+lineID, `{"reasoningEffort":"bogus"}`, testToken); status != http.StatusBadRequest {
		t.Fatalf("a bad level: %d %s", status, body)
	}
	if status, body = r.request(http.MethodPost, "/api/lines/"+lineID+"/messages", `{"content":"hello"}`, testToken); status != http.StatusAccepted {
		t.Fatalf("%d %s", status, body)
	}
	r.app.dispatcher.Wait()
	args, err := os.ReadFile(argsFile)
	if err != nil || !strings.Contains(string(args), "--effort high") || !strings.Contains(string(args), "--model claude-opus-5-5") {
		t.Fatalf("args %q %v", args, err)
	}
	_, body = r.request(http.MethodGet, "/api/lines/"+lineID+"/messages", "", testToken)
	if !strings.Contains(body, `"hostMeta":{"reasoningEffort":"high"}`) {
		t.Fatalf("the operator message keeps the effort it ran with: %s", body)
	}
	_, body = r.request(http.MethodGet, "/api/capabilities", "", testToken)
	if !strings.Contains(body, `"provider":"claude-cli"`) || !strings.Contains(body, `"ready":true`) || !strings.Contains(body, `"effortLevels":["low","medium","high","max"]`) {
		t.Fatalf("capabilities %s", body)
	}
}
