// Package cli runs tangent turns through a command-line AI tool that the
// server's user is logged in to with a subscription: Claude Code (claude),
// Codex (codex) or Antigravity CLI (agy). Every Run starts one
// non-interactive process with os/exec only:
//
//   - the prompt goes to the process on stdin, never on its command line
//     (Claude Code gets the system prompt from a private file);
//   - the process may only chat: each CLI's own flags turn its tools off or
//     leave them needing an approval nobody can give, and a run that still
//     reports a tool call is killed and failed;
//   - it runs in a fresh, empty working directory removed afterwards;
//   - it sees an allowlisted environment only (PATH, HOME, locale, proxy and
//     the CLI's own configuration variables), never the server's token,
//     database URL or API keys;
//   - the whole process group is killed when the context ends;
//   - a semaphore bounds how many processes run at once (default 2).
//
// The CLI's streamed JSON is parsed into text and reasoning deltas. Usage is
// what the CLI reports (subscription runs are not billed per token, so no
// cost is recorded). A usage limit of the subscription is never retried.
package cli

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// Backend names a supported CLI.
type Backend string

// Supported backends.
const (
	Claude Backend = "claude"
	Codex  Backend = "codex"
	Agy    Backend = "agy"
)

// Defaults of a Config.
const (
	DefaultMaxConcurrent = 2
	DefaultTimeout       = 10 * time.Minute
	// DefaultWaitDelay is how long Run waits for the process's output
	// pipes to close after the process group was killed.
	DefaultWaitDelay = 3 * time.Second
	// maxModelLength bounds a model name passed to the CLI.
	maxModelLength = 200
)

// Config configures a Runner.
type Config struct {
	// Backend is the CLI: Claude, Codex or Agy.
	Backend Backend
	// Path is the executable (default: the backend's name, looked up on
	// PATH when a run starts, so installing it later needs no restart).
	Path string
	// Model is used when a request names none; empty lets the CLI choose.
	Model string
	// MaxConcurrent bounds the processes running at once (default 2).
	MaxConcurrent int
	// Timeout bounds one run (default 10 minutes).
	Timeout time.Duration
	// Env names extra variables of the server's environment passed to the
	// CLI (for example CLAUDE_CODE_OAUTH_TOKEN). TANGENT_*, *DATABASE_URL*
	// and *API_KEY names are refused.
	Env []string
	// MaxReplyBytes bounds the reply text (default 1 MiB).
	MaxReplyBytes int
	// WaitDelay: see DefaultWaitDelay.
	WaitDelay time.Duration
}

// Runner is a tangent.Runner over one CLI.
type Runner struct {
	cfg     Config
	backend backend
	slots   chan struct{}
}

// New checks the configuration and returns a Runner. It does not look the
// executable up: a missing CLI fails each run with ErrNotInstalled.
func New(cfg Config) (*Runner, error) {
	b, ok := backends[cfg.Backend]
	if !ok {
		return nil, fmt.Errorf("cli: unknown backend %q (claude, codex or agy)", cfg.Backend)
	}
	cfg.Path = cmp.Or(strings.TrimSpace(cfg.Path), string(cfg.Backend))
	cfg.Model = strings.TrimSpace(cfg.Model)
	if cfg.Model != "" && !validModel(cfg.Model) {
		return nil, fmt.Errorf("cli: the model %q is not a valid model name", cfg.Model)
	}
	if err := checkExtraEnv(cfg.Env); err != nil {
		return nil, err
	}
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = DefaultMaxConcurrent
	}
	cfg.Timeout = cmp.Or(cfg.Timeout, DefaultTimeout)
	cfg.WaitDelay = cmp.Or(cfg.WaitDelay, DefaultWaitDelay)
	return &Runner{cfg: cfg, backend: b, slots: make(chan struct{}, cfg.MaxConcurrent)}, nil
}

// DefaultModel is the model used when a request names none ("" lets the
// CLI choose).
func (r *Runner) DefaultModel() string { return r.cfg.Model }

// Run starts the CLI once, streams its reply and returns it.
func (r *Runner) Run(ctx context.Context, req tangent.RunRequest) (tangent.RunResult, error) {
	model := cmp.Or(strings.TrimSpace(req.Model), r.cfg.Model)
	if model != "" && !validModel(model) {
		return tangent.RunResult{}, &tangent.RunnerError{Public: "the model name is not valid for this CLI", Err: ErrFailed}
	}
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	case <-ctx.Done():
		return tangent.RunResult{}, fmt.Errorf("cli: waiting for a free %s process: %w", r.backend.display, ctx.Err())
	}
	path, err := exec.LookPath(r.cfg.Path)
	if err != nil {
		return tangent.RunResult{}, r.fail(failure{kind: failNotInstalled, detail: err.Error()})
	}
	ctx, cancel := context.WithTimeout(ctx, r.cfg.Timeout)
	defer cancel()
	dir, err := newRunDir()
	if err != nil {
		return tangent.RunResult{}, fmt.Errorf("cli: %w", err)
	}
	defer dir.remove()
	return r.run(ctx, path, model, dir, req)
}

// run starts the process in dir and reads its stream.
func (r *Runner) run(ctx context.Context, path, model string, dir runDir, req tangent.RunRequest) (tangent.RunResult, error) {
	inv, err := r.backend.prepare(dir, model, req)
	if err != nil {
		return tangent.RunResult{}, fmt.Errorf("cli: %w", err)
	}
	p := r.backend.parser(newReply(model, req, r.cfg.MaxReplyBytes))
	proc := process{path: path, args: inv.args, stdin: inv.stdin, dir: dir.work, env: buildEnv(os.Environ(), r.backend.env, r.cfg.Env), waitDelay: r.cfg.WaitDelay}
	out, err := proc.run(ctx, r.cfg.MaxReplyBytes, p.line)
	if err != nil {
		return tangent.RunResult{}, fmt.Errorf("cli: start %s: %w", r.backend.display, err)
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return tangent.RunResult{}, fmt.Errorf("cli: %s run ended: %w", r.backend.display, ctxErr)
	}
	if out.stopped != nil {
		return tangent.RunResult{}, r.fail(*out.stopped)
	}
	result, f := p.finish()
	if out.exitCode != 0 && (f == nil || f.kind == failIncomplete) {
		f = exitFailure(out.exitCode, out.stderr)
	}
	if f != nil {
		return tangent.RunResult{}, r.fail(*f)
	}
	return result, nil
}

// modelPattern keeps option-like or otherwise odd text out of the CLI's
// arguments: a model name starts with a letter or digit.
var modelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]*$`)

func validModel(model string) bool {
	return len(model) <= maxModelLength && modelPattern.MatchString(model)
}
