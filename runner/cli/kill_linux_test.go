//go:build linux

package cli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// alive reports whether pid still runs (a zombie counts as gone).
func alive(pid int) bool {
	if pid <= 0 || syscall.Kill(pid, 0) != nil {
		return false
	}
	stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return false
	}
	fields := strings.Fields(string(stat))
	return len(fields) < 3 || fields[2] != "Z"
}

// waitGone waits until none of pids runs.
func waitGone(t *testing.T, pids ...int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for _, pid := range pids {
		for alive(pid) {
			if time.Now().After(deadline) {
				t.Fatalf("process %d still runs", pid)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// waitReport waits until the fake CLI wrote its report with its child.
func (h *harness) waitReport() fakeReport {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(h.report); err == nil {
			if rep := h.readReport(); rep.ChildPid != 0 {
				return rep
			}
		}
		if time.Now().After(deadline) {
			h.t.Fatal("the fake CLI never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRun_CancelKillsTheWholeProcessGroup(t *testing.T) {
	h := newHarness(t, Claude, "hang")
	ctx, cancel := context.WithCancel(context.Background())
	type ran struct {
		err  error
		took time.Duration
	}
	done := make(chan ran, 1)
	go func() {
		start := time.Now()
		_, err := h.run(ctx, &deltas{})
		done <- ran{err, time.Since(start)}
	}()
	rep := h.waitReport()
	if !alive(rep.Pid) || !alive(rep.ChildPid) {
		t.Fatalf("the fake CLI (%d) and its child (%d) should run", rep.Pid, rep.ChildPid)
	}
	cancel()
	got := <-done
	if !errors.Is(got.err, context.Canceled) || got.took > 5*time.Second {
		t.Fatalf("err %v after %s", got.err, got.took)
	}
	waitGone(t, rep.Pid, rep.ChildPid)
	if _, err := os.Stat(rep.Cwd); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the working directory survived: %v", err)
	}
}

func TestRun_TimeoutKillsTheProcess(t *testing.T) {
	h := newHarness(t, Claude, "hang", func(c *Config) { c.Timeout = 700 * time.Millisecond })
	start := time.Now()
	_, err := h.run(context.Background(), &deltas{})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 6*time.Second {
		t.Fatalf("err %v after %s", err, time.Since(start))
	}
	var public *tangent.RunnerError
	if errors.As(err, &public) {
		t.Fatalf("a timeout is left to the engine's fixed text, got %q", public.Public)
	}
	rep := h.readReport()
	waitGone(t, rep.Pid, rep.ChildPid)
}

func TestRun_ToolUseKillsTheProcess(t *testing.T) {
	for _, c := range []struct {
		backend Backend
		mode    string
	}{{Claude, "claude-tools"}, {Codex, "codex-tool"}, {Agy, "agy-tool"}} {
		t.Run(c.mode, func(t *testing.T) {
			h := newHarness(t, c.backend, c.mode)
			start := time.Now()
			_, err := h.run(context.Background(), &deltas{})
			if !errors.Is(err, ErrToolUse) || time.Since(start) > 10*time.Second {
				t.Fatalf("err %v after %s", err, time.Since(start))
			}
			var public *tangent.RunnerError
			if !errors.As(err, &public) || !strings.Contains(public.Public, "tool") {
				t.Fatalf("public text of %v", err)
			}
			waitGone(t, h.readReport().Pid)
		})
	}
}
