package cli

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

func TestRun_FailuresHaveClearPublicTexts(t *testing.T) {
	cases := []struct {
		backend  Backend
		mode     string
		sentinel error
		public   string
	}{
		{Claude, "claude-noauth", ErrNotLoggedIn, "the Claude Code CLI is not logged in on this server"},
		{Claude, "claude-limit", ErrUsageLimit, "the Claude Code subscription's usage limit is reached; try again later"},
		{Claude, "claude-noresult", ErrFailed, "the Claude Code CLI ended without a reply"},
		{Codex, "codex-limit", ErrUsageLimit, "the Codex subscription's usage limit is reached; try again later"},
		{Codex, "codex-noauth", ErrNotLoggedIn, "the Codex CLI is not logged in on this server"},
		{Agy, "agy-noauth", ErrNotLoggedIn, "the Antigravity CLI is not logged in on this server"},
		{Agy, "agy-quota", ErrUsageLimit, "the Antigravity subscription's usage limit is reached; try again later"},
		{Claude, "crash", ErrFailed, "the Claude Code CLI failed"},
	}
	for _, c := range cases {
		t.Run(c.mode, func(t *testing.T) {
			h := newHarness(t, c.backend, c.mode)
			_, err := h.run(context.Background(), &deltas{})
			var public *tangent.RunnerError
			if !errors.Is(err, c.sentinel) || !errors.As(err, &public) || public.Public != c.public {
				t.Fatalf("err %v, want %v with %q", err, c.sentinel, c.public)
			}
		})
	}
}

func TestRun_StderrStaysOutOfThePublicTextAndIsRedactedInTheLog(t *testing.T) {
	h := newHarness(t, Claude, "crash")
	_, err := h.run(context.Background(), &deltas{})
	var public *tangent.RunnerError
	if !errors.As(err, &public) || strings.Contains(public.Public, "panic") {
		t.Fatalf("public %q", public.Public)
	}
	logged := public.Err.Error()
	if !strings.Contains(logged, "exit status 3") || strings.Contains(logged, "sk-live-abcdefghij") || !strings.Contains(logged, "[redacted]") {
		t.Fatalf("logged detail %q", logged)
	}
}

func TestRun_UsageLimitIsNotRetried(t *testing.T) {
	for _, mode := range []string{"claude-limit", "claude-retry-limit"} {
		t.Run(mode, func(t *testing.T) {
			retried := false
			h := newHarness(t, Claude, mode)
			req := chatRequest(&deltas{})
			req.OnRetry = func(tangent.Retry) { retried = true }
			start := time.Now()
			if _, err := h.runner.Run(context.Background(), req); !errors.Is(err, ErrUsageLimit) || retried || time.Since(start) > 10*time.Second {
				t.Fatalf("err %v retried %v after %s", err, retried, time.Since(start))
			}
		})
	}
}

func TestRun_NotInstalled(t *testing.T) {
	r, err := New(Config{Backend: Codex, Path: filepath.Join(t.TempDir(), "no-such-codex")})
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.Run(context.Background(), chatRequest(&deltas{}))
	var public *tangent.RunnerError
	if !errors.Is(err, ErrNotInstalled) || !errors.As(err, &public) || public.Public != "the Codex CLI is not installed on this server" {
		t.Fatalf("err %v", err)
	}
}

func TestRun_ReplyTooLargeStopsTheRun(t *testing.T) {
	h := newHarness(t, Claude, "huge", func(c *Config) { c.MaxReplyBytes = 1000 })
	d := &deltas{}
	_, err := h.run(context.Background(), d)
	if !errors.Is(err, ErrReplyTooLarge) || len(d.text("text")) != 600 {
		t.Fatalf("err %v streamed %d", err, len(d.text("text")))
	}
}

func TestRun_ConcurrencyIsBounded(t *testing.T) {
	h := newHarness(t, Claude, "exclusive", func(c *Config) { c.MaxConcurrent = 1 })
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = h.run(context.Background(), &deltas{})
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("run %d overlapped another: %v", i, err)
		}
	}
}

func TestRun_WaitingForASlotHonoursTheContext(t *testing.T) {
	h := newHarness(t, Claude, "claude-ok", func(c *Config) { c.MaxConcurrent = 1 })
	h.runner.slots <- struct{}{} // the only slot is taken
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.run(ctx, &deltas{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v", err)
	}
}

func TestNew_ChecksTheConfiguration(t *testing.T) {
	for _, c := range []struct {
		name string
		cfg  Config
		want string
	}{
		{"unknown backend", Config{Backend: "copilot"}, "unknown backend"},
		{"option-like model", Config{Backend: Claude, Model: "--dangerously-skip-permissions"}, "not a valid model"},
		{"server token", Config{Backend: Claude, Env: []string{"TANGENT_TOKEN"}}, "TANGENT_TOKEN"},
		{"database url", Config{Backend: Claude, Env: []string{"MY_DATABASE_URL"}}, "MY_DATABASE_URL"},
		{"api key", Config{Backend: Codex, Env: []string{"OPENAI_API_KEY"}}, "OPENAI_API_KEY"},
		{"not a name", Config{Backend: Codex, Env: []string{"A=B"}}, "not an environment variable"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if _, err := New(c.cfg); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err %v, want %q", err, c.want)
			}
		})
	}
	r, err := New(Config{Backend: Agy})
	if err != nil || r.cfg.Path != "agy" || r.cfg.MaxConcurrent != DefaultMaxConcurrent || r.cfg.Timeout != DefaultTimeout || r.DefaultModel() != "" {
		t.Fatalf("defaults %+v %v", r, err)
	}
}

func TestRun_RefusesAnOptionLikeModelFromTheRequest(t *testing.T) {
	h := newHarness(t, Claude, "claude-ok")
	req := chatRequest(&deltas{})
	req.Model = "--dangerously-skip-permissions"
	var public *tangent.RunnerError
	if _, err := h.runner.Run(context.Background(), req); !errors.As(err, &public) || !strings.Contains(public.Public, "model") {
		t.Fatalf("err %v", err)
	}
}
