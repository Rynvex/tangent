package main

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

const summaryURL = "http://127.0.0.1:8120"

// withInstalled stands in for exec.LookPath: only the named executables exist.
func withInstalled(t *testing.T, names ...string) {
	t.Helper()
	previous := lookPath
	lookPath = func(name string) (string, error) {
		for _, n := range names {
			if n == name {
				return "/usr/bin/" + name, nil
			}
		}
		return "", exec.ErrNotFound
	}
	t.Cleanup(func() { lookPath = previous })
}

func summaryOf(t *testing.T, vars env) string {
	t.Helper()
	cfg, err := loadConfig(vars.get)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(startupSummary(cfg, summaryURL), "\n")
}

func requireLines(t *testing.T, summary string, want ...string) {
	t.Helper()
	for _, line := range want {
		if !strings.Contains(summary, line) {
			t.Errorf("summary lacks %q:\n%s", line, summary)
		}
	}
}

func TestStartupSummary_DevModeWithoutKeys(t *testing.T) {
	summary := summaryOf(t, env{"TANGENT_DEV": "1"})
	requireLines(t, summary,
		"tangent-server ready",
		"address    "+summaryURL,
		"dev mode: no token, loopback only",
		"fake: 1 model",
		"claude-cli: skipped (claude binary not found)",
		"codex-cli: skipped (codex binary not found)",
		"agy-cli: skipped (agy binary not found)",
		"default    fake:fake-1",
		"job model  same as the conversation's",
		"fallback   none",
		"pnpm -C web dev` and open http://localhost:5183",
	)
}

func TestStartupSummary_DetectedCLIsAreReadyWithTheirPresets(t *testing.T) {
	withInstalled(t, "claude")
	summary := summaryOf(t, env{"TANGENT_DEV": "1"})
	requireLines(t, summary, "claude-cli: 4 models (ready)", "codex-cli: skipped (codex binary not found)")
}

func TestStartupSummary_ConfiguredButMissingCLIIsNotReady(t *testing.T) {
	summary := summaryOf(t, env{
		"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "codex-cli", "TANGENT_CODEX_CLI_MODEL": "gpt-6-luna",
	})
	requireLines(t, summary, "codex-cli: 4 models (not ready: binary not found)", "default    codex-cli:gpt-6-luna")
	if strings.Contains(summary, "fake:") {
		t.Errorf("the fake provider is off outside dev mode:\n%s", summary)
	}
}

func TestStartupSummary_ShowsAccessJobFallbackAndStaticDir(t *testing.T) {
	summary := summaryOf(t, env{
		"TANGENT_TOKEN": writerToken, "TANGENT_VIEWER_TOKEN": viewerToken,
		"TANGENT_PROVIDER": "anthropic", "TANGENT_MODEL": "claude-sonnet-4-5", "ANTHROPIC_API_KEY": "k",
		"TANGENT_JOB_MODEL": "anthropic:claude-haiku-4-5", "TANGENT_FALLBACK_MODEL": "anthropic:claude-haiku-4-5",
		"TANGENT_STATIC_DIR": ".", "TANGENT_CLI_AUTODETECT": "0",
	})
	requireLines(t, summary,
		"token required (Authorization: Bearer <token>), read-only viewer token set",
		"anthropic: 2 models",
		"claude-cli: off (set TANGENT_CLAUDE_CLI_MODEL or TANGENT_CLI_AUTODETECT=1)",
		"default    anthropic:claude-sonnet-4-5",
		"job model  anthropic:claude-haiku-4-5",
		"fallback   anthropic:claude-haiku-4-5",
		"served at "+summaryURL+"/ (TANGENT_STATIC_DIR)",
	)
}

func TestStartupSummary_NeverContainsSecrets(t *testing.T) {
	summary := summaryOf(t, env{
		"TANGENT_TOKEN": writerToken, "TANGENT_PROVIDER": "openai", "TANGENT_MODEL": "m", "OPENAI_API_KEY": "sk-secret-value",
	})
	for _, secret := range []string{writerToken, "sk-secret-value"} {
		if strings.Contains(summary, secret) {
			t.Errorf("summary leaks %q:\n%s", secret, summary)
		}
	}
}

func TestExplainStartupError_GuidesAFirstTimeUser(t *testing.T) {
	// The real refusals of loadConfig, so a reworded message breaks this test.
	cases := map[string]env{
		"no token":    {},
		"no provider": {"TANGENT_TOKEN": writerToken},
	}
	for name, vars := range cases {
		_, err := loadConfig(vars.get)
		if err == nil {
			t.Fatalf("%s: expected a refusal", name)
		}
		text := explainStartupError(err)
		for _, want := range []string{err.Error(), "TANGENT_DEV=1 make serve", "TANGENT_CLAUDE_CLI_MODEL", "OPENAI_API_KEY", ".env.example"} {
			if !strings.Contains(text, want) {
				t.Errorf("%s: guide lacks %q:\n%s", name, want, text)
			}
		}
	}
}

func TestExplainStartupError_PointsAtMakeDbUpWhenTheDatabaseIsDown(t *testing.T) {
	text := explainStartupError(errors.New("cannot reach the database (TANGENT_DATABASE_URL, postgres://u:***@h/db): refused"))
	if !strings.Contains(text, "make db-up") {
		t.Fatalf("no database hint: %s", text)
	}
}

func TestExplainStartupError_LeavesOtherErrorsAlone(t *testing.T) {
	err := errors.New("TANGENT_RATE_LIMIT must be a positive whole number, got \"x\"")
	if got := explainStartupError(err); got != err.Error() {
		t.Fatalf("got %q", got)
	}
}
