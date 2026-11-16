package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Bounds of the process's output.
const (
	// A stream line may hold the whole reply (JSON escaping can grow it,
	// hence four times the reply bound) plus lineSlack of metadata.
	lineSlack = 256 << 10
	// stderrTail is how much of stderr is kept to classify a failure.
	stderrTail = 8 << 10
)

// runDir is a run's private directory: work is the empty working directory
// of the process; files the CLI reads (a system prompt, a policy) go next
// to it, never inside it.
type runDir struct {
	root string
	work string
}

func newRunDir() (runDir, error) {
	root, err := os.MkdirTemp("", "tangent-cli-*")
	if err != nil {
		return runDir{}, fmt.Errorf("create the run directory: %w", err)
	}
	work := filepath.Join(root, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		_ = os.RemoveAll(root)
		return runDir{}, fmt.Errorf("create the working directory: %w", err)
	}
	return runDir{root: root, work: work}, nil
}

// file writes a private file next to the working directory.
func (d runDir) file(name, content string) (string, error) {
	path := filepath.Join(d.root, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return "", fmt.Errorf("write %s: %w", name, err)
	}
	return path, nil
}

func (d runDir) remove() { _ = os.RemoveAll(d.root) }

// process is one CLI invocation.
type process struct {
	path      string
	args      []string
	stdin     string
	dir       string
	env       []string
	waitDelay time.Duration
}

// outcome is how a process ended.
type outcome struct {
	exitCode int
	stderr   string
	// stopped is set when the parser stopped the run (a tool call, a reply
	// too large, an unreadable stream).
	stopped *failure
}

// run starts the process, hands every stdout line to onLine and waits. The
// process runs in its own process group; the group is killed when ctx ends,
// when onLine stops the run, and once more after the process exited (so no
// child it left behind keeps running).
func (p process) run(ctx context.Context, maxReply int, onLine func([]byte) error) (outcome, error) {
	cmd := exec.CommandContext(ctx, p.path, p.args...)
	cmd.Dir, cmd.Env, cmd.Stdin = p.dir, p.env, strings.NewReader(p.stdin)
	cmd.SysProcAttr = sysProcAttr()
	cmd.Cancel = func() error { killGroup(cmd.Process); return nil }
	cmd.WaitDelay = p.waitDelay
	stderr := &tailBuffer{limit: stderrTail}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return outcome{}, err
	}
	if err := cmd.Start(); err != nil {
		return outcome{}, err
	}
	stopped := readLines(stdout, maxReply, onLine)
	if stopped != nil {
		killGroup(cmd.Process)
	}
	waitErr := cmd.Wait()
	killGroup(cmd.Process)
	out := outcome{stderr: stderr.String(), stopped: stopped}
	var exitErr *exec.ExitError
	switch {
	case errors.As(waitErr, &exitErr):
		out.exitCode = exitErr.ExitCode()
		if out.exitCode < 0 {
			out.exitCode = -1 // killed by a signal
		}
	case waitErr != nil && !errors.Is(waitErr, exec.ErrWaitDelay):
		out.exitCode = -1
	}
	return out, nil
}

// readLines feeds stdout to onLine line by line until EOF or a stop.
func readLines(stdout io.Reader, maxReply int, onLine func([]byte) error) *failure {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64<<10), replyLimit(maxReply)*4+lineSlack)
	for scanner.Scan() {
		if err := onLine(scanner.Bytes()); err != nil {
			f := stopFailure(err)
			return &f
		}
	}
	if err := scanner.Err(); err != nil {
		return &failure{kind: failOutput, detail: err.Error()}
	}
	return nil
}

// stopFailure is the failure of a parser's stop error.
func stopFailure(err error) failure {
	var f *failure
	if errors.As(err, &f) {
		return *f
	}
	return failure{kind: failOutput, detail: err.Error()}
}

// tailBuffer keeps the last limit bytes written to it.
type tailBuffer struct {
	limit int
	b     []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.b = append(t.b, p...)
	if extra := len(t.b) - t.limit; extra > 0 {
		t.b = append([]byte(nil), t.b[extra:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string { return string(t.b) }
