package cli

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/domain"
	"github.com/Rynvex/tangent/tangent"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("CLIFAKE_MODE"); mode != "" {
		os.Exit(fakeCLI(mode))
	}
	os.Exit(m.Run())
}

// harness runs the test binary as a fake CLI of one mode.
type harness struct {
	t      *testing.T
	report string
	runner *Runner
}

func newHarness(t *testing.T, b Backend, mode string, edit ...func(*Config)) *harness {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	report := filepath.Join(t.TempDir(), "report.json")
	t.Setenv("CLIFAKE_MODE", mode)
	t.Setenv("CLIFAKE_REPORT", report)
	cfg := Config{Backend: b, Path: self, Model: "test-model", Env: []string{"CLIFAKE_MODE", "CLIFAKE_REPORT"}, WaitDelay: 500 * time.Millisecond}
	for _, e := range edit {
		e(&cfg)
	}
	r, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return &harness{t: t, report: report, runner: r}
}

// deltas records the streamed pieces.
type deltas struct {
	mu   sync.Mutex
	list []domain.Delta
}

func (d *deltas) add(x domain.Delta) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.list = append(d.list, x)
}

func (d *deltas) text(kind string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var b strings.Builder
	for _, x := range d.list {
		if x.Kind == kind {
			b.WriteString(x.Text)
		}
	}
	return b.String()
}

func chatRequest(d *deltas) tangent.RunRequest {
	return tangent.RunRequest{
		System: "RULES: be brief.",
		Messages: []domain.ChatMessage{
			{Role: domain.ChatRoleUser, Content: "first question"},
			{Role: domain.ChatRoleAssistant, Content: "first answer"},
			{Role: domain.ChatRoleUser, Content: "SECRET-QUESTION-42"},
		},
		OnDelta: d.add,
	}
}

func (h *harness) run(ctx context.Context, d *deltas) (tangent.RunResult, error) {
	return h.runner.Run(ctx, chatRequest(d))
}

func (h *harness) readReport() fakeReport {
	h.t.Helper()
	raw, err := os.ReadFile(h.report)
	if err != nil {
		h.t.Fatalf("the fake CLI wrote no report: %v", err)
	}
	var r fakeReport
	if err := json.Unmarshal(raw, &r); err != nil {
		h.t.Fatal(err)
	}
	return r
}

func TestClaude_StreamsTextAndReturnsTheResult(t *testing.T) {
	h := newHarness(t, Claude, "claude-ok")
	d := &deltas{}
	result, err := h.run(context.Background(), d)
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "Hello" || d.text(domain.DeltaText) != "Hello" || result.Model != "claude-sonnet-x" || result.StopReason != "end_turn" {
		t.Fatalf("result %+v, deltas %q", result, d.text(domain.DeltaText))
	}
	want := domain.Usage{InputTokens: 115, OutputTokens: 7, CacheReadTokens: 100, CacheWriteTokens: 5}
	if result.Usage != want {
		t.Fatalf("usage %+v, want %+v (no cost: a subscription is not billed per token)", result.Usage, want)
	}
}

func TestClaude_PromptGoesOnStdinAndTheSystemPromptInAPrivateFile(t *testing.T) {
	h := newHarness(t, Claude, "claude-ok")
	if _, err := h.run(context.Background(), &deltas{}); err != nil {
		t.Fatal(err)
	}
	rep := h.readReport()
	for _, arg := range rep.Args {
		if strings.Contains(arg, "SECRET-QUESTION-42") || strings.Contains(arg, "RULES") {
			t.Fatalf("the prompt is on the command line: %q", rep.Args)
		}
	}
	wantStdin := "## Conversation so far\n\noperator: first question\n\nagent: first answer\n\n## Operator's message\n\nSECRET-QUESTION-42\n"
	if rep.Stdin != wantStdin {
		t.Fatalf("stdin %q", rep.Stdin)
	}
	if rep.SystemPrompt != "RULES: be brief." || filepath.Dir(rep.SystemPath) == rep.Cwd {
		t.Fatalf("system prompt %q at %s (cwd %s)", rep.SystemPrompt, rep.SystemPath, rep.Cwd)
	}
	for _, flag := range []string{"-p", "stream-json", "--include-partial-messages", "--strict-mcp-config", "--safe-mode", "--no-session-persistence", "dontAsk"} {
		if !contains(rep.Args, flag) {
			t.Fatalf("missing %s in %q", flag, rep.Args)
		}
	}
	if i := index(rep.Args, "--tools"); i < 0 || rep.Args[i+1] != "" {
		t.Fatalf("tools must be disabled with --tools \"\": %q", rep.Args)
	}
	if i := index(rep.Args, "--model"); i < 0 || rep.Args[i+1] != "test-model" {
		t.Fatalf("model flag: %q", rep.Args)
	}
}

func TestRun_WorkingDirectoryIsEmptyAndRemoved(t *testing.T) {
	h := newHarness(t, Claude, "claude-ok")
	if _, err := h.run(context.Background(), &deltas{}); err != nil {
		t.Fatal(err)
	}
	rep := h.readReport()
	if len(rep.CwdEntries) != 0 || !strings.Contains(rep.Cwd, "tangent-cli-") {
		t.Fatalf("cwd %s holds %v", rep.Cwd, rep.CwdEntries)
	}
	for _, path := range []string{rep.Cwd, filepath.Dir(rep.Cwd), rep.SystemPath} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s still exists after the run: %v", path, err)
		}
	}
}

func TestRun_EnvironmentIsAllowlisted(t *testing.T) {
	h := newHarness(t, Claude, "claude-ok", func(c *Config) { c.Env = append(c.Env, "CLAUDE_CODE_OAUTH_TOKEN") })
	for key, value := range map[string]string{
		"TANGENT_TOKEN": "server-token", "TANGENT_DATABASE_URL": "postgres://x", "DATABASE_URL": "postgres://y",
		"ANTHROPIC_API_KEY": "sk-ant", "OPENAI_API_KEY": "sk-oa", "GEMINI_API_KEY": "g", "AWS_SECRET_ACCESS_KEY": "a",
		"SOME_OTHER_VAR": "x", "CLAUDE_CONFIG_DIR": "/cfg", "LC_ALL": "C.UTF-8", "CLAUDE_CODE_OAUTH_TOKEN": "opted-in",
	} {
		t.Setenv(key, value)
	}
	if _, err := h.run(context.Background(), &deltas{}); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, entry := range h.readReport().Env {
		name, value, _ := strings.Cut(entry, "=")
		got[name] = value
	}
	for _, banned := range []string{"TANGENT_TOKEN", "TANGENT_DATABASE_URL", "DATABASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AWS_SECRET_ACCESS_KEY", "SOME_OTHER_VAR"} {
		if _, ok := got[banned]; ok {
			t.Fatalf("%s reached the CLI", banned)
		}
	}
	for name, want := range map[string]string{"CLAUDE_CONFIG_DIR": "/cfg", "LC_ALL": "C.UTF-8", "CLAUDE_CODE_OAUTH_TOKEN": "opted-in", "PATH": os.Getenv("PATH"), "HOME": os.Getenv("HOME")} {
		if got[name] != want {
			t.Fatalf("%s = %q, want %q", name, got[name], want)
		}
	}
}

func TestClaude_ThinkingRetriesAndWholeMessages(t *testing.T) {
	d := &deltas{}
	var retries []tangent.Retry
	h := newHarness(t, Claude, "claude-thinking")
	req := chatRequest(d)
	req.OnRetry = func(r tangent.Retry) { retries = append(retries, r) }
	result, err := h.runner.Run(context.Background(), req)
	if err != nil || result.Content != "Done." || d.text(domain.DeltaReasoning) != "Let me think." {
		t.Fatalf("result %+v err %v reasoning %q", result, err, d.text(domain.DeltaReasoning))
	}
	if len(retries) != 1 || retries[0].Attempt != 1 || retries[0].MaxAttempts != 10 || retries[0].NextRetryAt.IsZero() {
		t.Fatalf("retries %+v", retries)
	}

	whole := &deltas{}
	h = newHarness(t, Claude, "claude-whole")
	result, err = h.run(context.Background(), whole)
	if err != nil || result.Content != "Part one. Part two." || whole.text(domain.DeltaText) != "Part one. Part two." || whole.text(domain.DeltaReasoning) != "Hmm." {
		t.Fatalf("without token deltas the messages stream whole: %+v %v %q", result, err, whole.text(domain.DeltaText))
	}
}

func TestCodex_StreamsItemsWithTheSystemPartOnStdin(t *testing.T) {
	d := &deltas{}
	h := newHarness(t, Codex, "codex-ok")
	result, err := h.run(context.Background(), d)
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "First.\n\nSecond." || d.text(domain.DeltaText) != result.Content || d.text(domain.DeltaReasoning) != "**Thinking**" {
		t.Fatalf("result %+v deltas %+v", result, d.list)
	}
	if want := (domain.Usage{InputTokens: 200, OutputTokens: 30, CacheReadTokens: 150}); result.Usage != want {
		t.Fatalf("usage %+v", result.Usage)
	}
	rep := h.readReport()
	if !strings.HasPrefix(rep.Stdin, "RULES: be brief.\n\n## Conversation so far") || !strings.HasSuffix(rep.Stdin, "SECRET-QUESTION-42\n") {
		t.Fatalf("stdin %q", rep.Stdin)
	}
	if rep.Args[0] != "exec" || rep.Args[len(rep.Args)-1] != "-" || !contains(rep.Args, "read-only") || !contains(rep.Args, "features.shell_tool=false") ||
		!contains(rep.Args, "--ephemeral") || !contains(rep.Args, `web_search="disabled"`) || rep.Args[index(rep.Args, "-C")+1] != rep.Cwd {
		t.Fatalf("args %q", rep.Args)
	}
}

func TestAgy_StreamsStepsWithTheWholePromptAsOneStdinMessage(t *testing.T) {
	d := &deltas{}
	h := newHarness(t, Agy, "agy-ok")
	result, err := h.run(context.Background(), d)
	if err != nil {
		t.Fatal(err)
	}
	if result.Content != "Bonjour" || d.text(domain.DeltaText) != "Bonjour" || result.Model != "gemini-3.8-flash-medium" {
		t.Fatalf("result %+v", result)
	}
	if want := (domain.Usage{InputTokens: 50, OutputTokens: 10, CacheReadTokens: 20}); result.Usage != want {
		t.Fatalf("usage %+v", result.Usage)
	}
	rep := h.readReport()
	var message struct {
		Event   string `json:"event"`
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(rep.Stdin), &message); err != nil || !strings.HasSuffix(rep.Stdin, "}\n") || strings.Count(rep.Stdin, "\n") != 1 {
		t.Fatalf("stdin must be one NDJSON message: %q (%v)", rep.Stdin, err)
	}
	if message.Event != "user" || !strings.HasPrefix(message.Message.Content, "RULES: be brief.\n\n## Conversation so far") ||
		!strings.HasSuffix(message.Message.Content, "SECRET-QUESTION-42\n") {
		t.Fatalf("message %+v", message)
	}
	want := []string{"--print=", "--input-format=stream-json", "--output-format=stream-json", "--mode=plan", "--sandbox", "--disable-slash-commands", "--model=test-model"}
	if !slices.Equal(rep.Args, want) {
		t.Fatalf("args %q, want %q", rep.Args, want)
	}
}

func contains(list []string, s string) bool { return index(list, s) >= 0 }

func index(list []string, s string) int {
	for i, x := range list {
		if x == s {
			return i
		}
	}
	return -1
}
